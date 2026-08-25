/**
 * Fleet event rendering — the one switch over the event vocabulary (#128).
 *
 * Two surfaces show events, in two deliberately different conventions:
 *
 * - 'plain' — `fleet logs` / `fleet attach`: one full-width string per event,
 *   whole-line ANSI, decision cards spelled out with the `fleet answer`
 *   incantation (the reader is in a shell, not a pane).
 * - 'pane' — the cockpit drill-down: gray seq prefix, width-clipped lines
 *   (the caller clips), decision questions tracked so an answer can name what
 *   it answered.
 *
 * Both go through renderEvent(): adding an event type or changing how one
 * reads is exactly one case here, with the target conventions side by side —
 * the previous shape (a second switch in board.ts) is the "second
 * event-rendering path" AGENTS.md names a defect. The thin entry points are
 * formatEvent() below and renderEventLines() in ./board.ts.
 *
 * Split from main.ts so tests can import without triggering the CLI entry point.
 */

import { pickPrimaryArg, TERSE_RESULT_MAX } from '../shared/tool-text.ts';
import { optionId, type DecisionOption, type FleetEvent } from '../shared/events.ts';
import { makeCol, type ColFn } from './ansi.ts';

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
 * whole diagnosis. A retried job carries its attempt count (#30):
 * `cancelled(harness-exit) [attempt 2]` failed twice and needs an operator,
 * which must never look like a job that failed once. Shared by `fleet status`
 * and the board.
 */
export function formatJobState(job: { state: string; marker?: string; reason?: string; attempt?: number }): string {
  const qualifier = job.marker ?? (job.state === 'cancelled' ? job.reason : undefined);
  const base = typeof qualifier === 'string' && qualifier !== '' ? `${job.state}(${qualifier})` : job.state;
  return typeof job.attempt === 'number' && job.attempt > 1 ? `${base} [attempt ${job.attempt}]` : base;
}

// ── The rendering core ────────────────────────────────────────────────────────

/**
 * Where an event is being rendered to. 'pane' carries the pending-decisions
 * map (decision id → question) so an answer line can name its question; the
 * caller owns the map's lifetime — one per tail, threaded through every event
 * in order. Width is the caller's concern too: pane lines come back unclipped.
 */
export type RenderTarget =
  | { kind: 'plain'; col: ColFn }
  | { kind: 'pane'; col: ColFn; pending: Map<string, string> };

/** Plain-line head: seq and type, the way `fleet logs` prints every event. */
function plainHead(ev: FleetEvent): string {
  return `[${ev.seq}] ${ev.type}`;
}

/** Pane prefix: the seq alone, dimmed — the pane shows type by shape, not name. */
function panePrefix(ev: FleetEvent, col: ColFn): string {
  return col(`[${ev.seq}]`, 90);
}

/** Pane body line for think/log: dim text after the seq prefix. */
function paneText(ev: FleetEvent, col: ColFn): string {
  return `${panePrefix(ev, col)} ${col(ev.text ?? '', 90)}`;
}

function renderState(ev: FleetEvent, t: RenderTarget): string[] {
  if (t.kind === 'plain') {
    const extras = [
      ev.reason && `reason=${ev.reason}`,
      ev.marker && `marker=${ev.marker}`,
      ev.attempt !== undefined && `attempt=${ev.attempt}`,
    ]
      .filter(Boolean)
      .join(' ');
    const body = `→ ${ev.state}${extras ? ` ${extras}` : ''}`;
    return [t.col(`${plainHead(ev)} ${body}`, 1)]; // bold
  }
  const c = ev.state === 'blocked' ? 33 : ev.state === 'running' ? 32 : 90;
  return [`${panePrefix(ev, t.col)} ${t.col('→', 90)} ${t.col(ev.state ?? '', c)}`];
}

function renderPhase(ev: FleetEvent, t: RenderTarget): string[] {
  if (t.kind === 'plain') return [`${plainHead(ev)} ${ev.text ?? ''}`];
  return [`${panePrefix(ev, t.col)} ${t.col('phase', 90)} ${t.col(ev.text ?? '', 90)}`];
}

function renderThink(ev: FleetEvent, t: RenderTarget): string[] {
  if (t.kind === 'plain') return [t.col(`${plainHead(ev)} ${ev.text ?? ''}`, 2)]; // dim
  return [paneText(ev, t.col)];
}

function renderLog(ev: FleetEvent, t: RenderTarget): string[] {
  // Plain compacts legacy tool lines; the pane shows the raw text and lets
  // the caller's width clipping bound it instead.
  if (t.kind === 'plain') return [`${plainHead(ev)} ${formatLogText(ev.text ?? '')}`];
  return [paneText(ev, t.col)];
}

function renderProgress(ev: FleetEvent, t: RenderTarget): string[] {
  // The pane never renders a percentage — progress shows as a bare type line.
  if (t.kind === 'plain') return [`${plainHead(ev)} ${Math.round((ev.value ?? 0) * 100)}%`];
  return renderOther(ev, t);
}

/**
 * A decision, as a card — the schema's question and every option, verbatim and
 * never summarised: the operator answers what the job actually asked (D8).
 * Each target states how to answer it, in place: a question on screen with no
 * visible way to send an answer reads as a dead end.
 */
function renderDecision(ev: FleetEvent, t: RenderTarget): string[] {
  const options = ev.options ?? [];
  if (t.kind === 'plain') {
    const optionLines = options
      .map((o) => `  - ${o.id}${o.recommended ? ' (recommended)' : ''}${o.label ? `: ${o.label}` : ''}`)
      .join('\n');
    const body = `${plainHead(ev)} ${ev.id}: ${ev.question}\n${optionLines}\n  answer with: fleet answer <jobId> --option <id> [--text s]`;
    return [t.col(body, 33)]; // yellow
  }
  if (!ev.id) return [];
  const col = t.col;
  const question = ev.question ?? '';
  t.pending.set(ev.id, question);
  const out = [`${panePrefix(ev, col)} ${col('?', 1, 33)} ${col(question, 1)}`];
  out.push(...paneOptionLines(options, col));
  out.push('     ' + col('answer: type an option id below — ' + options.map(optionId).join(' | '), 33));
  return out;
}

/** The per-option lines of a pane decision card (★ on the recommended one). */
function paneOptionLines(options: DecisionOption[], col: ColFn): string[] {
  return options.map((opt) => {
    const rec = opt.recommended ? col(' ★', 33) : '';
    return '     ' + col('[' + opt.id + ']', 33) + ' ' + (opt.label ?? opt.id) + rec;
  });
}

function renderAnswer(ev: FleetEvent, t: RenderTarget): string[] {
  if (t.kind === 'plain') {
    return [
      `${plainHead(ev)} ${ev.decision} → ${ev.option ?? '(free text)'}${ev.text ? ` "${ev.text}"` : ''}${ev.by ? ` by ${ev.by}` : ''}`,
    ];
  }
  return [paneAnswerLine(ev, t.col, t.pending)];
}

/** Pane answer line, naming the question it answered when it is still pending. */
function paneAnswerLine(ev: FleetEvent, col: ColFn, pending: Map<string, string>): string {
  const dec = ev.decision ? pending.get(ev.decision) : undefined;
  const qText = dec ? col('"' + dec + '"', 90) : '';
  const ansText = ev.option ? col('[' + ev.option + ']', 32) : col('(free text)', 90);
  const byText = ev.by ? col(' by ' + ev.by, 90) : '';
  if (ev.decision) pending.delete(ev.decision);
  const prefix = panePrefix(ev, col);
  return qText
    ? prefix + ' ' + col('✓', 32) + ' ' + qText + ' → ' + ansText + byText
    : prefix + ' ' + col('✓', 32) + ' answer: ' + ansText + byText;
}

function renderSettle(ev: FleetEvent, t: RenderTarget): string[] {
  const status = ev.report?.status ?? '?';
  if (t.kind === 'plain') {
    const body = `${plainHead(ev)} rung=${ev.rung ?? '?'} status=${status}${ev.report?.next_action ? ` next: ${ev.report.next_action}` : ''}`;
    // Green for success (READY), red for failure (PARTIAL/FAILED/etc.).
    return [t.col(body, status === 'READY' ? 32 : 31)];
  }
  const col = t.col;
  return [`${panePrefix(ev, col)} ${col('settle', 36)} rung=${col(ev.rung ?? '?', 36)} status=${col(status, 36)}`];
}

/** An unknown event type still renders as a line rather than disappearing. */
function renderOther(ev: FleetEvent, t: RenderTarget): string[] {
  if (t.kind === 'plain') return [`${plainHead(ev)} ${JSON.stringify({ ...ev, seq: undefined, type: undefined })}`];
  return [`${panePrefix(ev, t.col)} ${t.col(ev.type, 90)}`];
}

/**
 * Render one event for a target. The only switch over the event vocabulary:
 * a new event type is one case here, with both conventions in its renderer.
 */
export function renderEvent(event: FleetEvent, target: RenderTarget): string[] {
  switch (event.type) {
    case 'state': return renderState(event, target);
    case 'phase': return renderPhase(event, target);
    case 'think': return renderThink(event, target);
    case 'log': return renderLog(event, target);
    case 'progress': return renderProgress(event, target);
    case 'decision': return renderDecision(event, target);
    case 'answer': return renderAnswer(event, target);
    case 'settle': return renderSettle(event, target);
    default: return renderOther(event, target);
  }
}

/** Format one persisted Fleet event for human display (plain-line). Never throws. */
export function formatEvent(event: FleetEvent, noColor: boolean): string {
  return renderEvent(event, { kind: 'plain', col: makeCol(noColor) }).join('\n');
}
