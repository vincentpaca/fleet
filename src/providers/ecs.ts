// EcsProvider: `aws ecs run-task` shell-out.
// Configuration sources (highest priority first):
//   1. ecsConfigFromEnv()   — FLEET_ECS_* env vars (tests / manual override)
//   2. ecsConfigFromSsm()   — SSM parameter written by the infra unit (production)
// The unit-tested surface is command construction; everything here shells out.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CloudCliRunner, JobSandbox, LaunchSpec, Provider, ResourceRequest, TunnelEndpoint, TunnelOpener } from "./provider.ts";
import { isMissingResourceError, runnerEnv, materializationEnv, writeSecretTempFile } from "./provider.ts";

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
  /**
   * AWS region of the deployment (#138). When present, every `aws` argv this
   * provider builds carries `--region` so a wrong ambient AWS_REGION cannot
   * point a call at the wrong account corner. Optional: legacy fleet_config
   * captures predate it, and env-var configs may rely on ambient config.
   */
  region?: string;
  subnets: string[];
  securityGroups: string[];
  /**
   * ECS capacity provider to use for run-task (preferred over launchType when set).
   * When set, buildRunTaskInput emits capacityProviderStrategy so managed scaling
   * fires. When absent, falls back to launchType (EC2 default).
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
   * AWS region the unit deployed into. Optional for backward compatibility
   * with captures that predate #138; when present it is appended as --region
   * to every aws invocation so the operator's ambient region cannot misroute
   * a call (the failure reads as "the daemon service is not up").
   */
  region?: string;
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
    region: config.region,
    subnets: config.subnets ?? [],
    securityGroups: config.security_groups ?? [],
    capacityProvider: config.capacity_provider,
    launchType: config.launch_type ?? "EC2",
    assignPublicIp: "DISABLED",
    capacityTiers: config.capacity_tiers ?? [],
  };
}

/**
 * Append `--region <region>` when the deployment names one (#138). Every argv
 * builder in this file routes through it: the alternative is the CLI's ambient
 * region, and a wrong ambient region does not error — it asks a different
 * region the same question and gets an empty answer, which the tunnel path
 * reports as "the daemon service is not up".
 */
function withRegion(args: string[], region: string | undefined): string[] {
  return region ? [...args, "--region", region] : args;
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
 *
 * Deliberately no --region (#138): this is the bootstrap read — the region
 * lives inside the parameter this call fetches. The daemon runs inside the
 * deployment's own ECS task, where AWS_REGION is set by the substrate to the
 * right value; everything after this call names the region explicitly.
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
 * FLEET_ECS_CONTAINER. Optional: FLEET_ECS_REGION (falls back to the ambient
 * AWS config when unset), FLEET_ECS_SUBNETS / FLEET_ECS_SECURITY_GROUPS
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
    region: env.FLEET_ECS_REGION,
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
  /**
   * AWS region of the deployment (#138). Optional — captures predating it
   * fall back to the caller's ambient region, which is exactly the failure
   * mode this field removes: `fleet connect` under a wrong AWS_REGION lists
   * tasks in the wrong region and reports "the daemon service is not up".
   */
  region?: string;
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
    // Spread, not `region: config.region`: a capture predating #138 yields an
    // access object without the key, identical to what it produced before.
    ...(config.region ? { region: config.region } : {}),
  };
}

/** argv after `aws` for listing the daemon service's running tasks. */
export function buildListDaemonTasksArgs(access: EcsDaemonAccess): string[] {
  return withRegion(
    [
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
    ],
    access.region,
  );
}

/** argv after `aws` for describing one task. */
export function buildDescribeDaemonTaskArgs(access: EcsDaemonAccess, taskArn: string): string[] {
  return withRegion(
    ["ecs", "describe-tasks", "--cluster", access.cluster, "--tasks", taskArn, "--output", "json"],
    access.region,
  );
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
export function buildPortForwardArgs(
  target: string,
  remotePort: number,
  localPort: number,
  region?: string,
): string[] {
  return withRegion(
    [
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
    ],
    region,
  );
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
    return { argv: ["aws", ...buildPortForwardArgs(target, access.port, localPort, access.region)], id: target };
  };
}

const CONTAINER_WORKSPACE = "/workspace";

/**
 * The run-task `startedBy` stamp: `fleet:<jobId>`. One constant for both ends
 * of the contract — buildRunTaskInput writes it at dispatch, the #147 reconcile
 * sweep parses it back out of describe-tasks — so the launcher and the sweep
 * cannot drift on the one string that ties a task to its job.
 */
export const STARTED_BY_PREFIX = "fleet:";

/**
 * ECS DescribeTasks accepts at most 100 task ARNs per call (API constraint —
 * no plan reaches it; pinned by test/daemon-providers.test.ts).
 */
export const DESCRIBE_TASKS_BATCH = 100;

/**
 * The fleet-launched tasks in an `ecs describe-tasks --output json` response:
 * every task whose startedBy carries the fleet stamp, mapped to the job id it
 * names. Tasks started by anything else (the daemon service, an operator's
 * hand-run task) are not fleet's to touch and are dropped here, before any
 * caller can conflate them with a job. Pure function — testable without AWS.
 */
