/**
 * The cockpit — `fleet` on a terminal (issue #61).
 *
 * Operating Fleet used to be three windows: a shell to dispatch from, a board to
 * watch, and a hand-rebuilt port-forward whose death showed up as ECONNREFUSED
 * at the next dispatch. This is one resident surface instead: the live board
 * with a command line under it, and the tunnel held for as long as the view is
 * open. Logs are never on the board — a tail pane that streams uninvited turns
 * the operating surface into a firehose (operator feedback, first live run).
 * Events appear only in the drill-down the operator enters on purpose (Enter),
 * where the board is deliberately replaced and the tail is windowed to the
 * screen.
 *
 * What it is not, deliberately:
 *   - Not a harness (D8). No model call, no conversation, no agent loop. A
 *     decision renders as the schema's own question and options, verbatim, and
 *     is never answered by anything but a human keystroke.
 *   - Not a lifeline (D7). Closing it changes nothing about running jobs; it
 *     only drops a tunnel the cockpit itself opened.
 *   - Not a second client. It reads the same events and posts to the same answer
 *     API as every other command; the daemon does not know it exists. Anything
 *     the cockpit cannot do through that contract is a gap in the contract.
 *
 * The model, layout, key and command-line sections below are pure — a frame is a
 * string built from a model, and a keystroke or a typed line maps to an action
 * without touching the world — so the layout, the key precedence and the command
 * grammar are all tested without a terminal. The resident-loop section owns
 * everything else: the interval, the sockets, the child process, the screen.
 */
import {
  ENTER_ALT,
  RESTORE_SEQ,
  clampTailScroll,
  detectColorLevel,
  decisionCardLines,
  fetchBoardJobs,
  followJobEvents,
  invalidateDecision,
  jobCounts,
  parseAnswerLine,
  renderBanner,
  renderContextStrip,
  renderEventLines,
  renderJobLine,
  renderRosterRows,
  renderTableHeader,
  sortJobs,
  answerJob,
  cancelJob,
  type BoardJob,
  type ContextInfo,
  type FrameOpts,
  type RosterRow,
} from './board.ts';
import { makeCol, visualClip, visualLength } from './ansi.ts';
import type { FleetEvent, PendingDecision } from '../shared/events.ts';
import { gitValue } from '../shared/git.ts';
import { LOOPBACK_HOSTS, daemonHealthy, daemonTarget, describeTarget, fleetConfigFiles } from './client.ts';
import { logsNoColor } from './format.ts';
import { holdTunnel, portAccepts, resolveTunnel, tunnelReport, type HeldTunnel } from './connect.ts';

// ── Model ─────────────────────────────────────────────────────────────────────

/** Who owns the tunnel this cockpit's daemon address is reached through. */
export type TunnelStatus =
  | { kind: 'none' }                    // a unix socket: there is no tunnel to own
  | { kind: 'probing' }
  | { kind: 'adopted' }                 // someone else's, healthy — never ours to close
  | { kind: 'owned'; port: number }     // ours, and it dies with this view
  | { kind: 'failed'; why: string };

/** Board (stacked panes) or one job expanded. */
export type CockpitView = 'board' | 'job';

/**
 * Everything a frame is drawn from. Held by `runCockpit`, mutated only there,
 * and passed to `renderCockpit` as data — no getters, no callbacks, no clock.
 */
export type CockpitModel = {
  /** Jobs in board order (`sortJobs`): blocked, then live, then settled. */
  jobs: BoardJob[];
  /** Index into `jobs`; -1 when the board is empty and there is nothing to select. */
  selection: number;
  view: CockpitView;
  /** The selected job's events, oldest first. */
  tail: FleetEvent[];
  /** Lines scrolled back from the end of the tail; 0 follows the tail. */
  tailScroll: number;
  /** What the operator has typed but not submitted. */
  input: string;
  /** Transient notice, shown where the key hints go. */
  status?: string;
  /** A destructive act waiting on y/N. */
  confirm?: string;
  tunnel: TunnelStatus;
};

/** The selected job, or undefined when the board is empty. */
export function selectedJob(m: CockpitModel): BoardJob | undefined {
  return m.selection >= 0 ? m.jobs[m.selection] : undefined;
}

/**
 * Option ids the selected job is waiting on, if any. This is what makes a bare
 * `keep` at the input line an answer rather than a dispatch, so it is read from
 * the job's own open decision and nothing else.
 */
export function openOptionIds(m: CockpitModel): string[] {
  const job = selectedJob(m);
  if (!job || job.state !== 'blocked' || !job.decision) return [];
  return job.decision.options.map((o) => o.id);
}

// ── Layout ────────────────────────────────────────────────────────────────────

/**
 * Narrower than this and the table columns stop meaning anything; lines clip
 * rather than wrap, because a wrapped line breaks every row below it.
 */
export const MIN_COLUMNS = 40;

/** The banner is the product's face, but not at the cost of the panes. */
export const BANNER_MIN_ROWS = 22;

/** Key hints, and the raw keys that must reach a handler for each. Parity is tested. */
export const COCKPIT_FOOTER_KEYS: Array<{ label: string; rawKeys: string[] }> = [
  { label: '↑↓ select', rawKeys: ['\x1b[A', '\x1b[B', 'k', 'j'] },
  { label: 'enter open', rawKeys: ['\r', '\n'] },
  { label: 'esc back', rawKeys: ['\x1b'] },
  { label: 'tab complete', rawKeys: ['\t'] },
  { label: '^p hist', rawKeys: ['\x10', '\x0e'] },
  { label: 'pgup scroll', rawKeys: ['\x1b[5~', '\x1b[6~'] },
  { label: '^c quit', rawKeys: ['\x03'] },
];

/** The prompt the input line is typed at. */
const PROMPT = '› ';

/**
 * Flatten roster rows into at most `budget` lines, keeping the selected job's
 * own rows on screen. Scrolling is by job, never mid-job: a decision card cut
 * away from its question is worse than a shorter list.
 */
