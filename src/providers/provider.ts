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
};

export interface Provider {
  readonly name: string;
  launch(spec: LaunchSpec): Promise<{ handle: string }>;
  terminate(handle: string): Promise<void>;
  /**
   * Optional: validate that the requested resources fit within the offered capacity.
   * Throws with the exact requested vs available numbers when the request cannot be served.
   * Called at dispatch time before launch() so failures surface immediately.
   */
  checkResources?(resources: ResourceRequest): void;
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
  };
}
