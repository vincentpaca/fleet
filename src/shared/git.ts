/**
 * The one way core asks git a question.
 *
 * Every caller wants the same thing — one line of stdout, or nothing when git
 * cannot answer — and three copies of that had drifted apart (`fleet setup
 * infra`'s module-source pin, `delegate`'s remote resolution, the cockpit's
 * header strip). A failed git call is never fatal here: the caller decides what
 * an absent answer means, because "not a repo" and "no such remote" are
 * ordinary states, not errors.
 */
import { spawnSync } from 'node:child_process';

/** git stdout, trimmed, or undefined on any failure or empty output. */
export function gitValue(args: string[], cwd?: string): string | undefined {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  const out = res.status === 0 ? res.stdout.trim() : '';
  return out === '' ? undefined : out;
}

/**
 * Executes a gh CLI subcommand, returning stdout; throws on any failure.
 * The one seam both sides inject in tests instead of spawning a real gh
 * (#128 — it used to be defined twice). Sync on purpose: the runner's PR
 * plumbing (src/runner/git.ts) blocks nothing but its own job. The daemon
 * uses GhRunnerAsync instead — see below.
 */
export type GhRunner = (args: string[]) => string;

/**
 * The async variant of GhRunner (#117), for callers that share an event loop
 * with other work. The daemon's rung verification (src/daemon/verify.ts) runs
 * gh — a network call — off the event intake path; a synchronous gh there
 * froze every listener (/health, other runners' POSTs) for the whole
 * round-trip. Same contract as GhRunner: resolves to stdout, rejects on any
 * failure.
 */
export type GhRunnerAsync = (args: string[]) => Promise<string>;
