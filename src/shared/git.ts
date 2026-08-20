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
