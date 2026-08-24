// EcsProvider: `aws ecs run-task` shell-out.
// Configuration sources (highest priority first):
//   1. ecsConfigFromEnv()   — FLEET_ECS_* env vars (tests / manual override)
//   2. ecsConfigFromSsm()   — SSM parameter written by the infra unit (production)
// Phase 1: methods implemented, integration untested — command construction
// is the unit-tested surface.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CloudCliRunner, LaunchSpec, Provider, ResourceRequest, TunnelEndpoint, TunnelOpener } from "./provider.ts";
import { isMissingResourceError, runnerEnv, materializationEnv } from "./provider.ts";

const run = promisify(execFile);

/** One capacity tier offered by the infra: max cpu/memory a task may request. */
export type CapacityTier = {
  /** Max CPU in ECS units (256 = 0.25 vCPU, 1024 = 1 vCPU). */
  cpu: number;
  /** Max memory in MiB. */
  memory: number;
};

export type EcsConfig = {
  cluster: string;
  taskDefinition: string;
  /** Container name in the task definition receiving the env overrides. */
  containerName: string;
  subnets: string[];
  securityGroups: string[];
  /**
   * ECS capacity provider to use for run-task (preferred over launchType when set).
   * When set, buildRunTaskArgs emits --capacity-provider-strategy so managed scaling
   * fires. When absent, falls back to --launch-type launchType (EC2 default).
   */
  capacityProvider?: string;
  /** Fallback launch type when capacityProvider is not set. Default "EC2". */
  launchType: string;
  assignPublicIp: string;
  /**
   * Capacity tiers offered by the infra (from fleet_config.capacity_tiers).
   * Used to reject oversized resource requests at dispatch time.
   * Empty means no check is performed.
   */
  capacityTiers: CapacityTier[];
};

/**
 * The shape written to the SSM fleet-config parameter by the infra unit.
 * All fields mirror the Terraform fleet_config output.  Required fields are the
 * minimum the provider needs for ecs run-task; optional fields are included for
 * completeness and to avoid silent loss on round-trip.
 */
export type FleetConfig = {
  provider: string;
  cluster: string;
  /**
   * ECS capacity provider name — preferred over launch_type when present.
   * Run-task uses --capacity-provider-strategy so managed ASG scaling fires.
   */
  capacity_provider?: string;
  runner_task_definition: string;
  runner_container_name: string;
  runner_log_group?: string;
  /** ECS service running the daemon — what `fleet connect` resolves a task from. */
  daemon_service?: string;
  /** Container name inside the daemon task; the SSM target needs its runtime id. */
  daemon_container_name?: string;
  /** Port the daemon binds inside that container; the far end of the forward. */
  daemon_port?: number;
  /** Fallback when capacity_provider is absent. Default "EC2". */
  launch_type?: string;
  subnets?: string[];
  security_groups?: string[];
  /**
   * Capacity tiers offered by the infra unit — what the largest task can request.
   * Emitted by the Terraform unit; absent in legacy configs means no check.
   */
  capacity_tiers?: CapacityTier[];
};

/** Build an EcsConfig from a parsed fleet_config value, validating required fields. */
export function ecsConfigFromFleetConfig(config: FleetConfig): EcsConfig {
  const required = (key: string, val: string | undefined): string => {
    if (!val) throw new Error(`fleet_config missing required field: ${key}`);
    return val;
  };
  return {
    cluster: required("cluster", config.cluster),
    taskDefinition: required("runner_task_definition", config.runner_task_definition),
    containerName: required("runner_container_name", config.runner_container_name),
    subnets: config.subnets ?? [],
    securityGroups: config.security_groups ?? [],
    capacityProvider: config.capacity_provider,
    launchType: config.launch_type ?? "EC2",
    assignPublicIp: "DISABLED",
    capacityTiers: config.capacity_tiers ?? [],
  };
}

/**
 * Check whether a resource request fits within at least one offered capacity tier.
 * Throws with the exact requested vs available numbers when nothing fits.
 * Pure function — exported for unit testing without a live ECS config.
 */
