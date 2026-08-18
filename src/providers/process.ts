// ProcessProvider: runs the runner as a local child process in a temp
// workspace. This is the no-docker e2e path: daemon and runner on one host,
// runner reaching the daemon over 127.0.0.1.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { LaunchSpec, Provider } from "./provider.ts";
import { runnerEnv } from "./provider.ts";
import { fleetHome } from "../shared/home.ts";
import { hasRetainRequest, readRetainRequest, writeRetainedRecord } from "../shared/retained.ts";

export type ProcessProviderOptions = {
  /** Runner entrypoint; defaults to the in-repo runner. Tests point this at a fake. */
  runnerPath?: string;
  /** Parent directory for job workspaces; defaults to the OS temp dir. */
  workspaceRoot?: string;
  /** Where retained-workspace records are registered; defaults to $FLEET_HOME. */
  home?: string;
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
  readonly #home: string;

  constructor(options: ProcessProviderOptions = {}) {
    this.#runnerPath = options.runnerPath ?? resolve(import.meta.dirname, "../runner/main.ts");
    this.#workspaceRoot = options.workspaceRoot ?? tmpdir();
    this.#home = options.home ?? fleetHome();
  }

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    const workspace = prepareWorkspace(spec, this.#workspaceRoot);
    const child = spawn(process.execPath, [this.#runnerPath], {
      cwd: workspace,
      env: { ...process.env, ...runnerEnv(spec, workspace) },
      stdio: "ignore",
      detached: false,
    });
    // Workspaces are as disposable as containers: evidence lives in the job
    // branch (pushed) and the daemon's event log, never in the directory.
    // FLEET_KEEP_WORKSPACE=1 keeps it for debugging a crashed runner.
    // The one non-debug exception (#38): the runner leaves a retain request
    // when the work push failed, so the only copy of the work is right here.
    // The kept path is registered under $FLEET_HOME/retained/ — `fleet doctor`
    // lists it, `fleet resume-push` retries the push and cleans up.
    child.once("exit", () => {
      // The request file existing is the decision — an unreadable one still
      // keeps the workspace, and gets registered with whatever it did carry.
      // Registering happens even under FLEET_KEEP_WORKSPACE: a failed push
      // during a debug run is still a delivery the operator must recover.
      if (hasRetainRequest(workspace)) {
        const retain = readRetainRequest(workspace) ?? {
          jobId: spec.jobId,
          reason: "retain request unreadable — the runner asked to keep this workspace",
          at: new Date().toISOString(),
        };
        try {
          writeRetainedRecord(this.#home, { ...retain, jobId: spec.jobId, workspace });
        } catch {
          // Registry unwritable: keep the directory anyway. An unlisted
          // workspace is recoverable by hand; a deleted one is not.
        }
        return;
      }
      if (process.env.FLEET_KEEP_WORKSPACE) return;
      rmSync(workspace, { recursive: true, force: true });
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
