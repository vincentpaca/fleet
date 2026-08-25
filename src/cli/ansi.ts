/**
 * ANSI styling for the CLI, single-sourced (#128): the col() closure and the
 * visual width/clip helpers used by every surface that draws to a terminal —
 * the plain-line event formatter (./format.ts), the board renderers
 * (./board.ts) and the cockpit (./cockpit.ts). The same closure used to live
 * in two of those files character-for-character.
 *
 * Zero dependencies: hand-rolled ANSI; erasable TS only.
 */

const RESET = '\x1b[0m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function ansi(...codes: number[]): string {
  return `\x1b[${codes.join(';')}m`;
}

/** Build a col() helper bound to a specific noColor flag. */
export function makeCol(noColor: boolean): (text: string, ...codes: number[]) => string {
  return (text, ...codes) => noColor ? text : `${ansi(...codes)}${text}${RESET}`;
}

/** Type alias for the col() helper so it can be used in parameter position
 *  without the inline function type that Lizard misparses as a nested function. */
export type ColFn = ReturnType<typeof makeCol>;

/** Visible width of a string: ANSI escape sequences occupy no columns. */
export function visualLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/**
 * Clip a string (which may contain ANSI codes) to at most maxLen visible
 * characters, appending '…' if truncated. Resets open ANSI sequences only
 * when the clipped portion contained any escape codes.
 */
export function visualClip(s: string, maxLen: number): string {
  if (visualLength(s) <= maxLen) return s;
  let out = '';
  let vLen = 0;
  const target = maxLen - 1;
  let i = 0;
  let hasAnsi = false;
  while (i < s.length) {
    // Copy ANSI escape sequences without counting them as visible characters.
    if (s[i] === '\x1b' && i + 1 < s.length && s[i + 1] === '[') {
      const end = s.indexOf('m', i + 2);
      if (end !== -1) {
        out += s.slice(i, end + 1);
        i = end + 1;
        hasAnsi = true;
        continue;
      }
    }
    if (vLen >= target) break;
    out += s[i];
    vLen++;
    i++;
  }
  return `${out}…${hasAnsi ? RESET : ''}`;
}
