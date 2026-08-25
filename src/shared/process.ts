/**
 * Child-process signalling shared by everything that spawns a launcher.
 *
 * Two places need it and they need the same thing: the runner's harness (a
 * shell that forks the real CLI) and `fleet connect`'s port-forward (`aws ssm
 * start-session`, which forks session-manager-plugin — the process that
 * actually binds the local port). Signalling only the parent leaves the
 * descendant running, and in connect's case still holding the port, so the next
 * attempt looks like it worked while forwarding into a container that is gone.
 */

import { execFileSync } from "node:child_process";

/** Is a pid still alive? Signal 0 probes without delivering. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The OS-reported start time of a process, or null when the pid is gone (or
 * `ps` cannot answer). A pid alone does not identify a process across time —
 * the OS recycles them — but a (pid, start time) pair does: anything that
 * remembers a pid across a daemon restart must capture this alongside it and
 * compare before signalling (issue #123).
 *
 * `ps -o lstart=` is the one spelling both darwin and linux print at full,
 * unambiguous precision ("Mon Aug 24 10:00:01 2026"). The string is compared
 * verbatim, never parsed; LC_ALL=C pins the format across daemon restarts so
 * a locale change cannot make every live runner look recycled.
 */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    // `ps` exits non-zero for a pid that no longer exists.
    return null;
  }
}

/**
 * Signal a child's whole process group. The child must have been spawned
 * `detached`, which makes its pid a group leader: the negated pid reaches it and
 * every descendant it forked. Falls back to the child alone when the group is
 * already gone.
 */
export function killTree(
  child: { pid?: number; kill(signal: NodeJS.Signals): boolean },
  signal: NodeJS.Signals,
): void {
  try {
    if (child.pid === undefined) return;
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already reaped; nothing left to signal.
    }
  }
}