export function windowRosterRows(rows: RosterRow[], selection: number, budget: number): string[] {
  if (budget <= 0) return [];
  const target = Math.max(0, Math.min(selection, rows.length - 1));
  // One running sum, shrunk as the window slides: re-summing rows[start..target]
  // per iteration made this O(n²) in job count per frame (#125).
  let span = 0;
  for (let i = 0; i <= target; i++) span += rows[i]?.lines.length ?? 0;
  let start = 0;
  while (start < target && span > budget) {
    span -= rows[start].lines.length;
    start += 1;
  }
  return rows.slice(start).flatMap((r) => r.lines).slice(0, budget);
}

/** Pad or trim a block of lines to exactly `n` lines. */
function exactly(lines: string[], n: number): string[] {
  const out = lines.slice(0, n);
  while (out.length < n) out.push('');
  return out;
}

/**
 * The tail window: `scroll` lines back from the end, clamped. scroll=0 follows,
 * which is what a live view has to do by default — the operator scrolls back
 * deliberately, and PgDn to the bottom re-sticks.
 */
export function windowTail(lines: string[], scroll: number, budget: number): string[] {
  if (budget <= 0) return [];
  const maxScroll = Math.max(0, lines.length - budget);
  const back = Math.max(0, Math.min(scroll, maxScroll));
  const end = lines.length - back;
  return exactly(lines.slice(Math.max(0, end - budget), end), budget);
}

/** The bottom line: a pending confirmation, or the command prompt with its cursor. */
function renderInputLine(m: CockpitModel, w: number, noColor: boolean): string {
  const col = makeCol(noColor);
  if (m.confirm !== undefined) return visualClip(`${col(m.confirm, 1, 33)} [y/N] `, w);
  // Keep the caret visible on a long line by showing the tail of the input.
  const room = Math.max(8, w - PROMPT.length - 1);
  const shown = m.input.length > room ? m.input.slice(m.input.length - room) : m.input;
  return visualClip(`${col(PROMPT, 36)}${shown}_`, w);
}

/** Key hints, or the transient status that displaces them. */
function renderFooter(m: CockpitModel, w: number, noColor: boolean): string {
  const col = makeCol(noColor);
  if (m.status !== undefined) return visualClip(`  ${col(m.status, 33)}`, w);
  return visualClip(col(`  ${COCKPIT_FOOTER_KEYS.map((k) => k.label).join('  ')}`, 90), w);
}

/**
 * The tail pane: the selected job's events, windowed to `budget` lines.
 *
 * Only the events that can reach the window are rendered. A resident view holds
 * thousands, redraws several times a second, and shows a dozen lines — rendering
 * the whole buffer each frame is work nobody sees. `slack` covers events that
 * render as more than one line (a decision card), so the window is always full.
 */
function renderTailPane(m: CockpitModel, w: number, noColor: boolean, budget: number): string[] {
  if (budget <= 0) return [];
  const reachable = budget + m.tailScroll + 8;
  const events = m.tail.length > reachable ? m.tail.slice(m.tail.length - reachable) : m.tail;
  return windowTail(renderEventLines(events, w, noColor), m.tailScroll, budget);
}

/**
 * Render the whole cockpit as exactly `height` lines, each at most `width` wide.
 *
 * Pure: the same model renders the same frame, so every layout rule here — the
 * pane split, what the banner costs, what a short terminal drops first — is
 * asserted in tests rather than eyeballed.
 *
 * Chrome is dropped from the outside in as the terminal shrinks, and the frame is
 * always exactly as tall as the terminal: writing more lines than there are rows
 * scrolls the screen, which is the one thing a full-screen view must never do.
 */
/** Render the drill-down (job) view: one job's tail, context strip, decision card. */
function renderJobView(
  m: CockpitModel, w: number, h: number, counts: ReturnType<typeof jobCounts>,
  foot: string[], opts: FrameOpts, noColor: boolean,
): string {
  const job = selectedJob(m);
  const strip = h >= 6
    ? renderContextStrip(
        counts.blocked, counts.running, counts.done, w, opts,
        job ? renderJobLine(job, { ...opts, noColor }) : 'no job selected',
      ).split('\n')
    : [];
  // A blocked job's open decision is pinned above the input line, not left
  // to scroll: the question was unfindable under a long transcript, and the
  // one thing a blocked drill-down must say is what it needs from the human.
  // Skipped only when the terminal is too short to fit it at all.
  const pinned = job?.state === 'blocked' && job.decision
    ? decisionCardLines(job.decision, w, noColor)
    : [];
  const card = h - strip.length - foot.length - pinned.length >= 0 ? pinned : [];
  const body = renderTailPane(m, w, noColor, h - strip.length - card.length - foot.length);
  return [...strip, ...body, ...card, ...foot].join('\n');
}

/**
 * Render the board view: banner + context strip + table header + job roster.
 * No tail here — logs stream only in the drill-down the operator opens on purpose.
 */
function renderBoardView(
  m: CockpitModel, w: number, h: number, counts: ReturnType<typeof jobCounts>,
  foot: string[], opts: FrameOpts, noColor: boolean,
): string {
  const col = makeCol(noColor);
  const banner = h >= BANNER_MIN_ROWS ? renderBanner(w, noColor, opts.colorLevel ?? '256').split('\n') : [];
  const strip = h >= 6 ? renderContextStrip(counts.blocked, counts.running, counts.done, w, opts).split('\n') : [];
  const tableHeader = h >= 9 ? renderTableHeader(w, noColor).split('\n') : [];
  const head = [...banner, ...strip, ...tableHeader];
  const avail = h - head.length - foot.length;
  const rows = renderRosterRows(m.jobs, m.selection, w, opts);
  const roster = m.jobs.length === 0
    ? exactly([col('  no jobs — dispatch one from the line below: delegate <target>', 90)], avail)
    : exactly(windowRosterRows(rows, m.selection, avail), avail);
  return [...head, ...roster, ...foot].join('\n');
}