export function parseFleetTasks(describeJson: string): JobSandbox[] {
  const parsed = JSON.parse(describeJson) as { tasks?: { taskArn?: string; startedBy?: string }[] };
  const found: JobSandbox[] = [];
  for (const task of parsed.tasks ?? []) {
    if (typeof task.taskArn !== "string" || task.taskArn === "") continue;
    if (typeof task.startedBy !== "string" || !task.startedBy.startsWith(STARTED_BY_PREFIX)) continue;
    found.push({ jobId: task.startedBy.slice(STARTED_BY_PREFIX.length), handle: task.taskArn });
  }
  return found;
}

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

  /**
   * The `--cli-input-json` payload for run-task — pure function, unit-tested
   * without AWS. Every parameter, including the overrides block that carries
   * the manifest env and the runner token, rides in this JSON: on argv the
   * values would be world-readable in `ps` for the CLI's lifetime and land in
   * shell/audit logs (#126). Field names follow the RunTask API shape.
   * `startedBy: fleet:<jobId>` must survive exactly — #147's reconcile sweep
   * keys on it to tell fleet tasks from everything else on the cluster.
   */
  buildRunTaskInput(spec: LaunchSpec): Record<string, unknown> {
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
    const input: Record<string, unknown> = {
      cluster: this.config.cluster,
      taskDefinition: this.config.taskDefinition,
      startedBy: `${STARTED_BY_PREFIX}${spec.jobId}`,
      overrides,
    };
    // Prefer capacity-provider strategy so managed ASG scaling fires (defect #2).
    // Fall back to launchType only when no capacity provider is configured
    // (env-var overrides, tests, legacy SSM configs that predate this fix).
    // The API rejects a request carrying both.
    if (this.config.capacityProvider) {
      input.capacityProviderStrategy = [
        { capacityProvider: this.config.capacityProvider, weight: 1, base: 0 },
      ];
    } else {
      input.launchType = this.config.launchType;
    }
    if (this.config.subnets.length > 0) {
      input.networkConfiguration = {
        awsvpcConfiguration: {
          subnets: this.config.subnets,
          securityGroups: this.config.securityGroups,
          assignPublicIp: this.config.assignPublicIp,
        },
      };
    }
    return input;
  }

  /**
   * argv after `aws` for run-task: the path to the input file, plus --region
   * (#138) — a routing flag, not a secret, kept on argv so region handling
   * stays uniform with every other builder in this file. All parameters — and
   * every secret — live in the file (#126).
   */
  buildRunTaskArgs(inputPath: string): string[] {
    return withRegion(
      ["ecs", "run-task", "--cli-input-json", `file://${inputPath}`, "--output", "json"],
      this.config.region,
    );
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
   * versioned away from. buildRunTaskInput deliberately never reads spec.image.
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
    return withRegion(
      [
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
      ],
      this.config.region,
    );
  }

  /**
   * argv after `aws` for one page of the cluster's running tasks (#147).
   * `startedBy` is not a server-side ListTasks filter, so this lists everything
   * with desired status RUNNING and describe-tasks supplies the startedBy to
   * filter on client-side. Pure function — unit-tested without AWS.
   */
  buildListClusterTasksArgs(startingToken?: string): string[] {
    return withRegion(
      [
        "ecs",
        "list-tasks",
        "--cluster",
        this.config.cluster,
        "--desired-status",
        "RUNNING",
        ...(startingToken !== undefined ? ["--starting-token", startingToken] : []),
        "--output",
        "json",
      ],
      this.config.region,
    );
  }

  /** argv after `aws` for describing a batch of tasks — pure function, unit-tested without AWS. */
  buildDescribeTasksArgs(taskArns: string[]): string[] {
    return withRegion(
      ["ecs", "describe-tasks", "--cluster", this.config.cluster, "--tasks", ...taskArns, "--output", "json"],
      this.config.region,
    );
  }

  /**
   * Every running task on the cluster that a fleet dispatch started, keyed by
   * job id (#147). This is the reconcile sweep's evidence, so completeness is
   * the contract: the AWS CLI auto-paginates ListTasks by default, but a
   * truncated response (--max-items in someone's alias, a future CLI change)
   * still carries a continuation token — follow it rather than silently treat
   * page one as the cluster. describe-tasks is batched at the API's cap.
   */
  async listJobSandboxes(): Promise<JobSandbox[]> {
    const taskArns: string[] = [];
    let token: string | undefined;
    do {
      const page = JSON.parse(await this.#cli(this.buildListClusterTasksArgs(token), AWS_CLI_TIMEOUT_MS)) as {
        taskArns?: string[];
        // The raw API spells it nextToken; the CLI's client-side pagination
        // emits NextToken. Honour both — dropping either loses page two.
        nextToken?: string;
        NextToken?: string;
      };
      taskArns.push(...(page.taskArns ?? []));
      token = page.nextToken ?? page.NextToken;
    } while (token !== undefined);
    const found: JobSandbox[] = [];
    for (let i = 0; i < taskArns.length; i += DESCRIBE_TASKS_BATCH) {
      const batch = taskArns.slice(i, i + DESCRIBE_TASKS_BATCH);
      found.push(...parseFleetTasks(await this.#cli(this.buildDescribeTasksArgs(batch), AWS_CLI_TIMEOUT_MS)));
    }
    return found;
  }

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    // The run-task parameters ride a 0600 file (#126); the CLI reads it while
    // the command runs, and the finally deletes it on success and failure alike.
    const input = writeSecretTempFile("fleet-ecs-run-", JSON.stringify(this.buildRunTaskInput(spec)));
    let stdout: string;
    try {
      stdout = await this.#cli(this.buildRunTaskArgs(input.path), ECS_RUN_TASK_TIMEOUT_MS);
    } finally {
      input.cleanup();
    }
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
