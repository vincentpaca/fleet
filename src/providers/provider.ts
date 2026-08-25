// Provider contract: how the daemon launches and terminates job sandboxes.

/** Resource requirements from manifest limits.resources. */
export type ResourceRequest = {
  /** CPU in ECS units (256 = 0.25 vCPU, 1024 = 1 vCPU). */
  cpu?: number;
  /** Memory limit in MiB. */
  memory?: number;
  /** Ephemeral disk in GiB (advisory; not all providers enforce it). */
  disk?: number;
};

export type LaunchSpec = {
  jobId: string;
  /** How the runner reaches the daemon: http://127.0.0.1:port, or unix:<path>. */
  daemonUrl: string;
  runnerToken: string;
  image?: string;
  /** Extra environment for the sandbox (operator-supplied values). */
  env: Record<string, string>;
  /** Files to materialise in the workspace: relPath -> base64 content. */
  sync: Record<string, string>;
  manifest: unknown;
  workOrder: unknown;
  /** Resource requirements from manifest limits.resources; absent = use task-def defaults. */
  resources?: ResourceRequest;
  /**
   * Re-entry answer (issue #6): present only when re-launching a parked job.
   * The runner writes the answer to .fleet/out/answer-<decisionId>.json after
   * wiping the out/ channel so the status-driven harness finds it immediately.
   */
  reentryAnswer?: { decisionId: string; answer: { option?: string; text?: string } };
  /**
   * Re-entry decision seed (issue #110): the highest decision ordinal already
   * used in the job's event log, passed so the fresh runner numbers from there
   * and decision ids stay unique across park/resume generations.
   */
  reentryDecisionSeed?: number;
};

export interface Provider {
  readonly name: string;
  launch(spec: LaunchSpec): Promise<{ handle: string }>;
  /**
   * Stop the sandbox named by `handle`.
   *
   * Termination is idempotent (#122): a sandbox that is already gone resolves
   * successfully instead of throwing. Cancel and the crash backstops are
   * Fleet's structural spend control — their correctness must not depend on
   * the substrate — so "not found" from docker or ECS counts as success
   * (`isMissingResourceError`). Transient substrate failures may be retried
   * once, bounded, before surfacing.
   */
  terminate(handle: string): Promise<void>;
  /**
   * Optional: rebuild the terminate-able handle for a job from its id alone
   * (#115). A daemon crash between `launch` resolving and the handle being
   * persisted leaves a live sandbox the record cannot name — and Provider has
   * no list op, so without this the container is unkillable. Providers that
   * name sandboxes deterministically (docker: fleet-<jobId>) implement it;
   * providers whose handles are substrate-assigned (ECS task ARNs) omit it.
   * Purely a name derivation: it must not claim the sandbox exists.
   */
  deriveHandle?(jobId: string): string;
  /**
   * Optional: validate that the requested resources fit within the offered capacity.
   * Throws with the exact requested vs available numbers when the request cannot be served.
   * Called at dispatch time before launch() so failures surface immediately.
   */
  checkResources?(resources: ResourceRequest): void;
  /**
   * Optional: validate that launch() can honor a per-job image override
   * (LaunchSpec.image carrying the CLI-built two-layer job image, #49).
   * Throws with what to do instead when it cannot — a substrate that pins its
   * image (the ECS runner task definition) must refuse at dispatch, before a
   * job record exists, rather than silently run the job on the wrong image.
   * Absent means the override is honored (docker uses it directly; process
   * runs on the host, where no image applies by construction).
   */
  checkImageOverride?(image: string): void;
  /**
   * Optional: settle whatever a previous daemon's death left behind (#123).
   * Called once by the daemon entrypoint after it starts serving. The process
   * provider re-runs workspace disposition for runners whose exit handler
   * died with the old daemon; container providers have no equivalent — the
   * substrate outlives the daemon and owns the sandbox lifecycle.
   */
  recover?(): void | Promise<void>;
}

