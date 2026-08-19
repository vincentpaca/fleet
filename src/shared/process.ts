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
