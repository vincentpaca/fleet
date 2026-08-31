// GcpProvider: `gcloud run jobs execute` shell-out (#185).
//
// Jobs are Cloud Run Job executions; the deployed google_cloud_run_v2_job
// (infra/gcp/main.tf) is the task-definition analog and pins the runner image
// and the resource tier. Configuration arrives as FLEET_GCP_* env — the GCP
// unit renders a daemon.env file into the VM's cloud-init, so there is no
// SSM-fetch analog. The unit-tested surface is command construction and
// response parsing; everything else shells out to `gcloud`.
//
// Per-execution env (runner token, manifest env) rides `--update-env-vars` on
// argv — visible in the single-tenant daemon VM's process list and readable in
// the execution resource by anyone holding run.viewer. The same exposure class
// as ECS DescribeTasks today; accepted and recorded in docs/decisions.md#d18,
// with a Secret-Manager-per-job upgrade as the named follow-up.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDurationMs } from "../shared/time.ts";
import type { CloudCliRunner, JobSandbox, LaunchSpec, Provider, ResourceRequest, TunnelEndpoint, TunnelOpener } from "./provider.ts";
import { isMissingResourceError, runnerEnv, materializationEnv, writeSecretTempFile } from "./provider.ts";

const run = promisify(execFile);

const CONTAINER_WORKSPACE = "/workspace";

/**
 * The `--update-env-vars` list separator. Operator env values may contain
 * commas (gcloud's default separator), so every launch names its own via the
 * `^|^` prefix. A key or value containing the delimiter itself has no escape
 * in gcloud's syntax — buildExecuteArgs rejects it with a readable error
 * rather than launching a job with silently corrupted env.
 */
const ENV_DELIMITER = "|";

/**
 * Headroom the substrate timeout gets over the manifest's wall clock. The
 * daemon owns wall-clock enforcement (graceful cancel: SIGTERM, WIP push,
 * settle); Cloud Run's --task-timeout gives ~10s of grace before SIGKILL, so
 * set at exactly wall_clock it would race the daemon's graceful path and win.
 * The margin keeps it what it is on ECS: the crash backstop, never the
 * enforcer.
 */
export const GCP_TASK_TIMEOUT_MARGIN_S = 600; // contract pin: test-only export, asserted by the suite

/** Cloud Run Jobs' documented task-timeout ceiling: 168h. */
export const GCP_TASK_TIMEOUT_MAX_S = 604_800; // contract pin: test-only export, asserted by the suite

/**
 * How long one `gcloud` read may take before its process is killed. Larger
 * than the aws twin: every gcloud invocation is a Python interpreter start
 * before the first API call.
 */
export const GCLOUD_CLI_TIMEOUT_MS = 30_000; // contract pin: test-only export, asserted by the suite

/**
 * Dispatch and cancel budgets, same reasoning as the ECS pair (#122):
 * `execute` provisions capacity so it earns more, but finite — a wedged
 * gcloud settles the daemon's launch or cancel path into its error handling
 * instead of hanging it forever.
 */
export const GCLOUD_EXECUTE_TIMEOUT_MS = 120_000; // contract pin: test-only export, asserted by the suite
export const GCLOUD_CANCEL_TIMEOUT_MS = 30_000; // contract pin: test-only export, asserted by the suite

/**
 * Shell out to `gcloud` and return stdout, killing the child at `timeoutMs`.
 * Injectable so callers are testable without GCP.
 */
export const gcloudCli: CloudCliRunner = async (args, timeoutMs = GCLOUD_CLI_TIMEOUT_MS) =>
  (await run("gcloud", args, { timeout: timeoutMs })).stdout;

type GcpConfig = {
  project: string;
  region: string;
  /** Name of the deployed Cloud Run Job (the task-definition analog). */
  job: string;
  /**
   * The deployed job's resource tier, in the manifest schema's own units
   * (ECS-flavored: cpu 1024 = 1 vCPU, memory in MiB). Cloud Run pins
   * resources on the job resource — `execute` cannot override them — so a
   * request above the tier is refused at dispatch. Absent means no check.
   */
  capacity?: { cpu: number; memory: number };
};

/**
 * Read FLEET_GCP_* config, rendered into the daemon VM's env file by the GCP
 * unit (infra/gcp/main.tf). Required: FLEET_GCP_PROJECT, FLEET_GCP_REGION,
 * FLEET_GCP_JOB. Optional: FLEET_GCP_CPU_UNITS / FLEET_GCP_MEMORY_MIB (the
 * deployed tier, ECS units — absent means no dispatch-time resource check).
 */
