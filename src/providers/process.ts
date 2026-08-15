// ProcessProvider: runs the runner as a local child process in a temp
// workspace. This is the no-docker e2e path: daemon and runner on one host,
// runner reaching the daemon over 127.0.0.1.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { LaunchSpec, Provider } from "./provider.ts";
import { runnerEnv } from "./provider.ts";

export type ProcessProviderOptions = {
  /** Runner entrypoint; defaults to the in-repo runner. Tests point this at a fake. */
  runnerPath?: string;
  /** Parent directory for job workspaces; defaults to the OS temp dir. */
  workspaceRoot?: string;
};

/** Materialise manifest + synced files into a fresh workspace directory. */
export function prepareWorkspace(spec: LaunchSpec, root: string): string {
  const workspace = mkdtempSync(join(root, `fleet-${spec.jobId}-`));
  const fleetDir = join(workspace, ".fleet");
  mkdirSync(join(fleetDir, "out"), { recursive: true });
  writeFileSync(join(fleetDir, "manifest.json"), JSON.stringify(spec.manifest, null, 2));
  writeFileSync(join(fleetDir, "order.json"), JSON.stringify(spec.workOrder, null, 2));
  for (const [relPath, base64] of Object.entries(spec.sync)) {
    const target = resolve(workspace, relPath);
    if (target !== workspace && !target.startsWith(workspace + sep)) {
      throw new Error(`sync path escapes workspace: ${relPath}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(base64, "base64"));
  }
  return workspace;
}

export class ProcessProvider implements Provider {
  readonly name = "process";
  readonly #runnerPath: string;
  readonly #workspaceRoot: string;

  constructor(options: ProcessProviderOptions = {}) {
    this.#runnerPath = options.runnerPath ?? resolve(import.meta.dirname, "../runner/main.ts");
    this.#workspaceRoot = options.workspaceRoot ?? tmpdir();
  }

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    const workspace = prepareWorkspace(spec, this.#workspaceRoot);
    const child = spawn(process.execPath, [this.#runnerPath], {
      cwd: workspace,
      env: { ...process.env, ...runnerEnv(spec, workspace) },
      stdio: "ignore",
      detached: false,
    });
    const { promise, resolve: ready, reject } = Promise.withResolvers<{ handle: string }>();
    child.once("spawn", () => {
      child.unref();
      ready({ handle: `pid:${child.pid}` });
    });
    child.once("error", reject);
    return promise;
  }

  async terminate(handle: string): Promise<void> {
    const pid = Number(handle.replace(/^pid:/, ""));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad process handle: ${handle}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      // ESRCH: already exited — termination is idempotent.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