/**
 * Pure: the same model renders the same frame, so every layout rule here — the
 * pane split, what the banner costs, what a short terminal drops first — is
 * asserted in tests rather than eyeballed.
 *
 * Chrome is dropped from the outside in as the terminal shrinks, and the frame is
 * always exactly as tall as the terminal: writing more lines than there are rows
 * scrolls the screen, which is the one thing a full-screen view must never do.
 */
export function renderCockpit(
  m: CockpitModel,
  width: number,
  height: number,
  opts: FrameOpts = {},
): string {
  const w = Math.max(MIN_COLUMNS, width);
  const h = Math.max(1, height);
  const noColor = opts.noColor ?? false;
  const counts = jobCounts(m.jobs);
  const input = renderInputLine(m, w, noColor);
  if (h === 1) return input;
  const foot = [renderFooter(m, w, noColor), input];
  if (m.view === 'job') return renderJobView(m, w, h, counts, foot, opts, noColor);
  return renderBoardView(m, w, h, counts, foot, opts, noColor);
}

// ── Keys ──────────────────────────────────────────────────────────────────────

/** How far PgUp/PgDn move the tail. */
export const SCROLL_LINES = 5;

/** What a keystroke means once the model's state is taken into account. */
export type CockpitAction =
  | { kind: 'select'; delta: number }
  | { kind: 'open' }
  | { kind: 'back' }
  | { kind: 'submit' }
  | { kind: 'complete' }
  | { kind: 'history'; delta: number }
  | { kind: 'scroll'; delta: number }
  | { kind: 'insert'; text: string }
  | { kind: 'erase' }
  | { kind: 'clear' }
  | { kind: 'confirm'; yes: boolean }
  | { kind: 'quit' }
  | { kind: 'ignore' };

/** Keys that always produce the same action regardless of model state. */
const STATIC_KEY_ACTIONS: ReadonlyMap<string, CockpitAction> = new Map([
  ['\x03', { kind: 'quit' as const }],         // ^C, always
  ['\t', { kind: 'complete' as const }],
  ['\x7f', { kind: 'erase' as const }],        // DEL
  ['\b', { kind: 'erase' as const }],           // Backspace
  ['\x15', { kind: 'clear' as const }],         // ^U
  ['\x10', { kind: 'history', delta: -1 } as const],  // ^P
  ['\x0e', { kind: 'history', delta: 1 } as const],   // ^N
  ['\x1b[5~', { kind: 'scroll', delta: SCROLL_LINES } as const],   // PgUp: back in time
  ['\x1b[6~', { kind: 'scroll', delta: -SCROLL_LINES } as const],  // PgDn: towards live
]);

/** Resolve confirm-mode keys (y/Y accept, anything else declines). */
function parseConfirmKey(key: string): CockpitAction {
  return key === 'y' || key === 'Y' ? { kind: 'confirm', yes: true } : { kind: 'confirm', yes: false };
}

/**
 * Resolve context-sensitive navigation keys: Enter, arrows, lone ESC. Returns
 * the action, or undefined when the key is not in this set.
 */
function parseContextKey(key: string, inputEmpty: boolean): CockpitAction | undefined {
  if (key === '\r' || key === '\n') return inputEmpty ? { kind: 'open' } : { kind: 'submit' };
  if (key === '\x1b[A') return inputEmpty ? { kind: 'select', delta: -1 } : { kind: 'history', delta: -1 };
  if (key === '\x1b[B') return inputEmpty ? { kind: 'select', delta: 1 } : { kind: 'history', delta: 1 };
  if (key === '\x1b') return inputEmpty ? { kind: 'back' } : { kind: 'clear' };
  return undefined;
}

/** True for a printable character or pasted chunk (no escape bytes). */
function isPrintableKey(key: string): boolean {
  return key.length > 0 && !key.includes('\x1b') && [...key].every((c) => c >= ' ' && c !== '\x7f');
}

/** Navigation letters (j/k) and printable text, respecting option claims. */
function parseNavOrPrintableKey(
  key: string,
  state: { inputEmpty: boolean; optionIds?: string[] },
): CockpitAction {
  // Navigation letters, unless the open decision claims them (see cockpitKeyAction rule 2).
  const claimed = (state.optionIds ?? []).some((id) => id.toLowerCase().startsWith(key));
  if (state.inputEmpty && !claimed) {
    if (key === 'k') return { kind: 'select', delta: -1 };
    if (key === 'j') return { kind: 'select', delta: 1 };
  }
  // Printable text, including a pasted chunk. Unknown escape sequences must
  // never leak into the line as stray letters.
  if (isPrintableKey(key)) return { kind: 'insert', text: key };
  return { kind: 'ignore' };
}

/**
 * Map a raw keystroke to an action. Two things share this keyboard — a job list
 * and a text field — so the precedence is explicit and tested:
 *
 *   1. A pending confirmation takes everything: y/n and nothing else.
 *   2. Printable characters go to the input line, except `j`/`k` on an empty
 *      line, which navigate — no verb starts with either, and an empty line is
 *      the state the operator navigates from. Unless the selected job is waiting
 *      on an option that starts with that letter: then it types, because with a
 *      `keep` on screen a `k` is an answer, not a movement. Arrows navigate
 *      either way, so neither is ever out of reach.
 *   3. ↑/↓ navigate an empty line and walk history a written one; ^p/^n walk
 *      history in both, so the last command is always one keystroke away.
 *   4. Enter submits a written line and expands the selection on an empty one —
 *      the one key that does the obvious thing in both roles.
 *   5. Esc clears a written line and leaves the drill-down on an empty one.
 *
 * `key` is one keystroke as `splitKeys` produces it — a character, or a whole
 * escape sequence. An escape sequence with no meaning here is ignored rather
 * than typed: unknown keys must never leak into the line as stray letters.
 */
export function cockpitKeyAction(
  key: string,
  state: { inputEmpty: boolean; confirming?: boolean; optionIds?: string[] },
): CockpitAction {
  const staticAction = STATIC_KEY_ACTIONS.get(key);
  if (staticAction) return staticAction;
  if (state.confirming) return parseConfirmKey(key);
  if (key === '\x04' && state.inputEmpty) return { kind: 'quit' }; // ^D on an empty line
  const ctxAction = parseContextKey(key, state.inputEmpty);
  if (ctxAction) return ctxAction;
  return parseNavOrPrintableKey(key, state);
}

