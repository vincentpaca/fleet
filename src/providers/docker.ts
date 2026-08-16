// DockerProvider: `docker run` with env-injected config, no mounts. The
// runner clones/materialises the workspace inside the container (manifest and
// synced files travel as env: FLEET_MANIFEST_JSON / FLEET_SYNC_JSON, base64).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LaunchSpec, Provider } from "./provider.ts";
import { runnerEnv } from "./provider.ts";

const run = promisify(execFile);

export type DockerProviderOptions = {
  /** Image used when the manifest/spec supplies none. */
  defaultImage?: string;
  /** Command executed inside the container. */
  runnerCmd?: string[];
};

const DEFAULT_IMAGE = "node:22";
const DEFAULT_RUNNER_CMD = ["node", "/opt/fleet/src/runner/main.ts"];
const CONTAINER_WORKSPACE = "/workspace";

export class DockerProvider implements Provider {
  readonly name = "docker";
  readonly #defaultImage: string;
  readonly #runnerCmd: string[];

  constructor(options: DockerProviderOptions = {}) {
    this.#defaultImage = options.defaultImage ?? DEFAULT_IMAGE;
    this.#runnerCmd = options.runnerCmd ?? DEFAULT_RUNNER_CMD;
  }

  /** argv after `docker` — pure function, unit-tested without a docker daemon. */
  buildRunArgs(spec: LaunchSpec): string[] {
    const env: Record<string, string> = {
      ...runnerEnv(spec, CONTAINER_WORKSPACE),
      // Workspace materialisation (#5): manifest, work order, and sync files
      // travel as base64 env vars; the runner writes them to FLEET_WORKSPACE
      // before reading any files (Docker provider path; no-op for ProcessProvider).
      FLEET_MANIFEST_JSON: Buffer.from(JSON.stringify(spec.manifest)).toString("base64"),
      FLEET_WORK_ORDER_JSON: Buffer.from(JSON.stringify(spec.workOrder)).toString("base64"),
    };
    if (Object.keys(spec.sync).length > 0) {
      env.FLEET_SYNC_JSON = Buffer.from(JSON.stringify(spec.sync)).toString("base64");
    }
    const args = ["run", "-d", "--name", `fleet-${spec.jobId}`, "--label", `fleet.job=${spec.jobId}`];
    for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(spec.image ?? this.#defaultImage, ...this.#runnerCmd);
    return args;
  }

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    const { stdout } = await run("docker", this.buildRunArgs(spec));
    const containerId = stdout.trim();
    if (containerId.length === 0) throw new Error("docker run returned no container id");
    return { handle: containerId };
  }

  async terminate(handle: string): Promise<void> {
    await run("docker", ["rm", "-f", handle]);
  }
}