export function checkResourceFit(resources: ResourceRequest, tiers: CapacityTier[]): void {
  if (tiers.length === 0) return; // no tiers declared → no check (legacy config)
  const { cpu, memory } = resources;
  if (cpu == null && memory == null) return; // nothing requested → always fits
  const fits = tiers.some(
    (tier) => (!cpu || cpu <= tier.cpu) && (!memory || memory <= tier.memory),
  );
  if (fits) return;

  // Report the best tier (highest cpu; break ties by memory) alongside the request.
  const best = tiers.reduce((a, b) => (a.cpu > b.cpu || (a.cpu === b.cpu && a.memory >= b.memory) ? a : b));
  const requestedStr = [cpu != null ? `cpu=${cpu}` : null, memory != null ? `memory=${memory}` : null]
    .filter((s) => s !== null)
    .join(", ");
  throw new Error(
    `resource request exceeds offered capacity: requested ${requestedStr} but max offered is cpu=${best.cpu}, memory=${best.memory}`,
  );
}

/**
 * Parse the raw JSON string returned by `aws ssm get-parameter --output json`.
 * Pure function — testable without shelling out.
 */
export function parseFleetConfigSsmResponse(ssmJson: string): FleetConfig {
  const response = JSON.parse(ssmJson) as { Parameter?: { Value?: string } };
  const value = response?.Parameter?.Value;
  if (!value) throw new Error("SSM get-parameter response missing Parameter.Value");
  return JSON.parse(value) as FleetConfig;
}

/**
 * Shell out to `aws ssm get-parameter` and return an EcsConfig.
 * Used at daemon startup when FLEET_ECS_CONFIG_SSM_PATH is set and no
 * FLEET_ECS_CLUSTER override is present.
 */
export async function ecsConfigFromSsm(path: string): Promise<EcsConfig> {
  const { stdout } = await run("aws", [
    "ssm",
    "get-parameter",
    "--name",
    path,
    // The parameter is a SecureString (infra/aws/main.tf). Without this the
    // call succeeds and returns the ciphertext, so the failure is a JSON parse
    // error at daemon boot rather than an access denied — harmless with a
    // String parameter, and required with any encrypted one.
    "--with-decryption",
    "--output",
    "json",
  ]);
  return ecsConfigFromFleetConfig(parseFleetConfigSsmResponse(stdout));
}

/**
 * Read FLEET_ECS_* config. Required: FLEET_ECS_CLUSTER, FLEET_ECS_TASK_DEF,
 * FLEET_ECS_CONTAINER. Optional: FLEET_ECS_SUBNETS / FLEET_ECS_SECURITY_GROUPS
 * (comma-separated), FLEET_ECS_LAUNCH_TYPE (default EC2),
 * FLEET_ECS_ASSIGN_PUBLIC_IP (default DISABLED).
 * Capacity tiers cannot be set via env vars — use fleet_config (SSM) for production.
 */