export function gcpConfigFromEnv(env: Record<string, string | undefined> = process.env): GcpConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env: ${name}`);
    return value;
  };
  const cpu = Number(env.FLEET_GCP_CPU_UNITS);
  const memory = Number(env.FLEET_GCP_MEMORY_MIB);
  return {
    project: required("FLEET_GCP_PROJECT"),
    region: required("FLEET_GCP_REGION"),
    job: required("FLEET_GCP_JOB"),
    ...(Number.isFinite(cpu) && cpu > 0 && Number.isFinite(memory) && memory > 0
      ? { capacity: { cpu, memory } }
      : {}),
  };
}

/** `--project`/`--region` routing pair every argv in this file carries (#138's lesson, GCP edition). */
function withScope(args: string[], config: { project: string; region: string }): string[] {
  return [...args, "--project", config.project, "--region", config.region];
}

/**
 * The execution name out of `gcloud run jobs execute --async --format=json`
 * — the run-task-ARN analog, and the handle terminate() accepts. gcloud
 * prints the execution resource in Knative shape (`metadata.name`); a v2-form
 * full resource name is reduced to its last segment, which is what the cancel
 * command takes either way. Pure function — testable without GCP.
 */
export function parseExecutionName(stdout: string): string { // contract pin: test-only export, asserted by the suite
  const parsed = JSON.parse(stdout) as { metadata?: { name?: unknown }; name?: unknown };
  const raw = typeof parsed?.metadata?.name === "string" ? parsed.metadata.name : parsed?.name;
  if (typeof raw !== "string" || raw === "") {
    throw new Error(`gcloud run jobs execute returned no execution name: ${stdout.slice(0, 500)}`);
  }
  return raw.slice(raw.lastIndexOf("/") + 1);
}

/**
 * The fleet-launched executions in a `gcloud run jobs executions list
 * --format=json` response, keyed by the FLEET_JOB_ID env the launch stamped
 * into the execution's container template (#147's evidence, GCP edition).
 * Executions carrying no FLEET_JOB_ID are not fleet's to touch and are
 * dropped here; completed executions (status.completionTime set) are not live
 * sandboxes and are dropped too — the sweep's contract is what is running and
 * billing. Pure function — testable without GCP.
 */
type ListedExecution = {
  metadata?: { name?: unknown };
  spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name?: unknown; value?: unknown }> }> } } };
  status?: { completionTime?: unknown };
};

/** The FLEET_JOB_ID value stamped into an execution's container env, or undefined. */
function executionJobId(execution: ListedExecution): string | undefined {
  const env = execution?.spec?.template?.spec?.containers?.flatMap((c) => c.env ?? []) ?? [];
  const jobId = env.find((entry) => entry?.name === "FLEET_JOB_ID")?.value;
  return typeof jobId === "string" && jobId !== "" ? jobId : undefined;
}

export function parseFleetExecutions(listJson: string): JobSandbox[] { // contract pin: test-only export, asserted by the suite
  const parsed = JSON.parse(listJson) as ListedExecution[];
  if (!Array.isArray(parsed)) return [];
  const found: JobSandbox[] = [];
  for (const execution of parsed) {
    const name = execution?.metadata?.name;
    if (typeof name !== "string" || name === "") continue;
    if (execution?.status?.completionTime) continue; // finished: not a live sandbox
    const jobId = executionJobId(execution);
    if (jobId === undefined) continue;
    found.push({ jobId, handle: name });
  }
  return found;
}

// ---------- operator access: IAP tunnel to the daemon VM ----------
// The GCP unit's answer to D12's "give the operator access without public
// ingress" — the SSM port-forward twin. Pure command construction.

/** What `fleet connect` needs to address this deployment's daemon VM. */
type GcpDaemonAccess = {
  project: string;
  /** Daemon VM name. Stable across `fleet upgrade` — the reserved internal address is what survives. */
  instance: string;
  zone: string;
  /** Port the daemon binds on the VM; the far end of the forward. */
  port: number;
};

/** Build a GcpDaemonAccess from a parsed fleet_config, naming any missing field. */
export function gcpDaemonAccessFromFleetConfig(config: Record<string, unknown>): GcpDaemonAccess {
  const required = (key: string): string => {
    const val = config[key];
    if (typeof val !== "string" || val === "") throw new Error(`fleet_config missing required field: ${key}`);
    return val;
  };
  const port = config.daemon_port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    throw new Error("fleet_config missing required field: daemon_port");
  }
  return {
    project: required("project"),
    instance: required("daemon_instance"),
    zone: required("daemon_zone"),
    port,
  };
}

/** argv after `gcloud` for the IAP forward that holds the tunnel open. */
export function buildIapTunnelArgs(access: GcpDaemonAccess, localPort: number): string[] { // contract pin: test-only export, asserted by the suite
  return [
    "compute",
    "start-iap-tunnel",
    access.instance,
    String(access.port),
    `--local-host-port=localhost:${localPort}`,
    "--zone",
    access.zone,
    "--project",
    access.project,
  ];
}

/**
 * Tunnel opener for a GCP deployment. No resolution calls: unlike an ECS task
 * id, the VM's name survives `fleet upgrade` (the replacement instance keeps
 * it), so the endpoint is addressable from the capture alone. IAP opens one
 * WebSocket per TCP connection; the daemon bounds long-polls at 25s, so no
 * tunneled connection idles long enough to be reaped.
 */
export function gcpTunnelOpener(access: GcpDaemonAccess): TunnelOpener {
  return async (localPort: number): Promise<TunnelEndpoint> => ({
    argv: ["gcloud", ...buildIapTunnelArgs(access, localPort)],
    id: `${access.project}/${access.zone}/${access.instance}`,
  });
}

// ---------- operator token: Secret Manager, the SSM-parameter twin (#188) ----------

/** argv after `gcloud` for reading the operator token the daemon published. */
export function buildSecretAccessArgs(project: string, secret: string): string[] { // contract pin: test-only export, asserted by the suite
  return ["secrets", "versions", "access", "latest", "--secret", secret, "--project", project];
}

/**
 * Publish the operator token as a new version of the unit-created secret
 * (#188, GCP edition): a fresh deployment mints its token on the data disk,
 * and without this the operator's only way to it is an IAP SSH session by
 * hand. The token rides a 0600 file into --data-file, never argv (#126).
 * Returns the secret id so the boot log can say where it went.
 */
export async function publishOperatorTokenToSecretManager(project: string, secret: string, token: string): Promise<string> {
  const input = writeSecretTempFile("fleet-gcp-token-", token);
  try {
    await run(
      "gcloud",
      ["secrets", "versions", "add", secret, "--project", project, `--data-file=${input.path}`, "--format=json"],
      { timeout: GCLOUD_CLI_TIMEOUT_MS },
    );
  } finally {
    input.cleanup();
  }
  return secret;
}

// ---------- the provider ----------

/** GcpProvider construction options. */
type GcpProviderOptions = {
  /** Shell-out to `gcloud`; defaults to the budget-killing gcloudCli. Injectable for tests. */
  gcloud?: CloudCliRunner;
};

export class GcpProvider implements Provider {
  readonly name = "gcp";
  readonly config: GcpConfig;
  readonly #gcloud: CloudCliRunner;

  constructor(config: GcpConfig, options: GcpProviderOptions = {}) {
    this.config = config;
    this.#gcloud = options.gcloud ?? gcloudCli;
  }

  /**
   * argv after `gcloud` for one launch. The whole per-job env — FLEET_* and
   * the operator's manifest env — rides `--update-env-vars` with a `^|^`
   * delimiter override (operator values may contain commas, gcloud's
   * default). A key or value containing the delimiter itself is rejected
   * here, by name, before anything is spent. Pure function — unit-tested
   * without GCP.
   */
  buildExecuteArgs(spec: LaunchSpec): string[] {
    const env: Record<string, string> = {
      ...runnerEnv(spec, CONTAINER_WORKSPACE),
      ...materializationEnv(spec),
    };
    const pairs = Object.entries(env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => {
        if (name.includes(ENV_DELIMITER) || name.includes("=")) {
          throw new Error(`env name ${JSON.stringify(name)} cannot ride --update-env-vars: names may not contain "${ENV_DELIMITER}" or "="`);
        }
        if (value.includes(ENV_DELIMITER)) {
          throw new Error(
            `env value for ${name} contains the --update-env-vars delimiter "${ENV_DELIMITER}" — gcloud has no escape for it, ` +
              "so the job would launch with silently corrupted env; remove the character or deliver the value another way",
          );
        }
        return `${name}=${value}`;
      });
    return withScope(
      [
        "run",
        "jobs",
        "execute",
        this.config.job,
        "--update-env-vars",
        `^${ENV_DELIMITER}^${pairs.join(ENV_DELIMITER)}`,
        ...this.#taskTimeoutArgs(spec),
        "--async",
        "--format=json",
      ],
      this.config,
    );
  }

  /**
   * `--task-timeout` from the manifest's wall clock, plus margin: the daemon's
   * graceful cancel (WIP push, settle) owns wall-clock enforcement, and Cloud
   * Run gives only ~10s between SIGTERM and SIGKILL — a substrate timeout at
   * exactly wall_clock would beat the daemon to the kill and eat the push.
   * Absent wall clock passes no flag; the job resource's own default timeout
   * (infra/gcp variables.tf, job_timeout_seconds) is the backstop then.
   */
  #taskTimeoutArgs(spec: LaunchSpec): string[] {
    const limits = (spec.manifest as { limits?: { wall_clock?: unknown } })?.limits;
    const wallClock = typeof limits?.wall_clock === "string" ? parseDurationMs(limits.wall_clock) : undefined;
    if (wallClock === undefined) return [];
    const seconds = Math.min(Math.ceil(wallClock / 1000) + GCP_TASK_TIMEOUT_MARGIN_S, GCP_TASK_TIMEOUT_MAX_S);
    return ["--task-timeout", `${seconds}s`];
  }

  /** argv after `gcloud` for cancelling one execution — pure function, unit-tested without GCP. */
  buildCancelArgs(handle: string): string[] {
    // --quiet: cancel prompts for confirmation on a TTY-less stdin it would
    // otherwise wait on forever — exactly the wedge the kill budget exists for.
    return withScope(["run", "jobs", "executions", "cancel", handle, "--quiet", "--format=json"], this.config);
  }

  /** argv after `gcloud` for the reconcile sweep's execution listing (#147) — pure function. */
  buildListExecutionsArgs(): string[] {
    // No --limit: gcloud's list surface follows page tokens itself and returns
    // the complete set — an orphan past page one is the one nobody is watching.
    return withScope(["run", "jobs", "executions", "list", "--job", this.config.job, "--format=json"], this.config);
  }

  /**
   * Validate a resource request against the deployed job's tier. The manifest
   * schema's units are ECS-flavored (cpu 1024 = 1 vCPU); Cloud Run thinks in
   * vCPU, so the refusal translates. The tier is pinned on the job resource —
   * `execute` cannot override cpu/memory per execution — so an oversized
   * request can never be served and is refused at dispatch.
   */
  checkResources(resources: ResourceRequest): void {
    const offered = this.config.capacity;
    if (offered === undefined) return; // no tier published — no check
    const { cpu, memory } = resources;
    if (cpu == null && memory == null) return;
    if ((!cpu || cpu <= offered.cpu) && (!memory || memory <= offered.memory)) return;
    const requested = [cpu != null ? `cpu=${cpu} (${cpu / 1024} vCPU)` : null, memory != null ? `memory=${memory} MiB` : null]
      .filter((s) => s !== null)
      .join(", ");
    throw new Error(
      `resource request exceeds the deployed Cloud Run job's tier: requested ${requested} but the job offers ` +
        `cpu=${offered.cpu} (${offered.cpu / 1024} vCPU), memory=${offered.memory} MiB — ` +
        "Cloud Run pins resources on the job, so raise the unit's job_cpu/job_memory_gib and re-apply, or shrink the manifest's limits.resources",
    );
  }

  /**
   * Two-layer job images (#49): this provider cannot honor a per-job image
   * override — the Cloud Run job resource pins the deployment's :runner tag
   * and `execute` cannot override the image. Same honest refusal as ECS,
   * before a job record exists.
   */
  checkImageOverride(image: string): void {
    throw new Error(
      `the gcp provider cannot run the computed job image ${image}: ` +
        "the Cloud Run job pins its own image and execute cannot override it. " +
        "Remove harness.cli_version from the manifest (one-layer mode: the runner executes " +
        "setup.script in the workspace before the pickup gate), or dispatch to a docker deployment.",
    );
  }

  /**
   * Run one `gcloud` call under its phase budget (#122): the deadline races
   * the CLI so the daemon's launch/cancel path settles either way, and the
   * same value is passed down so the real child is killed rather than left
   * holding the event loop.
   */
  async #cli(args: string[], budgetMs: number): Promise<string> {
    const { promise, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => reject(new Error(`gcloud ${args[0]} ${args[1]} exceeded its ${budgetMs}ms budget`)),
      budgetMs,
    );
    try {
      return await Promise.race([this.#gcloud(args, budgetMs), promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    const stdout = await this.#cli(this.buildExecuteArgs(spec), GCLOUD_EXECUTE_TIMEOUT_MS);
    return { handle: parseExecutionName(stdout) };
  }

  async terminate(handle: string): Promise<void> {
    // One bounded retry (#122), not-found is success — same contract as ECS:
    // termination is Fleet's structural spend control and must be idempotent.
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.#cli(this.buildCancelArgs(handle), GCLOUD_CANCEL_TIMEOUT_MS);
        return;
      } catch (error) {
        if (isMissingResourceError(error)) return;
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Every live execution of the deployed job attributable to a fleet job,
   * keyed by the FLEET_JOB_ID its launch stamped into the execution env
   * (#147). The reconcile sweep's evidence — a launch that succeeded on the
   * GCP side while the CLI wedged past its budget leaves a running, billing
   * execution with no stored handle.
   */
  async listJobSandboxes(): Promise<JobSandbox[]> {
    return parseFleetExecutions(await this.#cli(this.buildListExecutionsArgs(), GCLOUD_CLI_TIMEOUT_MS));
  }
}
