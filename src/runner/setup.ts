/**
 * One-layer setup (#49): run manifest setup.script in the workspace when the
 * image did not bake it.
 *
 * The two-layer build (src/cli/images.ts) runs setup.script during
 * `docker build` and leaves the marker from src/shared/setup-marker.ts in the
 * image. Every other substrate — the ECS runner task definition's pinned
 * :runner tag, a bare manifest setup.image on the docker provider, the process
 * provider's host — carries no marker, and before this module nobody ran the
 * script there at all: ECS jobs survived on the agent noticing missing
 * node_modules and installing by hand, which is luck, not a contract.
 *
 * The runner calls this after the workspace exists (clone done) and before the
 * pickup gate, so the gate probes the environment the manifest actually
 * promised. Every outcome carries a note for the event log — the whole point
 * is that setup is observable, not inferred.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setupBakedMarkerPath } from "../shared/setup-marker.ts";

type SetupScriptOutcome =
  /** Manifest declares no setup.script — nothing to do, nothing to log. */
  | { kind: "none" }
  /** The image baked the script at build (marker present). */
  | { kind: "baked"; note: string }
  /** Declared but not on disk (no clone, or the path is wrong). */
  | { kind: "missing"; note: string }
  | { kind: "ran"; note: string }
  | { kind: "failed"; note: string; detail: string };

type RunSetupScriptOptions = {
  workspace: string;
  manifest: Record<string, unknown>;
  /** Marker path override; defaults to setupBakedMarkerPath(process.env). */
  markerPath?: string;
  /** Kill budget; default 10 minutes (a dependency install, not a probe). */
  timeoutMs?: number;
};

/** Kill budget default: setup is `npm ci`-shaped work, not a 60s gate probe. */
const SETUP_TIMEOUT_MS = 600_000;

/** First non-empty line of a child's combined output, for one-line notes. */
function firstLine(stdout: string | null, stderr: string | null): string {
  const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
  return (
    combined.split("\n").map((line) => line.trim()).find((line) => line !== "") ??
    "(no output)"
  );
}

/** One-line diagnosis of a nonzero spawnSync result: exit, timeout, or no spawn. */
function failureDetail(
  child: { status: number | null; signal: NodeJS.Signals | null; stdout: string | null; stderr: string | null; error?: Error },
  timeoutMs: number,
): string {
  if (child.status !== null) return `exit ${child.status}: ${firstLine(child.stdout, child.stderr)}`;
  if (child.signal !== null) return `timed out after ${timeoutMs / 1000}s (killed with ${child.signal})`;
  return `failed to spawn: ${child.error?.message ?? "unknown error"}`;
}

/**
 * Execute manifest setup.script in the workspace unless the image baked it.
 * Blocking by design, like the pickup gate: nothing downstream is valid in an
 * environment whose setup never ran.
 */
export function runSetupScript(options: RunSetupScriptOptions): SetupScriptOutcome {
  const { workspace, manifest } = options;
  const setup = (manifest.setup ?? {}) as Record<string, unknown>;
  const script = typeof setup.script === "string" ? setup.script : "";
  if (script === "") return { kind: "none" };

  const marker = options.markerPath ?? setupBakedMarkerPath();
  if (existsSync(marker)) {
    return { kind: "baked", note: `setup script ${script} baked into the image; skipping` };
  }
  const scriptPath = join(workspace, script);
  if (!existsSync(scriptPath)) {
    return {
      kind: "missing",
      note: `setup script ${script} not found in the workspace; skipping`,
    };
  }

  const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
  const startedAt = Date.now();
  // `sh <path>`: the same invocation the two-layer build bakes
  // (`RUN sh /tmp/fleet-setup.sh`), so a script that works baked works here —
  // and the execute bit, which a fresh clone preserves but a synced file may
  // lose, never decides whether setup happens.
  const child = spawnSync("sh", [scriptPath], {
    cwd: workspace,
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs,
    // SIGKILL, not SIGTERM: a child that traps SIGTERM keeps spawnSync blocked
    // past its own timeout — the same wedge the pickup gate guards against.
    killSignal: "SIGKILL",
  });

  if (child.status === 0) {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    return { kind: "ran", note: `setup script ${script} ok (${seconds}s)` };
  }
  const detail = failureDetail(child, timeoutMs);
  return { kind: "failed", note: `setup script ${script} failed — ${detail}`, detail };
}

// ---------- privilege drop (#196) ----------
//
// Root belongs to setup, never to the job. The runner image starts the
// container as root so the operator-authored setup.script (manifest-declared,
// laptop trust class) can install system packages; the runner calls
// dropPrivileges the moment no root work remains, and the pickup gate, the
// harness, and the settle all run as the unprivileged job user. The harness is
// the least trusted code Fleet runs (#155) and must never see uid 0.

/** The unprivileged job identity: uid/gid 1000 — `node` in the runner base. */
const JOB_UID = 1000;
const JOB_GID = 1000;

type DropPrivilegesOutcome =
  /** Not root — the process provider's host, an old base image, a test. */
  | { kind: "skipped" }
  | { kind: "dropped"; note: string }
  /** Root, but the drop did not complete. Continuing would run the job as
   *  root — the caller must treat this like a failed setup and abort. */
  | { kind: "failed"; note: string; detail: string };

/**
 * Point HOME (and USER/LOGNAME) at the new identity's home. The harness
 * writes its config under $HOME, and inheriting root's is both unwritable
 * after the drop and the wrong trust domain. A bare setup.image may lack a
 * passwd entry for the job uid — fall back to a directory inside the
 * workspace, which the caller just chowned to the job user.
 */
function rehome(workspace: string): void {
  let info: { homedir: string; username: string } | undefined;
  try {
    info = userInfo();
  } catch {
    // No passwd entry for the job uid.
  }
  const home = info?.homedir ?? join(workspace, ".fleet", "home");
  if (info === undefined) mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  if (info !== undefined) {
    process.env.USER = info.username;
    process.env.LOGNAME = info.username;
  } else {
    // A stale USER=root is worse than an absent one.
    delete process.env.USER;
    delete process.env.LOGNAME;
  }
}

/**
 * Irreversibly drop from root to the unprivileged job user. No-op when the
 * process is not root. Everything created while root — the materialised
 * .fleet files, the clone — is chowned to the job user first, so the job owns
 * every file it will touch.
 */
export function dropPrivileges(workspace: string): DropPrivilegesOutcome {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return { kind: "skipped" };
  }
  try {
    const chown = spawnSync("chown", ["-R", `${JOB_UID}:${JOB_GID}`, workspace], {
      encoding: "utf8",
    });
    if (chown.status !== 0) {
      throw new Error(`chown -R ${JOB_UID}:${JOB_GID} ${workspace}: ${failureDetail(chown, 0)}`);
    }
    // Order matters: supplementary groups and gid while still root, uid last —
    // after setuid there is no way back, which is the point.
    process.setgroups?.([JOB_GID]);
    process.setgid?.(JOB_GID);
    process.setuid?.(JOB_UID);
    if (process.getuid() !== JOB_UID) {
      throw new Error(`setuid(${JOB_UID}) left the process at uid ${process.getuid()}`);
    }
    rehome(workspace);
    return { kind: "dropped", note: `privileges dropped: job continues as uid ${JOB_UID}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "failed", note: `privilege drop failed — ${detail}`, detail };
  }
}