export function ecsConfigFromEnv(env: Record<string, string | undefined> = process.env): EcsConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env: ${name}`);
    return value;
  };
  const list = (value: string | undefined): string[] =>
    value ? value.split(",").map((item) => item.trim()).filter((item) => item.length > 0) : [];
  return {
    cluster: required("FLEET_ECS_CLUSTER"),
    taskDefinition: required("FLEET_ECS_TASK_DEF"),
    containerName: required("FLEET_ECS_CONTAINER"),
    subnets: list(env.FLEET_ECS_SUBNETS),
    securityGroups: list(env.FLEET_ECS_SECURITY_GROUPS),
    launchType: env.FLEET_ECS_LAUNCH_TYPE ?? "EC2",
    assignPublicIp: env.FLEET_ECS_ASSIGN_PUBLIC_IP ?? "DISABLED",
    capacityTiers: [],
  };
}

// ---------- operator access: SSM port-forward to the daemon ----------
// The AWS unit's answer to D12's "give the operator access without public
// ingress". Everything below is command construction and response parsing —
// pure, unit-tested without AWS — plus one thin opener that shells out.

/** What `fleet connect` needs to address this deployment's daemon container. */
export type EcsDaemonAccess = {
  cluster: string;
  /** ECS service holding the daemon task. Re-queried every session: task ids change. */
  service: string;
  /** Container name inside the daemon task definition. */
  containerName: string;
  /** Port the daemon binds inside the container. */
  port: number;
};

/** Build an EcsDaemonAccess from a parsed fleet_config, naming any missing field. */
export function ecsDaemonAccessFromFleetConfig(config: FleetConfig): EcsDaemonAccess {
  const required = (key: string, val: string | undefined): string => {
    if (!val) throw new Error(`fleet_config missing required field: ${key}`);
    return val;
  };
  const port = config.daemon_port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    throw new Error("fleet_config missing required field: daemon_port");
  }
  return {
    cluster: required("cluster", config.cluster),
    service: required("daemon_service", config.daemon_service),
    containerName: required("daemon_container_name", config.daemon_container_name),
    port,
  };
}

/** argv after `aws` for listing the daemon service's running tasks. */
export function buildListDaemonTasksArgs(access: EcsDaemonAccess): string[] {
  return [
    "ecs",
    "list-tasks",
    "--cluster",
    access.cluster,
    "--service-name",
    access.service,
    "--desired-status",
    "RUNNING",
    "--output",
    "json",
  ];
}

/** argv after `aws` for describing one task. */
export function buildDescribeDaemonTaskArgs(access: EcsDaemonAccess, taskArn: string): string[] {
  return ["ecs", "describe-tasks", "--cluster", access.cluster, "--tasks", taskArn, "--output", "json"];
}

/** First task ARN from an `ecs list-tasks --output json` response. Throws when the service has none. */
export function parseDaemonTaskArn(listJson: string, access: EcsDaemonAccess): string {
  const parsed = JSON.parse(listJson) as { taskArns?: string[] };
  const arn = parsed.taskArns?.[0];
  if (!arn) {
    throw new Error(
      `no running task for service ${access.service} on cluster ${access.cluster} — the daemon service is not up`,
    );
  }
  return arn;
}

/**
 * Runtime id of the daemon container in an `ecs describe-tasks --output json`
 * response. Selected by container name, not position: a task with a sidecar
 * would otherwise forward to whichever container ECS happened to list first.
 * A task still starting has no runtime id — that is a wait, not a target.
 */
export function parseDaemonRuntimeId(describeJson: string, containerName: string): string {
  const parsed = JSON.parse(describeJson) as {
    tasks?: { lastStatus?: string; containers?: { name?: string; runtimeId?: string }[] }[];
  };
  const task = parsed.tasks?.[0];
  if (!task) throw new Error("ecs describe-tasks returned no task for the daemon service");
  if (task.lastStatus !== "RUNNING") {
    throw new Error(`daemon task is ${task.lastStatus ?? "in an unknown state"}, not RUNNING`);
  }
  const container = task.containers?.find((c) => c.name === containerName);
  if (!container) {
    const names = (task.containers ?? []).map((c) => c.name ?? "?").join(", ") || "none";
    throw new Error(`daemon task has no container named ${containerName} (containers: ${names})`);
  }
  if (!container.runtimeId) throw new Error(`container ${containerName} has no runtimeId yet — the task is still starting`);
  return container.runtimeId;
}

/**
 * SSM session target for one ECS container: `ecs:<cluster>_<taskId>_<runtimeId>`.
 * Underscore-separated and taking the task *id* (the ARN's last segment), because
 * the SSM API's target regex rejects both commas and slashes.
 */
export function ssmSessionTarget(cluster: string, taskArn: string, runtimeId: string): string {
  const taskId = taskArn.slice(taskArn.lastIndexOf("/") + 1);
  return `ecs:${cluster}_${taskId}_${runtimeId}`;
}

/** argv after `aws` for the port-forward session that holds the tunnel open. */
export function buildPortForwardArgs(target: string, remotePort: number, localPort: number): string[] {
  return [
    "ssm",
    "start-session",
    "--target",
    target,
    "--document-name",
    "AWS-StartPortForwardingSessionToRemoteHost",
    "--parameters",
    JSON.stringify({
      host: ["localhost"],
      portNumber: [String(remotePort)],
      localPortNumber: [String(localPort)],
    }),
  ];
}

/**
 * How long one `aws` read may take before its process is killed. These are
 * single describe-style calls; the AWS CLI's own retry budget on a bad network
 * is minutes, and an unkilled child keeps the CLI's event loop alive long after
 * the caller has given up on the promise.
 */
export const AWS_CLI_TIMEOUT_MS = 10_000;

/**
 * Dispatch and cancel budgets (#122): `run-task` provisions capacity, so it
 * earns a larger budget than the tunnel path above — but finite, so a wedged
 * CLI settles the daemon's launch or cancel path into its error handling
 * instead of hanging it forever. Pinned by test/daemon-providers.test.ts.
 */
export const ECS_RUN_TASK_TIMEOUT_MS = 120_000;
export const ECS_STOP_TASK_TIMEOUT_MS = 30_000;

/**
 * Shell out to `aws` and return stdout, killing the child at `timeoutMs`
 * (default: the tunnel-path budget). Injectable so callers are testable
 * without AWS.
 */
export const awsCli: CloudCliRunner = async (args, timeoutMs = AWS_CLI_TIMEOUT_MS) =>
  (await run("aws", args, { timeout: timeoutMs })).stdout;

/**
 * Tunnel opener for an ECS deployment: list the service's running task, read the
 * daemon container's runtime id, and hand back the `aws ssm start-session` argv
 * plus the target it resolved to. Resolution happens on every call — a service
 * deployment replaces the task id, and a reopened session must find the new one.
 */
export function ecsTunnelOpener(access: EcsDaemonAccess, aws: CloudCliRunner = awsCli): TunnelOpener {
  return async (localPort: number): Promise<TunnelEndpoint> => {
    const taskArn = parseDaemonTaskArn(await aws(buildListDaemonTasksArgs(access)), access);
    const runtimeId = parseDaemonRuntimeId(
      await aws(buildDescribeDaemonTaskArgs(access, taskArn)),
      access.containerName,
    );
    const target = ssmSessionTarget(access.cluster, taskArn, runtimeId);
    return { argv: ["aws", ...buildPortForwardArgs(target, access.port, localPort)], id: target };
  };
}

const CONTAINER_WORKSPACE = "/workspace";

/** EcsProvider construction options. */
export type EcsProviderOptions = {
  /** Shell-out to `aws`; defaults to the budget-killing awsCli. Injectable for tests. */
  aws?: CloudCliRunner;
};

export class EcsProvider implements Provider {
  readonly name = "ecs";
  readonly config: EcsConfig;
  readonly #aws: CloudCliRunner;

  constructor(config: EcsConfig, options: EcsProviderOptions = {}) {
    this.config = config;
    this.#aws = options.aws ?? awsCli;
  }

  /** argv after `aws` — pure function, unit-tested without AWS. */
  buildRunTaskArgs(spec: LaunchSpec): string[] {
    const env: Record<string, string> = {
      ...runnerEnv(spec, CONTAINER_WORKSPACE),
      ...materializationEnv(spec),
    };
    const overrides: Record<string, unknown> = {
      containerOverrides: [
        {
          name: this.config.containerName,
          environment: Object.entries(env)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, value]) => ({ name, value })),
        },
      ],
    };
    // Task-level cpu/memory overrides let jobs request more (or less) than the
    // task-definition default without re-registering the task definition.
    // ECS task-level override values must be strings.
    if (spec.resources?.cpu != null) overrides.cpu = String(spec.resources.cpu);
    if (spec.resources?.memory != null) overrides.memory = String(spec.resources.memory);
    // Prefer capacity-provider strategy so managed ASG scaling fires (defect #2).
    // Fall back to --launch-type only when no capacity provider is configured
    // (env-var overrides, tests, legacy SSM configs that predate this fix).
    const launchArgs: string[] = this.config.capacityProvider
      ? [
          "--capacity-provider-strategy",
          `capacityProvider=${this.config.capacityProvider},weight=1,base=0`,
        ]
      : ["--launch-type", this.config.launchType];
    const args = [
      "ecs",
      "run-task",
      "--cluster",
      this.config.cluster,
      "--task-definition",
      this.config.taskDefinition,
      ...launchArgs,
      "--started-by",
      `fleet:${spec.jobId}`,
      "--overrides",
      JSON.stringify(overrides),
      "--output",
      "json",
    ];
    if (this.config.subnets.length > 0) {
      const network = {
        awsvpcConfiguration: {
          subnets: this.config.subnets,
          securityGroups: this.config.securityGroups,
          assignPublicIp: this.config.assignPublicIp,
        },
      };
      args.push("--network-configuration", JSON.stringify(network));
    }
    return args;
  }

  /**
   * Validate that the requested resources fit within at least one offered capacity tier.
   * Throws with exact numbers when the request cannot be served — call before launch().
   */
  checkResources(resources: ResourceRequest): void {
    checkResourceFit(resources, this.config.capacityTiers);
  }

  /**
   * Two-layer job images (#49): this provider cannot honor a per-job image
   * override. `ecs run-task` container overrides cannot change the image, the
   * runner task definition pins the deployment's :runner tag, and the
   * CLI-built job image is local to the operator's docker anyway — nothing
   * pushes it to a registry ECS could pull. Until delegate pushes the image
   * to the deployment's ECR and this provider registers a task-definition
   * revision for it, refuse at dispatch: a silent fallback to the pinned
   * image would run the job in an environment the manifest explicitly
   * versioned away from. buildRunTaskArgs deliberately never reads spec.image.
   */
  checkImageOverride(image: string): void {
    throw new Error(
      `the ecs provider cannot run the computed job image ${image}: ` +
        "the runner task definition pins its own image and run-task cannot override it. " +
        "Remove harness.cli_version from the manifest (one-layer mode: the runner executes " +
        "setup.script in the workspace before the pickup gate), or dispatch to a docker deployment.",
    );
  }

  /**
   * Run one `aws` call under its phase budget (#122): the deadline races the
   * CLI so the daemon's launch/cancel path settles either way, and the same
   * value is passed down so the real child process is killed rather than left
   * holding the event loop after the caller has given up.
   */
  async #cli(args: string[], budgetMs: number): Promise<string> {
    const { promise, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => reject(new Error(`aws ${args[0]} ${args[1]} exceeded its ${budgetMs}ms budget`)),
      budgetMs,
    );
    try {
      return await Promise.race([this.#aws(args, budgetMs), promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** argv after `aws` for stopping one task — pure function, unit-tested without AWS. */
  buildStopTaskArgs(handle: string): string[] {
    return [
      "ecs",
      "stop-task",
      "--cluster",
      this.config.cluster,
      "--task",
      handle,
      "--reason",
      "fleet-cancel",
      "--output",
      "json",
    ];
  }

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    const stdout = await this.#cli(this.buildRunTaskArgs(spec), ECS_RUN_TASK_TIMEOUT_MS);
    const result = JSON.parse(stdout) as { tasks?: { taskArn?: string }[]; failures?: unknown[] };
    const taskArn = result.tasks?.[0]?.taskArn;
    if (!taskArn) {
      throw new Error(`ecs run-task launched no task: ${JSON.stringify(result.failures ?? result)}`);
    }
    return { handle: taskArn };
  }

  async terminate(handle: string): Promise<void> {
    // One bounded retry (#122): a transient stop-task failure must not mark a
    // job cancelled while its task keeps running. Not-found is success —
    // termination is idempotent by the Provider contract.
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.#cli(this.buildStopTaskArgs(handle), ECS_STOP_TASK_TIMEOUT_MS);
        return;
      } catch (error) {
        if (isMissingResourceError(error)) return;
        lastError = error;
      }
    }
    throw lastError;
  }
}
