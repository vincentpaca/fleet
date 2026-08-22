/**
 * How a tool call and its result read in an event log — the budgets and the
 * argument priority, in one place.
 *
 * Two consumers that must agree: the runner's translator, which renders a
 * live `tool_use`/`tool_result` block into event text, and the CLI's log
 * compactor (`formatLogText`), which decides whether a persisted line is
 * already a summary or a pre-#50 raw dump. Two copies of these numbers drift,
 * and the drift is invisible until an operator reads a log and finds the one
 * line they needed replaced by a byte count.
 */

/**
 * Ordered by evidence value: what the agent actually did comes before what it
 * said it was doing. `description`/`prompt` are last on purpose — for Bash the
 * command is the evidence and the description is a paraphrase.
 */
const PRIMARY_ARG_KEYS = [
  'command',
  'file_path',
  'pattern',
  'path',
  'url',
  'query',
  // Last two: a paraphrase of the work, useful only when nothing above exists
  // (Task carries a short description and a page-long prompt — take the label).
  'description',
  'prompt',
] as const;

/** A tool call renders as one line: name plus one clipped argument. */
export const MAX_TOOL_ARG = 200;
/** A tool result renders as its first meaningful line… */
export const MAX_RESULT_LINE = 240;
/** …unless it failed, in which case the operator needs the whole complaint. */
export const MAX_RESULT_ERROR = 800;

/**
 * The widest tool_result body the translator can emit: the error budget plus
 * room for the ellipsis and the ` (+N lines)` tail. Anything longer than this,
 * or spanning lines, is a pre-#50 raw dump rather than a summary — which is
 * how `formatLogText` tells the two apart without guessing at a magic number.
 */
export const TERSE_RESULT_MAX = MAX_RESULT_ERROR + 40;

/**
 * Pick the one argument worth rendering, clipped. Returns `{key, value}` from
 * the first priority key holding a non-empty string; falls back to the first
 * own key that holds a string. Returns null when there is nothing to show —
 * a non-string fallback is payload, not evidence, and stays out of the log.
 */
export function pickPrimaryArg(
  input: Record<string, unknown>,
  maxLen: number,
): { key: string; value: string } | null {
  for (const key of PRIMARY_ARG_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return { key, value: clipArg(value, maxLen) };
  }
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return { key, value: clipArg(value, maxLen) };
  }
  return null;
}

/**
 * Clip to maxLen and flatten newlines: a rendered arg is one line by
 * construction, so a multi-line heredoc cannot become forty log lines.
 */
export function clipArg(value: string, maxLen: number): string {
  const oneLine = value.replace(/\s*\n\s*/g, ' ⏎ ').trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}