// ── The command line ──────────────────────────────────────────────────────────

/** The verbs the input line understands. The same ones the CLI has (#36). */
export const COCKPIT_VERBS = ['delegate', 'answer', 'logs', 'attach', 'cancel', 'help', 'quit'];

/** A submitted line, resolved to an intent. Nothing here talks to the daemon. */
export type CockpitCommand =
  | { kind: 'delegate'; target: string; mode?: string }
  | { kind: 'answer'; option?: string; text?: string }
  | { kind: 'cancel'; jobId?: string }
  | { kind: 'focus'; jobId?: string }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'nothing' }
  | { kind: 'error'; message: string };

/** Context passed to {@link parseCockpitInput}: the option ids the selected job is waiting on. */
type ParseCockpitCtx = { optionIds?: string[] };

/** Verb sets to avoid `||` chains that inflate cyclomatic complexity. */
const VERB_HELP = new Set(['help', '?']);
const VERB_QUIT = new Set(['quit', 'exit']);
const VERB_FOCUS = new Set(['logs', 'attach']);
/** Hoisted so that the inline /\s+/ regex does not trigger a Lizard tokeniser misparse. */
const WORDS_RE = /\s+/;

/** Parse the args to `delegate`, extracting an optional `--mode` flag. */
function parseDelegateCommand(rest: string[]): CockpitCommand {
  const args: string[] = [];
  let mode: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--mode') {
      mode = rest[i + 1];
      i += 1;
      if (mode === undefined) return { kind: 'error', message: 'delegate: --mode needs a mode name' };
      continue;
    }
    args.push(rest[i]!);
  }
  const target = args.join(' ');
  if (target === '') return { kind: 'error', message: 'delegate: needs a target — delegate <target> [--mode m]' };
  return mode === undefined ? { kind: 'delegate', target } : { kind: 'delegate', target, mode };
}

/** Parse the args to `answer`. */
function parseAnswerCommand(rest: string[]): CockpitCommand {
  const answer = parseAnswerLine(rest.join(' '));
  if (!answer) return { kind: 'error', message: 'answer: needs an option id, or "text: <free text>"' };
  return { kind: 'answer', ...answer };
}

/** Parse a single-token word as an option id, near-miss verb, or bare delegate. */
function parseCockpitContextual(word: string, trimmed: string, rest: string[], optionIds: string[]): CockpitCommand {
  if (rest.length === 0 && optionIds.includes(word)) return { kind: 'answer', option: word };
  const near = nearVerb(word.toLowerCase());
  if (near !== undefined) {
    return {
      kind: 'error',
      message: `unknown command "${word}" — did you mean ${near}? (to dispatch it as written: delegate ${trimmed})`,
    };
  }
  return { kind: 'delegate', target: trimmed };
}

/**
 * Interpret a submitted line. A palette, not a chat: every line resolves to one
 * of the CLI's own verbs, and the cockpit answers nothing conversationally (D8).
 *
 * Precedence, in order:
 *   1. A known verb wins, always — so behaviour never depends on board state.
 *   2. Otherwise, a single token naming an option the selected job is waiting on
 *      is that answer. Typing `keep` at a blocked job means what it looks like.
 *   3. Otherwise the line is a delegate payload: a target or a symptom
 *      statement, which is exactly what a work order's `target` is for.
 *
 * Rule 3 dispatches real work, so a first word that is a near-miss of a verb is
 * refused instead: `delegat 61` is a typo, not a job about "delegat". That guard
 * has to stay narrow, because English symptom statements start with short words
 * all the time — "a login page 500s", "log the user out and it fails" — and
 * refusing those would break the feature it protects. So it only fires on a word
 * of four or more characters within two of a verb it prefixes or extends, and
 * `delegate <anything>` always dispatches the line as written.
 */
/** Parse the args to `cancel`, returning an optional jobId. */
function parseCancelCommand(rest: string[]): CockpitCommand {
  const jobId = rest[0];
  return jobId !== undefined ? { kind: 'cancel', jobId } : { kind: 'cancel' };
}

/** Parse the args to `logs`/`attach`, returning an optional jobId. */
function parseFocusCommand(rest: string[]): CockpitCommand {
  const jobId = rest[0];
  return jobId !== undefined ? { kind: 'focus', jobId } : { kind: 'focus' };
}

export function parseCockpitInput(line: string, ctx?: ParseCockpitCtx): CockpitCommand {
  const trimmed = line.trim();
  if (trimmed === '') return { kind: 'nothing' };
  const parts = trimmed.split(WORDS_RE);
  const word = parts[0]!;  // safe: trimmed is non-empty
  const rest = parts.slice(1);
  const verb = word.toLowerCase();
  const optionIds = (ctx && ctx.optionIds) || [];

  if (VERB_HELP.has(verb)) return { kind: 'help' };
  if (VERB_QUIT.has(verb)) return { kind: 'quit' };
  if (verb === 'delegate') return parseDelegateCommand(rest);
  if (verb === 'answer') return parseAnswerCommand(rest);
  if (verb === 'cancel') return parseCancelCommand(rest);
  if (VERB_FOCUS.has(verb)) return parseFocusCommand(rest);
  return parseCockpitContextual(word, trimmed, rest, optionIds);
}

/**
 * The verb a word was probably meant to be, or undefined. Deliberately mean:
 * short words and distant ones are left alone, because the cost of a false
 * positive is refusing a legitimate dispatch, and of a false negative is one
 * nonsense job the operator can cancel.
 */
function nearVerb(word: string): string | undefined {
  if (word.length < 4) return undefined;
  return COCKPIT_VERBS.find(
    (verb) => (verb.startsWith(word) || word.startsWith(verb)) && Math.abs(verb.length - word.length) <= 2,
  );
}

