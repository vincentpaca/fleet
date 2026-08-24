// ProcessProvider: runs the runner as a local child process in a temp
// workspace. This is the no-docker e2e path: daemon and runner on one host,
// runner reaching the daemon over 127.0.0.1.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { LaunchSpec, Provider } from "./provider.ts";
import { runnerEnv } from "./provider.ts";
import { fleetHome } from "../shared/home.ts";
import { pidAlive, processStartTime } from "../shared/process.ts";
import { hasRetainRequest, readRetainRequest, writeRetainedRecord } from "../shared/retained.ts";

export type ProcessProviderOptions = {
  /** Runner entrypoint; defaults to the in-repo runner. Tests point this at a fake. */
  runnerPath?: string;
  /** Parent directory for job workspaces; defaults to the OS temp dir. */
  workspaceRoot?: string;
  /** Where retained-workspace records are registered; defaults to $FLEET_HOME. */
  home?: string;
  /** How often recover() re-checks an orphaned runner that is still alive. */
  sweepPollMs?: number;
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

/**
 * Host-side record of a launched runner (issue #123): the child is unref'd on
 * purpose — it survives a daemon crash — but the exit handler that disposes of
 * its workspace lives in the daemon and does not. This record, written at spawn
 * and removed once the workspace is disposed, is what a later daemon's
 * `recover()` sweeps: any record still on disk names a runner whose exit
 * handler died with a previous daemon.
 *
 * Same host-local bookkeeping pattern as `$FLEET_HOME/retained/` in
 * src/shared/retained.ts: one JSON file per job under `$FLEET_HOME/runners/`,
 * tolerant reads, no schema — it never crosses a wire.
 */
export type RunnerRecord = {
  jobId: string;
  pid: number;
  /**
   * OS-reported start time of the pid at spawn (see processStartTime): the
   * half of the (pid, start time) pair that survives pid recycling. null when
   * `ps` could not answer — liveness checks then degrade to the pid alone.
   */
  startedAt: string | null;
  workspace: string;
  at: string;
};

/** Live-runner registry directory: $FLEET_HOME/runners. */
export function runnersDir(home: string): string {
  return join(home, "runners");
}

function runnerRecordPath(home: string, jobId: string): string {
  return join(runnersDir(home), `${jobId}.json`);
}

function writeRunnerRecord(home: string, record: RunnerRecord): void {
  mkdirSync(runnersDir(home), { recursive: true });
  writeFileSync(runnerRecordPath(home, record.jobId), JSON.stringify(record, null, 2) + "\n");
}

/** The fields a runner record cannot act without: whose pid, which workspace. */
function isRunnerRecordShape(
  parsed: Partial<RunnerRecord>,
): parsed is Partial<RunnerRecord> & { jobId: string; pid: number; workspace: string } {
  return (
    typeof parsed?.jobId === "string" && parsed.jobId !== "" &&
    typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 &&
    typeof parsed.workspace === "string" && parsed.workspace !== ""
  );
}

/** Tolerant read: an unreadable or field-less file is simply absent. */
function readRunnerRecord(path: string): RunnerRecord | undefined {
  let parsed: Partial<RunnerRecord>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunnerRecord>;
  } catch {
    return undefined;
  }
  if (!isRunnerRecordShape(parsed)) return undefined;
  return {
    jobId: parsed.jobId,
    pid: parsed.pid,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
    workspace: parsed.workspace,
    at: typeof parsed.at === "string" ? parsed.at : "",
  };
}

/** Every runner record on disk. Empty when the registry is absent. */
export function listRunnerRecords(home: string): RunnerRecord[] {
  const dir = runnersDir(home);
  if (!existsSync(dir)) return [];
  const records: RunnerRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const record = readRunnerRecord(join(dir, name));
    if (record !== undefined) records.push(record);
  }
  return records;
}

/**
 * Drop the record for a job — but only when it still points at `workspace`.
 * A re-entered job overwrites its record with the fresh workspace; the old
 * generation's exit handler firing late must not delete the new record.
 */
function clearRunnerRecord(home: string, jobId: string, workspace: string): void {
  const record = readRunnerRecord(runnerRecordPath(home, jobId));
  if (record !== undefined && record.workspace !== workspace) return;
  rmSync(runnerRecordPath(home, jobId), { force: true });
}

/** Is this record's runner still the process holding its pid? */
function runnerAlive(record: RunnerRecord): boolean {
  if (record.startedAt !== null) return processStartTime(record.pid) === record.startedAt;
  return pidAlive(record.pid);
}

/**
 * `pid:<n>` or `pid:<n>:<start time>`: the start time pins the pid's identity
 * so terminate can tell "our runner" from "whatever the OS recycled the pid
 * to" after a daemon restart (#123). Absent only when `ps` could not answer
 * at spawn, or on a handle persisted by a pre-#123 daemon.
 */
function processHandle(pid: number, startedAt: string | null): string {
  return startedAt === null ? `pid:${pid}` : `pid:${pid}:${startedAt}`;
}