/**
 * Operator access to the daemon without public ingress (`docs/decisions.md#d12`).
 * Every cloud unit owes the operator a way in and satisfies it its own way; core
 * only knows how to hold one open and how to notice it died.
 */
export type TunnelEndpoint = {
  /** argv (program + args) of a command that holds the forward open in the foreground. */
  argv: string[];
  /**
   * What the forward currently points at, in whatever form the cloud addresses
   * it. It changes whenever the deployment replaces the daemon's container —
   * which is exactly when a dead session must not be reopened at the old
   * address. Core compares this string; it never parses it.
   */
  id: string;
};

/**
 * Resolve the deployment's daemon endpoint *now* and build the command that
 * forwards it to localPort. Called once per session, never cached: re-resolving
 * is what survives a service deployment.
 */
export type TunnelOpener = (localPort: number) => Promise<TunnelEndpoint>;

/**
 * Shells out to a cloud's own CLI and returns stdout. Every provider that talks
 * to its cloud by shelling out takes one of these, so tests can drive the real
 * command construction without the cloud. Callers doing real work pass the
 * call's kill budget as `timeoutMs`; the default runner kills the child process
 * at it, so a wedged CLI can neither hang the caller nor keep the event loop
 * alive long after the caller has given up.
 */
export type CloudCliRunner = (args: string[], timeoutMs?: number) => Promise<string>;

/**
 * Whether a terminate() failure means the sandbox was already gone (#122).
 * Termination is idempotent by contract, so providers treat these as success:
 * `docker rm -f` names the container on stderr; the ECS API raises
 * TaskNotFoundException or reports the task already stopped. Matches both the
 * error message and any captured stderr, because execFile reports the child's
 * output separately from its message.
 */
export function isMissingResourceError(error: unknown): boolean {
  const err = error as { message?: unknown; stderr?: unknown };
  const text = `${String(err?.message ?? "")} ${typeof err?.stderr === "string" ? err.stderr : ""}`;
  return /No such container|TaskNotFoundException|already stopped/i.test(text);
}

/** FLEET_* env every provider injects into the sandbox. */
export function runnerEnv(spec: LaunchSpec, workspace: string): Record<string, string> {
  return {
    ...spec.env,
    FLEET_JOB_ID: spec.jobId,
    FLEET_DAEMON_URL: spec.daemonUrl,
    FLEET_RUNNER_TOKEN: spec.runnerToken,
    FLEET_WORKSPACE: workspace,
    // Re-entry answer: runner writes this to out/answer-<id>.json after wiping out/.
    ...(spec.reentryAnswer !== undefined
      ? { FLEET_REENTRY_ANSWER_JSON: Buffer.from(JSON.stringify(spec.reentryAnswer)).toString('base64') }
      : {}),
    // Re-entry decision seed: keep ids unique across generations (issue #110).
    ...(spec.reentryDecisionSeed !== undefined
      ? { FLEET_REENTRY_DECISION_SEED: String(spec.reentryDecisionSeed) }
      : {}),
  };
}

/**
 * Workspace materialisation payload (#5): manifest, work order, and sync
 * files travel as base64 env vars; the runner writes them into
 * FLEET_WORKSPACE before any file reads. One builder for every container
 * provider — the Docker/ECS paths once assembled this by hand and diverged:
 * the ECS copy omitted the work order, and #9's first real cloud job died
 * at the pickup gate with no target.
 */
export function materializationEnv(spec: LaunchSpec): Record<string, string> {
  const env: Record<string, string> = {
    FLEET_MANIFEST_JSON: Buffer.from(JSON.stringify(spec.manifest)).toString('base64'),
    FLEET_WORK_ORDER_JSON: Buffer.from(JSON.stringify(spec.workOrder)).toString('base64'),
  };
  if (Object.keys(spec.sync).length > 0) {
    env.FLEET_SYNC_JSON = Buffer.from(JSON.stringify(spec.sync)).toString('base64');
  }
  return env;
}
