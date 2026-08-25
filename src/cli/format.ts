/**
 * Fleet event formatting for the CLI renderer (fleet logs / fleet attach).
 *
 * Split from main.ts so tests can import without triggering the CLI entry point.
 */

import { pickPrimaryArg, TERSE_RESULT_MAX } from '../shared/tool-text.ts';

export type FleetEvent = {
  seq: number;
  type: string;
  state?: string;
  reason?: string;
  marker?: string;
  text?: string;
  value?: number;
  id?: string;
  question?: string;
  options?: Array<{ id: string; label?: string; recommended?: boolean }>;
  decision?: string;
  option?: string;
  by?: string;
  rung?: string;
  minutes?: number;
  report?: { status?: string; next_action?: string };
};

// ANSI helpers — gated on noColor. Stdout pipe ⇒ no TTY ⇒ no color.
const RESET = '\x1b[0m';
function ansiCode(...codes: number[]): string {
  return `\x1b[${codes.join(';')}m`;
}
function makeStyledText(noColor: boolean): (text: string, ...codes: number[]) => string {
  return (text, ...codes) => (noColor ? text : `${ansiCode(...codes)}${text}${RESET}`);
}

/**
 * Detect whether color output should be suppressed: NO_COLOR env var, non-TTY
 * stdout, or TERM=dumb all disable color. Accepts an env map so tests can
 * inject overrides without touching process.env.
 */
export function logsNoColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  return !isTTY || env.NO_COLOR !== undefined || env.TERM === 'dumb';
}

/**
 * Compact a log event's text for the `--tools` view.
 *
 * Since #50 the runner's translator already emits terse tool lines, so the
 * JSON branch below only ever fires on logs persisted by an older runner —
 * the events of a retained job outlive the build that wrote them. New text
 * has no `: <json>` to parse and falls through unchanged.
 *
 * tool_use Read: {"file_path":"/p"} → tool_use Read file_path=/p
 * tool_result toolu_01: <body>      → tool_result toolu_01 (N bytes)
 */
/** Format a legacy tool_use log line, or return unchanged if not parseable. */
function formatToolUse(text: string): string {
  const colonIdx = text.indexOf(': ');
  if (colonIdx === -1) return text;
  const namepart = text.slice('tool_use '.length, colonIdx); // e.g. "Read"
  const jsonPart = text.slice(colonIdx + 2);
  try {
    const parsed: unknown = JSON.parse(jsonPart);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an input object');
    // Same priority order the translator renders with — one list, shared.
    const arg = pickPrimaryArg(parsed as Record<string, unknown>, 120);
    return arg ? `tool_use ${namepart} ${arg.key}=${arg.value}` : `tool_use ${namepart}`;
  } catch {
    return text; // Not valid JSON — return raw.
  }
}

/** Format a tool_result log line, or return unchanged when short enough to keep. */
function formatToolResult(text: string): string {
  const colonIdx = text.indexOf(': ');
  if (colonIdx === -1) return text;
  const idpart = text.slice('tool_result '.length, colonIdx);
  const body = text.slice(colonIdx + 2);
  // Only a raw dump gets traded for a byte count. Since #50 the translator
  // emits a one-line summary within TERSE_RESULT_MAX; replacing that with
  // "(42 bytes)" would hide the summary AND misreport the output's real
  // size — and on a failed call the summary is the whole diagnosis.
  if (body.length > TERSE_RESULT_MAX || body.includes('\n')) {
    return `tool_result ${idpart} (${body.length} bytes)`;
  }
  return text;
}

export function formatLogText(text: string): string {
  if (text.startsWith('tool_use ')) return formatToolUse(text);
  if (text.startsWith('tool_result ')) return formatToolResult(text);
  return text;
}

/**
 * Return true when the event belongs in the narrative spine (default logs view).
 * Narrative = state, phase, think, decision, answer, settle + log lines that are
 * NOT tool_use/tool_result. With tools=true, tool lines are included too.
 * progress/pair/agent are always omitted — they're operational noise.
 */
export function isNarrativeEvent(event: FleetEvent, tools: boolean): boolean {
  if (event.type === 'progress' || event.type === 'pair' || event.type === 'agent') return false;
  if (event.type === 'log') {
    const text = event.text ?? '';
    const isToolLine = text.startsWith('tool_use ') || text.startsWith('tool_result ');
    return tools || !isToolLine;
  }
  return true;
}

/**
 * State with its qualifier for job listings: the marker on blocked
 * (parked/stale), the cancellation reason on cancelled — `cancelled(stall)`
 * reads differently from `cancelled(wall-clock)`, and that difference is the
 * whole diagnosis. Shared by `fleet status` and the board.
 */
export function formatJobState(job: { state: string; marker?: string; reason?: string }): string {
  const qualifier = job.marker ?? (job.state === 'cancelled' ? job.reason : undefined);
  return typeof qualifier === 'string' && qualifier !== '' ? `${job.state}(${qualifier})` : job.state;
}

/** Format one persisted Fleet event for human display. Never throws. */
export function formatEvent(event: FleetEvent, noColor: boolean): string {
  const col = makeStyledText(noColor);
  const head = `[${event.seq}] ${event.type}`;
  switch (event.type) {
    case 'state': {
      const extras = [event.reason && `reason=${event.reason}`, event.marker && `marker=${event.marker}`]
        .filter(Boolean)
        .join(' ');
      const body = `→ ${event.state}${extras ? ` ${extras}` : ''}`;
      return col(`${head} ${body}`, 1); // bold
    }
    case 'phase':
      return `${head} ${event.text ?? ''}`;
    case 'think':
      return col(`${head} ${event.text ?? ''}`, 2); // dim
    case 'log':
      return `${head} ${formatLogText(event.text ?? '')}`;
    case 'progress':
      return `${head} ${Math.round((event.value ?? 0) * 100)}%`;
    case 'decision': {
      const options = (event.options ?? [])
        .map((o) => `  - ${o.id}${o.recommended ? ' (recommended)' : ''}${o.label ? `: ${o.label}` : ''}`)
        .join('\n');
      const body = `${head} ${event.id}: ${event.question}\n${options}\n  answer with: fleet answer <jobId> --option <id> [--text s]`;
      return col(body, 33); // yellow
    }
    case 'answer':
      return `${head} ${event.decision} → ${event.option ?? '(free text)'}${event.text ? ` "${event.text}"` : ''}${event.by ? ` by ${event.by}` : ''}`;
    case 'settle': {
      const status = event.report?.status ?? '?';
      const body = `${head} rung=${event.rung ?? '?'} status=${status}${event.report?.next_action ? ` next: ${event.report.next_action}` : ''}`;
      // Green for success (READY), red for failure (PARTIAL/FAILED/etc.).
      const code = status === 'READY' ? 32 : 31;
      return col(body, code);
    }
    default:
      return `${head} ${JSON.stringify({ ...event, seq: undefined, type: undefined })}`;
  }
}