/** The longest prefix every candidate shares, for a completion with no single winner. */
function commonPrefix(words: string[]): string {
  if (words.length === 0) return '';
  let prefix = words[0];
  for (const word of words.slice(1)) {
    while (!word.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/**
 * Complete the word under the cursor: the first one against the verbs, any later
 * one against the job ids on the board. Unambiguous completions gain a trailing
 * space; ambiguous ones extend to the common prefix and wait.
 */
export function completeCockpitInput(line: string, ctx: { jobIds?: string[] } = {}): string {
  const head = line.slice(0, line.lastIndexOf(' ') + 1);
  const word = line.slice(head.length);
  if (word === '') return line;
  const candidates = (head === '' ? COCKPIT_VERBS : ctx.jobIds ?? []).filter((c) => c.startsWith(word));
  if (candidates.length === 0) return line;
  if (candidates.length === 1) return `${head}${candidates[0]} `;
  return `${head}${commonPrefix(candidates)}`;
}

/**
 * The input line's history: newest last, no duplicate of the previous entry, and
 * a cursor that walks it. Kept in memory only — a command line is a view too.
 */
export class InputHistory {
  readonly entries: string[] = [];
  private cursor = 0;

  add(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '' || this.entries.at(-1) === trimmed) {
      this.cursor = this.entries.length;
      return;
    }
    this.entries.push(trimmed);
    this.cursor = this.entries.length;
  }

  /** Walk by `delta`; returns the line to show, or '' past the newest entry. */
  walk(delta: number): string {
    if (this.entries.length === 0) return '';
    this.cursor = Math.max(0, Math.min(this.entries.length, this.cursor + delta));
    return this.entries[this.cursor] ?? '';
  }
}

// ── Input decoding ────────────────────────────────────────────────────────────

/** CSI/SS3 escape sequences — arrows, page keys — as a terminal actually sends them. */
const ESCAPE_KEY = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/;

/**
 * Split a stdin chunk into the keystrokes it contains: one per character, with
 * escape sequences kept whole.
 *
 * A terminal usually delivers one keystroke per read, but not always — fast
 * typing, a paste, and a pipe all coalesce. A reader that treats a chunk as one
 * key gets this wrong in both directions: it drops everything after the first
 * character where a single character is meant (answering a y/N prompt, or
 * holding `j` to move down the board), and it cannot see the keys inside a
 * pasted line at all. Character by character, a chunk means exactly what the
 * same keys typed slowly would.
 *
 * Iterated by code point, so a multi-byte character is one key rather than two
 * broken halves.
 */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let rest = chunk;
  while (rest !== '') {
    if (rest.startsWith('\x1b')) {
      const escape = ESCAPE_KEY.exec(rest);
      keys.push(escape ? escape[0] : '\x1b');
      rest = rest.slice(escape ? escape[0].length : 1);
      continue;
    }
    const [first] = rest;
    keys.push(first);
    rest = rest.slice(first.length);
  }
  return keys;
}

// ── The resident loop ─────────────────────────────────────────────────────────

const POLL_MS = 2_000;
const FRAME_MS = 100; // ≤10fps
/** Idle repaint cadence: the elapsed column and the blocked pulse keep moving. */
const IDLE_REPAINT_MS = 300;
/** How long a notice holds the footer before the key hints come back. */
const STATUS_MS = 6_000;
/**
 * A refusal holds it far longer. Progress notices are glanceable and replaceable;
 * "delegate failed: …" is the answer to what just happened, and an operator who
 * looked away for five seconds must still find it.
 */
const STATUS_STICKY_MS = 60_000;
/** Selection has to settle before a new follow opens, or fast j/k opens one per row. */
const FOLLOW_SETTLE_MS = 250;
/** A resident view runs for hours: the tail is a window, not a transcript. */
const MAX_TAIL_EVENTS = 2_000;
// Loopback hosts — the ones a local port-forward can actually serve — come
// from ./client.ts (LOOPBACK_HOSTS), the same set the daemon-target trust
// boundary is drawn on (#135).

/** Never re-examine the tunnel more often than this, however badly the daemon is doing. */
const TUNNEL_RECHECK_MS = 15_000;

export type CockpitDeps = {
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  /**
   * Dispatch a work order. Injected rather than imported: `fleet delegate` owns
   * the one dispatch path — manifest validation, env and sync collection, git
   * identity, the job image, the dispatch ledger — and a cockpit with its own
   * copy of that would be a second product. `log`/`warn` carry its progress to
   * wherever the caller shows it.
   */
  delegate: (req: {
    target: string;
    mode?: string;
    log: (line: string) => void;
    warn: (line: string) => void;
    /** Aborted when the cockpit closes: a dispatch mid-build must die with the view (#121). */
    signal?: AbortSignal;
  }) => Promise<{ jobId: string; state: string }>;
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The one dispatch in flight, fired outside the key queue (#121). A cold-image
 * delegate spends minutes in `docker build`; awaited inside the serialized key
 * queue it froze the repaint, starved the poll loop, and left ^C an unread
 * stdin byte until someone SIGKILLed the process. Completion and failure reach
 * the operator through the same status line every other notice uses, and
 * `abort()` (wired to the view closing) kills the build's docker child.
 */
function delegateRunner(io: {
  delegate: CockpitDeps['delegate'];
  say: (line: string, hold?: number) => void;
  refuse: (line: string) => void;
  poll: () => Promise<void>;
}): { start: (command: { target: string; mode?: string }) => void; abort: () => void } {
  let inFlight: string | undefined;
  let controller: AbortController | undefined;
  const dispatch = async (command: { target: string; mode?: string }, signal: AbortSignal): Promise<void> => {
    try {
      const created = await io.delegate({
        target: command.target,
        mode: command.mode,
        // Progress holds the footer the way a refusal does: a build is minutes
        // long, and a notice that expired mid-build reads as a dispatch that
        // silently went away.
        log: (line) => io.say(line, STATUS_STICKY_MS),
        warn: (line) => io.say(line, STATUS_STICKY_MS),
        signal,
      });
      io.say(`${created.jobId} ${created.state} — ${command.target}`);
      await io.poll().catch(() => {});
    } catch (err) {
      io.refuse(`delegate failed: ${errorText(err)}`);
    } finally {
      inFlight = undefined;
      controller = undefined;
    }
  };
  return {
    start: (command) => {
      // Refused, not queued: a second build racing the first for the same tag
      // (or silently stacking behind it) is worse than a one-line answer.
      if (inFlight !== undefined) {
        io.refuse(`delegate: still dispatching ${inFlight} — wait for it to settle`);
        return;
      }
      inFlight = command.target;
      controller = new AbortController();
      io.say(`delegating ${command.target} …`);
      void dispatch(command, controller.signal);
    },
    abort: () => controller?.abort(),
  };
}

/** Best-effort repo/branch/provider for the header strip; every field is optional. */
function detectContext(cwd: string): ContextInfo {
  const context: ContextInfo = {};
  const git = (args: string[]): string | undefined => gitValue(args, cwd);
  context.branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const origin = git(['remote', 'get-url', 'origin']);
  const named = origin?.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (named) context.repo = named[1];
  for (const { config } of fleetConfigFiles(cwd)) {
    if (typeof config.provider === 'string' && config.provider !== '') {
      context.provider = config.provider;
      break;
    }
  }
  return context;
}

/** The tunnel, said in one word for the header strip. */
function tunnelLabel(status: TunnelStatus): string | undefined {
  if (status.kind === 'none') return undefined;
  if (status.kind === 'owned') return `tunnel:ours:${status.port}`;
  if (status.kind === 'adopted') return 'tunnel:adopted';
  if (status.kind === 'probing') return 'tunnel:…';
  return 'tunnel:down';
}

/**
 * Run the cockpit until the operator leaves it. Returns 0; the only failures
 * here are the daemon being unreachable, which is a thing to display, not to
 * exit on — a fleet is still a fleet while its tunnel is down.
 */
export async function runCockpit(deps: CockpitDeps): Promise<number> {
  const env = deps.env;
  // The cockpit only ever runs on a terminal (or a test standing in for one),
  // so the TTY half of the predicate is already true; the env half is shared
  // with `fleet logs` rather than spelled out again here.
  const noColor = logsNoColor(env, true);
  const colorLevel = detectColorLevel(env);
  const context = detectContext(deps.cwd);
  const endpoint = describeTarget(env, { cwd: deps.cwd });
  const history = new InputHistory();
  const decisions = new Map<string, PendingDecision>();
  const model: CockpitModel = {
    jobs: [],
    selection: -1, // nothing to select until the first poll lands
    view: 'board',
    tail: [],
    tailScroll: 0,
    input: '',
    tunnel: { kind: 'probing' },
  };

  let running = true;
  let dirty = true;
  let statusAt = 0;
  let lastPollAt = 0;
  let lastRenderAt = 0;
  let selectionAt = 0;
  let tunnelCheckedAt = 0;
  let pendingCancel: string | undefined;
  let held: HeldTunnel | undefined;
  let followAbort: AbortController | undefined;
  let followedId: string | undefined;

  // The footer has one line and two claimants: what the operator just did, and
  // what the background is up to. The operator wins while their notice is fresh —
  // a tunnel probe finishing in the same tick as a refused command used to
  // replace it before it was ever drawn, so the operator typed a command and saw
  // an unrelated message about a port. The tunnel's state is never lost by this:
  // the context strip carries it for as long as it lasts.
  let statusHoldMs = STATUS_MS;
  let statusIsOperators = false;
  const say = (line: string, hold = STATUS_MS): void => {
    model.status = line;
    statusAt = Date.now();
    statusHoldMs = hold;
    statusIsOperators = true;
    dirty = true;
  };
  /** Something the operator asked for did not happen: say so, and keep saying it. */
  const refuse = (line: string): void => say(line, STATUS_STICKY_MS);
  /** Background progress. Never talks over the operator's own last notice. */
  const note = (line: string): void => {
    if (statusIsOperators && model.status !== undefined) return;
    model.status = line;
    statusAt = Date.now();
    statusHoldMs = STATUS_MS;
    statusIsOperators = false;
    dirty = true;
  };

  const width = (): number => process.stdout.columns || 80;
  const height = (): number => process.stdout.rows || 24;

  // ── frame ──
  const render = (): void => {
    const now = Date.now();
    if (now - lastRenderAt < FRAME_MS) return;
    lastRenderAt = now;
    if (model.status !== undefined && now - statusAt > statusHoldMs) model.status = undefined;
    dirty = false;
    const w = width();
    const frame = renderCockpit(model, w, height(), {
      noColor,
      endpoint,
      colorLevel,
      now,
      pulseOn: Math.floor(now / 600) % 2 === 0,
      context: { ...context, tunnel: tunnelLabel(model.tunnel) },
    });
    // Overwrite from the top rather than clearing: no flicker, no scroll. The
    // last line carries no newline — one on the bottom row would scroll the
    // whole frame up by one every render.
    const lines = frame.split('\n').map((line) => {
      const pad = Math.max(0, w - visualLength(line));
      return `${line}${' '.repeat(pad)}`;
    });
    process.stdout.write(`\x1b[H${lines.join('\r\n')}\x1b[J`);
  };

  // ── the selected job's tail ──
  const follow = (): void => {
    const job = selectedJob(model);
    if (!job || job.id === followedId) return;
    if (Date.now() - selectionAt < FOLLOW_SETTLE_MS) return;
    followAbort?.abort();
    const abort = new AbortController();
    followAbort = abort;
    followedId = job.id;
    model.tail = [];
    model.tailScroll = 0;
    dirty = true;
    void followJobEvents(
      job.id,
      (event) => {
        // A follow that has been replaced must never write into the new one.
        if (abort.signal.aborted) return;
        model.tail.push(event);
        if (model.tail.length > MAX_TAIL_EVENTS) model.tail.splice(0, model.tail.length - MAX_TAIL_EVENTS);
        dirty = true;
      },
      env,
      abort.signal,
    ).catch(() => {});
  };

  // ── the tunnel: adopt if healthy, otherwise own one ──
  //
  // Every step here is slow — a health probe, a TCP probe, then cloud calls to
  // resolve the daemon task — and the operator can close the view in the middle
  // of any of them. Opening a forward after that would leave a detached process
  // holding the local port with nobody left to stop it, which is the precise
  // opposite of "a cockpit-owned tunnel dies with it". So `running` is re-checked
  // after every await, and the whole thing is awaited on the way out.
  // Extract the tunnel-opening attempt so checkTunnel's branch count stays low.
  const openTunnel = async (port: number): Promise<void> => {
    try {
      // Forward the port the rest of the CLI resolves, not the capture's own
      // idea of it: a cockpit tunnelling somewhere it does not read from is worse
      // than no tunnel at all.
      const tunnel = await resolveTunnel(deps.cwd, port);
      // Nothing may be spawned once the view is closing: the teardown that would
      // have stopped it has already run.
      if (!running || held !== undefined) return;
      const session = holdTunnel(tunnel, deps.home, (line) => note(`tunnel: ${line}`));
      held = session;
      model.tunnel = { kind: 'owned', port: session.port };
      note(`tunnel: opening ${endpoint} from ${tunnel.source}`);
      void session.ended.then((failure) => {
        if (held !== session) return; // replaced, or stopped on the way out
        held = undefined;
        model.tunnel = { kind: 'failed', why: failure ? failure.message : 'the tunnel closed' };
        dirty = true;
      });
    } catch (err) {
      model.tunnel = { kind: 'failed', why: errorText(err) };
      note(`tunnel: ${model.tunnel.why}`);
    }
  };

  const checkTunnel = async (): Promise<void> => {
    tunnelCheckedAt = Date.now();
    const target = daemonTarget(env, { cwd: deps.cwd });
    // A unix socket is not reached through anything; there is nothing to hold.
    if (target.kind !== 'tcp') {
      model.tunnel = { kind: 'none' };
      return;
    }
    // Through the address the CLI actually resolves, base path included: a
    // daemon behind a path prefix is healthy, and must not be replaced.
    if (await daemonHealthy(env, deps.cwd)) {
      // Someone else's forward, and it works: use it and never close it.
      model.tunnel = { kind: 'adopted' };
      return;
    }
    if (!running) return;
    if (await portAccepts(target.host, target.port)) {
      // Held, but not serving — our own forward could not bind, and probing it
      // would answer from whatever is already there. Say what doctor would say.
      const report = await tunnelReport({ host: target.host, port: target.port, url: endpoint, home: deps.home });
      model.tunnel = { kind: 'failed', why: report.findings[0] ?? `${endpoint} is held but not serving` };
      note(model.tunnel.why);
      return;
    }
    // A forward binds a local port. If the daemon address is not local, opening
    // one would forward a port nothing reads from — worse than no tunnel.
    if (!LOOPBACK_HOSTS.has(target.host)) {
      model.tunnel = { kind: 'failed', why: `${endpoint} is not a local address — nothing here can tunnel to it` };
      note(model.tunnel.why);
      return;
    }
    if (!running) return;
    await openTunnel(target.port);
  };

  /** The tunnel work in flight, so closing the view can wait for it. */
  let tunnelWork: Promise<void> = Promise.resolve();
  const recheckTunnel = (): void => {
    tunnelWork = tunnelWork.then(checkTunnel).catch(() => {});
  };

  // ── one poll of the daemon ──
  //
  // One at a time. A poll is a job listing plus an event read per blocked job,
  // and over a slow tunnel it can outlast the interval: overlapping polls pile
  // up sockets and let a stale answer overwrite a newer board.
  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const selectedId = selectedJob(model)?.id;
      const result = await fetchBoardJobs(env, decisions);
      if (!result.ok || result.jobs === undefined) {
        context.daemonReachable = false;
        dirty = true;
        // A dead tunnel is the likeliest reason, and the cockpit owns the tunnel:
        // re-examine it, but no more often than a broken deployment deserves.
        if (model.tunnel.kind !== 'owned' && Date.now() - tunnelCheckedAt > TUNNEL_RECHECK_MS) recheckTunnel();
        return;
      }
      context.daemonReachable = true;
      model.jobs = sortJobs(result.jobs);
      // Follow the job, not the row: board order changes under the selection every
      // time something blocks or settles.
      const moved = selectedId === undefined ? -1 : model.jobs.findIndex((j) => j.id === selectedId);
      model.selection = model.jobs.length === 0
        ? -1
        : moved >= 0 ? moved : Math.max(0, Math.min(model.selection, model.jobs.length - 1));
      dirty = true;
    } finally {
      polling = false;
    }
  };

  // ── what a submitted line does ──
  const delegate = delegateRunner({ delegate: deps.delegate, say, refuse, poll });
  const run = async (command: CockpitCommand): Promise<void> => {
    switch (command.kind) {
      case 'nothing':
        return;
      case 'help':
        say('delegate <target> [--mode m] · answer <id> [note] · logs <job> · cancel <job> · quit');
        return;
      case 'quit':
        running = false;
        return;
      case 'error':
        refuse(command.message);
        return;
      case 'delegate':
        // Fired and tracked by `delegate`, never awaited here (#121): this runs
        // inside the serialized key queue, and a queue waiting on a cold-image
        // build cannot read the next key — including the ^C that ends the wait.
        delegate.start(command);
        return;
      case 'answer': {
        const job = selectedJob(model);
        if (!job || job.state !== 'blocked') {
          refuse('answer: select a blocked job first');
          return;
        }
        const body: { option?: string; text?: string } = {};
        if (command.option !== undefined) body.option = command.option;
        if (command.text !== undefined) body.text = command.text;
        const posted = await answerJob(job.id, body, env);
        if (posted.ok) say(`answered ${job.id}`);
        else refuse(`answer failed: ${posted.error ?? 'unknown error'}`);
        if (posted.ok) {
          // The answer is the transition: drop this job's cached decision so
          // the next poll reads whatever it asks next rather than the old
          // card. Only this job's — the other blocked jobs' questions have
          // not changed, and refetching each of their full event logs made
          // one answer cost a poll cycle per blocked job (#125).
          invalidateDecision(decisions, job.id);
          await poll();
        }
        return;
      }
      // Cancelling asks first and answering does not, deliberately: an answer is
      // what this surface exists for and is the job's next instruction, while a
      // cancel throws away work that cannot be got back. The guard goes on the
      // destructive one, not on the frequent one.
      case 'cancel': {
        const jobId = command.jobId ?? selectedJob(model)?.id;
        if (jobId === undefined) {
          refuse('cancel: no job selected');
          return;
        }
        pendingCancel = jobId;
        model.confirm = `cancel ${jobId}?`;
        dirty = true;
        return;
      }
      case 'focus': {
        const jobId = command.jobId ?? selectedJob(model)?.id;
        const index = model.jobs.findIndex((j) => j.id === jobId);
        if (index < 0) {
          refuse(`no such job on the board: ${jobId ?? '(none)'}`);
          return;
        }
        model.selection = index;
        selectionAt = 0; // an explicit request opens its tail now, not after a settle
        model.view = 'job';
        dirty = true;
        return;
      }
    }
  };

  const submit = async (): Promise<void> => {
    const line = model.input;
    model.input = '';
    history.add(line);
    dirty = true;
    await run(parseCockpitInput(line, { optionIds: openOptionIds(model) }));
  };

  const onKey = async (key: string): Promise<void> => {
    const action = cockpitKeyAction(key, {
      inputEmpty: model.input === '',
      confirming: model.confirm !== undefined,
      optionIds: openOptionIds(model),
    });
    switch (action.kind) {
      case 'quit':
        running = false;
        break;
      case 'confirm': {
        model.confirm = undefined;
        const jobId = pendingCancel;
        pendingCancel = undefined;
        dirty = true;
        if (action.yes && jobId !== undefined) {
          const result = await cancelJob(jobId, env);
          if (result.ok) say(`cancelled ${jobId}`);
          else refuse(`cancel failed: ${result.error ?? 'unknown error'}`);
          if (result.ok) await poll();
        }
        break;
      }
      case 'select': {
        const next = Math.max(0, Math.min(model.selection + action.delta, model.jobs.length - 1));
        if (next !== model.selection) {
          model.selection = next;
          selectionAt = Date.now();
          model.tailScroll = 0;
          // The tail belongs to the job that was selected. Leaving it up under
          // the new job's name would attribute one job's events to another for
          // as long as the follow takes to settle and reconnect.
          model.tail = [];
          followedId = undefined;
          followAbort?.abort();
          dirty = true;
        }
        break;
      }
      case 'open':
        if (selectedJob(model) !== undefined) {
          model.view = 'job';
          model.tailScroll = 0;
          dirty = true;
        }
        break;
      case 'back':
        model.view = 'board';
        model.tailScroll = 0;
        dirty = true;
        break;
      case 'scroll': {
        // Only the drill-down has a tail to move; on the board the keys are
        // inert rather than building up scroll debt against an invisible pane.
        if (model.view !== 'job') break;
        // Clamped to the tail it is scrolling, so PgUp past the top does not
        // build up a debt that PgDn has to spend before anything moves.
        // clampTailScroll counts only the lines the clamp needs — rendering the
        // whole tail per keypress to learn one number was an #125 cost.
        model.tailScroll = clampTailScroll(model.tail, model.tailScroll + action.delta);
        dirty = true;
        break;
      }
      case 'history':
        model.input = history.walk(action.delta);
        dirty = true;
        break;
      case 'complete':
        model.input = completeCockpitInput(model.input, { jobIds: model.jobs.map((j) => j.id) });
        dirty = true;
        break;
      case 'insert':
        model.input += action.text;
        dirty = true;
        break;
      case 'erase':
        model.input = model.input.slice(0, -1);
        dirty = true;
        break;
      case 'clear':
        model.input = '';
        dirty = true;
        break;
      case 'submit':
        await submit();
        break;
    }
  };

  // ── terminal setup and teardown ──
  const onSignal = (): void => {
    running = false;
  };
  // Keys are processed in order: an action may await (a POST), and a later key
  // must not overtake it.
  let queue: Promise<void> = Promise.resolve();
  const onData = (chunk: string): void => {
    queue = queue.then(async () => {
      for (const key of splitKeys(chunk)) await onKey(key);
      render();
    }).catch(() => {});
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', onData);
  // A closed stdin is the operator leaving, same as ^C.
  process.stdin.once('end', onSignal);
  const onResize = (): void => {
    dirty = true;
  };
  process.stdout.on('resize', onResize);
  process.stdout.write(`${ENTER_ALT}\x1b[2J\x1b[H`);

  recheckTunnel();
  await poll();
  render();

  await new Promise<void>((resolve) => {
    const loop = setInterval(() => {
      if (!running) {
        clearInterval(loop);
        resolve();
        return;
      }
      const now = Date.now();
      if (now - lastPollAt >= POLL_MS) {
        lastPollAt = now;
        void poll().catch(() => {});
      }
      follow();
      // Elapsed columns and the blocked pulse move on their own, so an idle
      // cockpit still repaints — but a few times a second, not every frame.
      if (dirty || now - lastRenderAt >= IDLE_REPAINT_MS) render();
    }, FRAME_MS);
  });

  followAbort?.abort();
  // A dispatch still building dies with the view: the abort kills its docker
  // child, and the build-before-POST ordering means no job was created yet.
  delegate.abort();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  process.stdout.off('resize', onResize);
  process.stdin.off('data', onData);
  process.stdin.off('end', onSignal);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(RESTORE_SEQ);
  // Ours dies with the view; an adopted one is somebody else's and outlives it.
  // A tunnel still being opened has to finish deciding before it can be told to
  // stop: dropping out here is how a forward outlives the view that opened it.
  await tunnelWork;
  await held?.stop();
  return 0;
}
