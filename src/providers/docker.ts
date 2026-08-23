// DockerProvider: `docker run` with env-injected config, no mounts. The
// runner clones/materialises the workspace inside the container (manifest and
// synced files travel as env: FLEET_MANIFEST_JSON / FLEET_SYNC_JSON, base64).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LaunchSpec, Provider } from "./provider.ts";
import { isMissingResourceError, runnerEnv, materializationEnv } from "./provider.ts";

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
      ...materializationEnv(spec),
    };
    const args = ["run", "-d", "--name", `fleet-${spec.jobId}`, "--label", `fleet.job=${spec.jobId}`];
    // Resource constraints from manifest limits.resources.
    // cpu is in ECS units (1024 = 1 vCPU); --cpus takes fractional cores.
    if (spec.resources?.cpu != null) args.push("--cpus", (spec.resources.cpu / 1024).toFixed(3));
    // memory is in MiB; Docker --memory accepts a number + unit suffix.
    if (spec.resources?.memory != null) args.push("--memory", `${spec.resources.memory}m`);
    for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(spec.image ?? this.#defaultImage, ...this.#runnerCmd);
    return args;
  }

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    // Remove any stale container from a prior run (parked-then-resumed, crashed
    // re-entry) before launching: `docker run --name fleet-<jobId>` fails with
    // "already in use" when the old container still owns the name. `rm -f`
    // succeeds even when no container exists, so there is no race to guard.
    await run("docker", ["rm", "-f", `fleet-${spec.jobId}`]);
    const { stdout } = await run("docker", this.buildRunArgs(spec));
    const containerId = stdout.trim();
    if (containerId.length === 0) throw new Error("docker run returned no container id");
    return { handle: containerId };
  }

  async terminate(handle: string): Promise<void> {
    try {
      await run("docker", ["rm", "-f", handle]);
    } catch (error) {
      // Idempotent termination (#122): `rm -f` exits non-zero when the
      // container is already gone; cancel must still succeed.
      if (!isMissingResourceError(error)) throw error;
    }
  }
}