function parseProcessHandle(handle: string): { pid: number; startedAt?: string } {
  const match = /^pid:(\d+)(?::(.+))?$/s.exec(handle);
  const pid = match === null ? NaN : Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad process handle: ${handle}`);
  return { pid, startedAt: match![2] };
}

/**
 * Keep-or-delete disposition for a workspace whose runner has exited. One
 * function, two callers — the hot-path exit handler and recover()'s sweep —
 * so a daemon restart cannot change what happens to a workspace (#123).
 *
 * Workspaces are as disposable as containers: evidence lives in the job
 * branch (pushed) and the daemon's event log, never in the directory.
 * FLEET_KEEP_WORKSPACE=1 keeps it for debugging a crashed runner.
 * The one non-debug exception (#38): the runner leaves a retain request
 * when the work push failed, so the only copy of the work is right here.
 * The kept path is registered under $FLEET_HOME/retained/ — `fleet doctor`
 * lists it, `fleet resume-push` retries the push and cleans up.
 */
function disposeWorkspace(home: string, jobId: string, workspace: string): void {
  // The request file existing is the decision — an unreadable one still
  // keeps the workspace, and gets registered with whatever it did carry.
  // Registering happens even under FLEET_KEEP_WORKSPACE: a failed push
  // during a debug run is still a delivery the operator must recover.
  if (hasRetainRequest(workspace)) {
    const retain = readRetainRequest(workspace) ?? {
      jobId,
      reason: "retain request unreadable — the runner asked to keep this workspace",
      at: new Date().toISOString(),
    };
    try {
      writeRetainedRecord(home, { ...retain, jobId, workspace });
    } catch {
      // Registry unwritable: keep the directory anyway. An unlisted
      // workspace is recoverable by hand; a deleted one is not.
    }
    return;
  }
  if (process.env.FLEET_KEEP_WORKSPACE) return;
  rmSync(workspace, { recursive: true, force: true });
}

export class ProcessProvider implements Provider {
  readonly name = "process";
  readonly #runnerPath: string;
  readonly #workspaceRoot: string;
  readonly #home: string;
  readonly #sweepPollMs: number;

  constructor(options: ProcessProviderOptions = {}) {
    this.#runnerPath = options.runnerPath ?? resolve(import.meta.dirname, "../runner/main.ts");
    this.#workspaceRoot = options.workspaceRoot ?? tmpdir();
    this.#home = options.home ?? fleetHome();
    this.#sweepPollMs = options.sweepPollMs ?? 2_000;
  }

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    const workspace = prepareWorkspace(spec, this.#workspaceRoot);
    const child = spawn(process.execPath, [this.#runnerPath], {
      cwd: workspace,
      env: { ...process.env, ...runnerEnv(spec, workspace) },
      stdio: "ignore",
      detached: false,
    });
    child.once("exit", () => {
      disposeWorkspace(this.#home, spec.jobId, workspace);
      clearRunnerRecord(this.#home, spec.jobId, workspace);
    });
    const { promise, resolve: ready, reject } = Promise.withResolvers<{ handle: string }>();
    child.once("spawn", () => {
      child.unref();
      const pid = child.pid!;
      const startedAt = processStartTime(pid);
      try {
        writeRunnerRecord(this.#home, {
          jobId: spec.jobId,
          pid,
          startedAt,
          workspace,
          at: new Date().toISOString(),
        });
      } catch {
        // Registry unwritable: the exit handler still covers this daemon's
        // lifetime; only restart recovery degrades.
      }
      ready({ handle: processHandle(pid, startedAt) });
    });
    child.once("error", reject);
    return promise;
  }

  async terminate(handle: string): Promise<void> {
    const { pid, startedAt } = parseProcessHandle(handle);
    // Identity before signal (#123): a handle outlives daemons via the job
    // record, and after a restart the OS may have recycled its pid onto an
    // unrelated process. A start time that no longer matches means our runner
    // is gone — termination is idempotent, so that is success, not a kill.
    if (startedAt !== undefined && processStartTime(pid) !== startedAt) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      // ESRCH: already exited — termination is idempotent.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  /**
   * Settle every launch whose exit handler died with a previous daemon
   * (#123). Called once by the daemon entrypoint at boot: a runner record
   * still on disk was written by a launch this provider instance did not
   * make, so nothing in this process will fire when its runner exits.
   * A dead runner's workspace gets the same disposition the exit handler
   * would have applied; a live one is polled until it exits.
   */
  recover(): void {
    for (const record of listRunnerRecords(this.#home)) {
      this.#settleOrphan(record);
    }
  }

  #settleOrphan(record: RunnerRecord): void {
    if (!existsSync(record.workspace)) {
      // Disposed by hand (or by the daemon that died mid-teardown): the
      // record has nothing left to guard.
      clearRunnerRecord(this.#home, record.jobId, record.workspace);
      return;
    }
    if (runnerAlive(record)) {
      this.#watchOrphan(record);
      return;
    }
    console.error(
      `fleet: settling workspace ${record.workspace} (job ${record.jobId}) ` +
      `orphaned by a previous daemon`,
    );
    disposeWorkspace(this.#home, record.jobId, record.workspace);
    clearRunnerRecord(this.#home, record.jobId, record.workspace);
  }

  /**
   * An orphaned runner that is still working: leave it alone, and run the
   * disposition when it exits. Polling, because a process that is not our
   * child cannot be waited on. The timer is unref'd — an orphan must never
   * hold the daemon open.
   */
  #watchOrphan(record: RunnerRecord): void {
    const timer = setInterval(() => {
      if (runnerAlive(record)) return;
      clearInterval(timer);
      this.#settleOrphan(record);
    }, this.#sweepPollMs);
    timer.unref();
  }
}
