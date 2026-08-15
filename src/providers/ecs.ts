// EcsProvider: `aws ecs run-task` shell-out, configured from FLEET_ECS_* env.
// Phase 1: methods implemented, integration untested — command construction
// is the unit-tested surface.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LaunchSpec, Provider } from "./provider.ts";
import { runnerEnv } from "./provider.ts";

const run = promisify(execFile);

export type EcsConfig = {
  cluster: string;
  taskDefinition: string;
  /** Container name in the task definition receiving the env overrides. */
  containerName: string;
  subnets: string[];
  securityGroups: string[];
  launchType: string;
  assignPublicIp: string;
};

/**
 * Read FLEET_ECS_* config. Required: FLEET_ECS_CLUSTER, FLEET_ECS_TASK_DEF,
 * FLEET_ECS_CONTAINER. Optional: FLEET_ECS_SUBNETS / FLEET_ECS_SECURITY_GROUPS
 * (comma-separated), FLEET_ECS_LAUNCH_TYPE (default EC2),
 * FLEET_ECS_ASSIGN_PUBLIC_IP (default DISABLED).
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
  };
}

const CONTAINER_WORKSPACE = "/workspace";

export class EcsProvider implements Provider {
  readonly name = "ecs";
  readonly config: EcsConfig;

  constructor(config: EcsConfig) {
    this.config = config;
  }

  /** argv after `aws` — pure function, unit-tested without AWS. */
  buildRunTaskArgs(spec: LaunchSpec): string[] {
    const env: Record<string, string> = {
      ...runnerEnv(spec, CONTAINER_WORKSPACE),
      FLEET_MANIFEST_JSON: Buffer.from(JSON.stringify(spec.manifest)).toString("base64"),
    };
    if (Object.keys(spec.sync).length > 0) {
      env.FLEET_SYNC_JSON = Buffer.from(JSON.stringify(spec.sync)).toString("base64");
    }
    const overrides = {
      containerOverrides: [
        {
          name: this.config.containerName,
          environment: Object.entries(env)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, value]) => ({ name, value })),
        },
      ],
    };
    const args = [
      "ecs",
      "run-task",
      "--cluster",
      this.config.cluster,
      "--task-definition",
      this.config.taskDefinition,
      "--launch-type",
      this.config.launchType,
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

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    const { stdout } = await run("aws", this.buildRunTaskArgs(spec));
    const result = JSON.parse(stdout) as { tasks?: { taskArn?: string }[]; failures?: unknown[] };
    const taskArn = result.tasks?.[0]?.taskArn;
    if (!taskArn) {
      throw new Error(`ecs run-task launched no task: ${JSON.stringify(result.failures ?? result)}`);
    }
    return { handle: taskArn };
  }

  async terminate(handle: string): Promise<void> {
    await run("aws", [
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
    ]);
  }
}
