// fleet board — full-screen live terminal view of the fleet.
// Zero dependencies: hand-rolled ANSI; erasable TS only.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { request, describeTarget } from './client.ts';
import { formatLogText } from './format.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BoardDecision = {
  id: string;
  question: string;
  options: Array<{ id: string; label?: string; recommended?: boolean }>;
};

export type BoardJob = {
  id: string;
  state: string;
  marker?: string;
  workOrder?: { mode?: string; target?: string; title?: string };
  createdAt?: string;
  updatedAt?: string;
  lastPhase?: string;       // last think/log/phase text enriched from event stream (live follow)
  lastActivity?: { text: string; at: string }; // most recent think/log from server (all jobs)
  decision?: BoardDecision; // pending decision enriched from event stream
};

/** Context info shown in the header strip. Gathered at startup; optional fields. */
export type ContextInfo = {
  repo?: string;           // e.g. "owner/repo"
  branch?: string;         // e.g. "main"
  provider?: string;       // e.g. "process" | "docker" | "ecs"
  harnessCli?: string;     // e.g. "claude-code"
  daemonReachable?: boolean;
};

/** A parsed event from a job's event stream. */
export type BoardEvent = {
  seq: number;
  type: string;
  text?: string;
  id?: string;
  question?: string;
  options?: Array<{ id: string; label?: string; recommended?: boolean }>;
  decision?: string;
  option?: string;
  by?: string;
  state?: string;
  rung?: string;
  report?: { status?: string; next_action?: string };
};

export type FrameOpts = {
  noColor?: boolean;
  endpoint?: string;
  pulseOn?: boolean;
  now?: number;
  context?: ContextInfo;
  showBanner?: boolean;
  colorLevel?: ColorLevel;
};

// ── Visual identity ───────────────────────────────────────────────────────────

/**
 * Paper-airplane pixel art, 16×8. Rendered as half-blocks (two pixel rows per
 * character row) with a blue-chrome gradient; plain blocks under NO_COLOR.
 */
const PLANE_PX = [
  '..............##',
  '..........#####.',
  '......########..',
  '..###########...',
  '############....',
  '..########......',
  '....#####.......',
  '......##........',
];

/** Under-wing fold: same silhouette, darker shade — the crease that reads "paper". */
function foldAt(x: number, y: number): boolean {
  return y >= 4 && x >= 8;
}

/** Blue-chrome ramp: deep blue → blue → sky → near-white highlight. */
const RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [10, 47, 122]],
  [0.45, [37, 99, 235]],
  [0.75, [56, 189, 248]],
  [1.0, [223, 243, 255]],
];

/** Diagonal gradient position → rgb, lerped across the ramp. */
function rampAt(t: number): [number, number, number] {
  for (let i = 1; i < RAMP.length; i++) {
    const [t0, c0] = RAMP[i - 1];
    const [t1, c1] = RAMP[i];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f)) as [number, number, number];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/** rgb → nearest xterm-256 colour-cube index, for terminals without truecolor. */
function cube256([r, g, b]: [number, number, number]): number {
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

export type ColorLevel = '24bit' | '256';

/** Detect the terminal's colour depth from the environment. */
export function detectColorLevel(env: Record<string, string | undefined>): ColorLevel {
  const ct = env.COLORTERM ?? '';
  return ct.includes('truecolor') || ct.includes('24bit') ? '24bit' : '256';
}

function pxAt(x: number, y: number): boolean {
  return PLANE_PX[y]?.[x] === '#';
}

function fg(c: [number, number, number], level: ColorLevel): string {
  return level === '24bit' ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[38;5;${cube256(c)}m`;
}

function bg(c: [number, number, number], level: ColorLevel): string {
  return level === '24bit' ? `\x1b[48;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[48;5;${cube256(c)}m`;
}

/** Gradient colour of pixel (x, y): diagonal sweep, nose brightest. */
function planeColor(x: number, y: number): [number, number, number] {
  const c = rampAt((x + 0.6 * (7 - y)) / (15 + 0.6 * 7));
  if (!foldAt(x, y)) return c;
  return c.map((v) => Math.round(v * 0.55)) as [number, number, number];
}

/** Build the 4 banner lines: half-block plane + wordmark. Plain when level omitted. */
function buildBanner(level?: ColorLevel): string[] {
  const wide = PLANE_PX[0].length;
  const lines: string[] = [];
  for (let row = 0; row < PLANE_PX.length / 2; row++) {
    let line = ' ';
    for (let x = 0; x < wide; x++) {
      const top = pxAt(x, row * 2);
      const bot = pxAt(x, row * 2 + 1);
      if (!top && !bot) { line += ' '; continue; }
      if (!level) { line += top && bot ? '█' : top ? '▀' : '▄'; continue; }
      const tc = planeColor(x, row * 2);
      const bc = planeColor(x, row * 2 + 1);
      if (top && bot) line += `${fg(tc, level)}${bg(bc, level)}▀\x1b[0m`;
      else if (top) line += `${fg(tc, level)}▀\x1b[0m`;
      else line += `${fg(bc, level)}▄\x1b[0m`;
    }
    lines.push(line);
  }
  lines[1] += !level ? '   F L E E T' : `   \x1b[1;38;5;153mF L E E T\x1b[0m`;
  lines[2] += !level ? '   your cloud' : `   \x1b[2myour cloud\x1b[0m`;
  return lines;
}

/** Small Fleet wordmark, plain form. Shown when the board starts; also `fleet --help`. */
export const FLEET_BANNER = buildBanner().join('\n');

/**
 * Footer key manifests: every label advertised in the footer must appear here
 * with the rawKeys that trigger the handler. The test mechanically verifies parity.
 * Adding a label without a rawKeys entry (or vice-versa) will fail that test.
 */
export const ROSTER_FOOTER_KEYS: Array<{ label: string; rawKeys: string[] }> = [
  { label: '↑↓ navigate', rawKeys: ['\x1b[A', '\x1b[B', 'k', 'j'] },
  { label: 'enter expand', rawKeys: ['\r', '\n'] },
  { label: 'a answer', rawKeys: ['a'] },
  { label: 'q quit', rawKeys: ['q', '\x03'] },
];

export const DETAIL_FOOTER_KEYS: Array<{ label: string; rawKeys: string[] }> = [
  { label: '↑↓ scroll', rawKeys: ['\x1b[A', '\x1b[B', 'k', 'j'] },
  { label: 'G re-stick', rawKeys: ['G'] },
  { label: 'a answer', rawKeys: ['a'] },
  { label: 'c cancel', rawKeys: ['c'] },
  { label: 'o open', rawKeys: ['o'] },
  { label: 'esc back', rawKeys: ['\x1b'] },
];

// ── Terminal sequences ────────────────────────────────────────────────────────

/** Enter alternate screen buffer and hide cursor. */
export const ENTER_ALT = '\x1b[?1049h\x1b[?25l';
/** Show cursor and exit alternate screen buffer. */
export const RESTORE_SEQ = '\x1b[?25h\x1b[?1049l';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function ansi(...codes: number[]): string {
  return `\x1b[${codes.join(';')}m`;
}

function visualLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Build a col() helper bound to a specific noColor flag. */
function makeCol(noColor: boolean): (text: string, ...codes: number[]) => string {
  return (text, ...codes) => noColor ? text : `${ansi(...codes)}${text}${RESET}`;
}

// ── Key dispatch (pure; tested for parity with footer manifests) ──────────────

export type KeyAction =
  | 'navigate-up' | 'navigate-down'
  | 'expand' | 'back'
  | 'answer' | 'cancel' | 'open'
  | 'scroll-up' | 'scroll-down' | 'restick'
  | 'quit' | 'unknown';

/** Map a raw key to a roster action. Must cover every rawKey in ROSTER_FOOTER_KEYS. */
export function rosterKeyAction(key: string): KeyAction {
  if (key === 'q' || key === '\x03') return 'quit';
  if (key === '\r' || key === '\n') return 'expand';
  if (key === '\x1b[A' || key === 'k') return 'navigate-up';
  if (key === '\x1b[B' || key === 'j') return 'navigate-down';
  if (key === 'a') return 'answer';
  return 'unknown';
}

/** Map a raw key to a detail action. Must cover every rawKey in DETAIL_FOOTER_KEYS. */
export function detailKeyAction(key: string): KeyAction {
  // '\x1b' alone = standalone Escape; arrow keys arrive as '\x1b[A' etc. (3+ chars).
  if (key === '\x1b') return 'back';
  if (key === '\x1b[A' || key === 'k') return 'scroll-up';
  if (key === '\x1b[B' || key === 'j') return 'scroll-down';
  if (key === 'G') return 'restick';
  if (key === 'a') return 'answer';
  if (key === 'c') return 'cancel';
  if (key === 'o') return 'open';
  return 'unknown';
}

/**
 * Clip a string (which may contain ANSI codes) to at most maxLen visible
 * characters, appending '…' if truncated. Resets open ANSI sequences only
 * when the clipped portion contained any escape codes.
 */
function visualClip(s: string, maxLen: number): string {
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

// ── Pure frame renderers (new) ────────────────────────────────────────────────

/** Render the Fleet banner: gradient plane when colour is on, plain blocks otherwise. */
export function renderBanner(width: number, noColor: boolean, level: ColorLevel = '256'): string {
  const lines = noColor ? FLEET_BANNER.split('\n') : buildBanner(level);
  return lines.map((line) => visualClip(line, width)).join('\n');
}

/**
 * Render the two-line (roster) or three-line (detail) context strip.
 * Always box-drawn; clips to width. jobLine adds a middle row (detail view only).
 */
export function renderContextStrip(
  blockedCount: number,
  runningCount: number,
  doneCount: number,
  w: number,
  opts: FrameOpts,
  jobLine?: string,
): string {
  const noColor = opts.noColor ?? false;
  const col = makeCol(noColor);
  const inner = w - 2; // chars between corner glyphs

  // Assemble left-side parts.
  const parts: string[] = [col('FLEET', 1, 36)];
  const ctx = opts.context;
  if (ctx?.repo) {
    const repoStr = ctx.branch ? `${ctx.repo}/${ctx.branch}` : ctx.repo;
    parts.push(col(repoStr, 36));
  }
  const endpoint = opts.endpoint;
  if (endpoint) {
    const dot = ctx?.daemonReachable === false ? col('○', 31) : col('●', 32);
    parts.push(`${col(endpoint, 90)} ${dot}`);
  }
  if (ctx?.provider) parts.push(col(ctx.provider, 90));
  if (ctx?.harnessCli) parts.push(col(ctx.harnessCli, 90));

  const leftContent = ` ${parts.join('  ')} `;
  const leftVLen = visualLength(leftContent);

  // Right-side: semantic count labels.
  const bLabel = blockedCount > 0 ? col(`blk:${blockedCount}`, 33) : col(`blk:0`, 90);
  const rLabel = runningCount > 0 ? col(`run:${runningCount}`, 32) : col(`run:0`, 90);
  const dLabel = col(`done:${doneCount}`, 90);
  const countsStr = `${bLabel} ${rLabel} ${dLabel}`;
  const countsVLen = visualLength(countsStr);

  // Fill gap between left and right with dashes.
  const dashCount = Math.max(1, inner - leftVLen - countsVLen - 1);
  const dashes = col('─'.repeat(dashCount), 90);
  const topContent = `${leftContent}${dashes}${countsStr} `;
  const topLine = `┌${visualClip(topContent, inner)}┐`;

  const lines: string[] = [visualClip(topLine, w)];

  if (jobLine !== undefined) {
    const rawLine = `│ ${jobLine}`;
    const vLen = visualLength(rawLine);
    const padded = rawLine + ' '.repeat(Math.max(0, w - 1 - vLen));
    lines.push(visualClip(`${padded}│`, w));
  }

  lines.push(`└${'─'.repeat(Math.max(0, w - 2))}┘`);
  return lines.join('\n');
}

/** Render the dim table-header row + separator rule for the roster. */
export function renderTableHeader(w: number, noColor: boolean): string {
  const col = makeCol(noColor);
  const header = `     ${'JOB'.padEnd(22)}  ${'STATE'.padEnd(9)}  ${'MODE'.padEnd(10)}  ${'TARGET'.padEnd(17)}  ELAPSED`;
  const rule = `  ${'─'.repeat(Math.max(0, w - 2))}`;
  return [visualClip(col(header, 90), w), visualClip(col(rule, 90), w)].join('\n');
}

/** Convert a BoardEvent array to display lines for the detail view. */
export function renderEventLines(events: BoardEvent[], w: number, noColor: boolean): string[] {
  const col = makeCol(noColor);
  const lines: string[] = [];
  // Track pending decisions for "question → answer" rendering.
  const pending = new Map<string, { question: string }>();

  for (const ev of events) {
    const prefix = col(`[${ev.seq}]`, 90);
    switch (ev.type) {
      case 'think':
      case 'log':
        lines.push(visualClip(`${prefix} ${col(ev.text ?? '', 90)}`, w));
        break;
      case 'phase':
        lines.push(visualClip(`${prefix} ${col('phase', 90)} ${col(ev.text ?? '', 90)}`, w));
        break;
      case 'state': {
        const c = ev.state === 'blocked' ? 33 : ev.state === 'running' ? 32 : 90;
        lines.push(visualClip(`${prefix} ${col('→', 90)} ${col(ev.state ?? '', c)}`, w));
        break;
      }
      case 'decision':
        if (ev.id) {
          pending.set(ev.id, { question: ev.question ?? '' });
          lines.push(visualClip(`${prefix} ${col('?', 1, 33)} ${col(ev.question ?? '', 1)}`, w));
          for (const opt of ev.options ?? []) {
            const rec = opt.recommended ? col(' ★', 33) : '';
            lines.push(visualClip(`     ${col(`[${opt.id}]`, 33)} ${opt.label ?? opt.id}${rec}`, w));
          }
        }
        break;
      case 'answer': {
        const dec = ev.decision ? pending.get(ev.decision) : undefined;
        const qText = dec ? col(`"${dec.question}"`, 90) : '';
        const ansText = ev.option ? col(`[${ev.option}]`, 32) : col('(free text)', 90);
        const byText = ev.by ? col(` by ${ev.by}`, 90) : '';
        const summary = qText
          ? `${prefix} ${col('✓', 32)} ${qText} → ${ansText}${byText}`
          : `${prefix} ${col('✓', 32)} answer: ${ansText}${byText}`;
        lines.push(visualClip(summary, w));
        if (ev.decision) pending.delete(ev.decision);
        break;
      }
      case 'settle':
        lines.push(visualClip(
          `${prefix} ${col('settle', 36)} rung=${col(ev.rung ?? '?', 36)} status=${col(ev.report?.status ?? '?', 36)}`,
          w,
        ));
        break;
      default:
        lines.push(visualClip(`${prefix} ${col(ev.type, 90)}`, w));
        break;
    }
  }
  return lines;
}

/**
 * Render the full-screen detail view frame. Pure function: (job, events, scroll,
 * followMode, width, height, opts, counts) → string. Snapshot-testable.
 *
 * scroll=0 → top of event tail; clamped to [0, max].
 * followMode=true → always shows tail (overrides scroll).
 * Minimum usable: 80 col, 8 rows.
 */
export function renderDetailFrame(
  job: BoardJob,
  events: BoardEvent[],
  scroll: number,
  followMode: boolean,
  width: number,
  height: number,
  opts: FrameOpts,
  counts: { blocked: number; running: number; done: number } = { blocked: 0, running: 0, done: 0 },
): string {
  const noColor = opts.noColor ?? false;
  const col = makeCol(noColor);
  const w = Math.max(40, width);
  const h = Math.max(8, height);
  const now = opts.now ?? 0;

  // Header: context strip with job line (3 lines).
  const elapsed = jobElapsed(job, now);
  const mode = job.workOrder?.mode ?? '?';
  const rawTarget = job.workOrder?.target ?? '?';
  const title = job.workOrder?.title;
  // Detail header shows title in full (context strip clips to terminal width).
  // Separator is colon here (e.g. "#42: Fix login") vs. space in the roster (e.g. "#42 Fix login"):
  // the detail line is a full contextual header; the roster is compact tabular data.
  const ref = /^\d+$/.test(rawTarget) ? `#${rawTarget}` : rawTarget;
  const targetFull = title ? `${ref}: ${title}` : rawTarget;
  const stateDisplay = job.marker ? `${job.state}(${job.marker})` : job.state;
  const stateColor = job.state === 'blocked' ? 33 : job.state === 'running' ? 32 : 90;
  const jobLineContent = [
    col(job.id, 1),
    col(stateDisplay, stateColor),
    mode,
    targetFull,
    elapsed,
  ].filter(Boolean).join('  ');

  const contextLines = renderContextStrip(
    counts.blocked, counts.running, counts.done, w, opts, jobLineContent,
  ).split('\n');
  const headerLineCount = contextLines.length; // 3

  // Footer: 1 line.
  const footerText = DETAIL_FOOTER_KEYS.map((k) => k.label).join('  ');
  const footerLine = visualClip(col(`  ${footerText}`, 90), w);

  const availableLines = Math.max(1, h - headerLineCount - 1);
  const eventLines = renderEventLines(events, w, noColor);

  // Clamp scroll; follow mode anchors to bottom.
  const maxScroll = Math.max(0, eventLines.length - availableLines);
  const clampedScroll = followMode ? maxScroll : Math.max(0, Math.min(scroll, maxScroll));

  const visible = eventLines.slice(clampedScroll, clampedScroll + availableLines);
  while (visible.length < availableLines) visible.push('');

  return [...contextLines, ...visible, footerLine].join('\n');
}

// ── Job ordering ──────────────────────────────────────────────────────────────

export function stateRank(j: BoardJob): number {
  if (j.state === 'blocked') return 0;
  if (j.state === 'running' || j.state === 'queued') return 1;
  return 2;
}

// ── Elapsed time ──────────────────────────────────────────────────────────────

function fmtElapsed(ms: number): string {
  if (ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return m % 60 > 0 ? `${h}h${m % 60}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function elapsedStr(iso: string | undefined, nowMs: number): string {
  if (!iso) return '';
  return fmtElapsed(nowMs - new Date(iso).getTime());
}

/**
 * A job's elapsed column: live jobs count from dispatch to now; settled jobs
 * freeze at their total runtime (createdAt → updatedAt) — a done job must
 * never appear to keep aging.
 */
function jobElapsed(job: BoardJob, nowMs: number): string {
  const start = job.createdAt ? new Date(job.createdAt).getTime() : NaN;
  if (Number.isNaN(start)) return elapsedStr(job.updatedAt, nowMs);
  const settled = job.state === 'done' || job.state === 'cancelled';
  const end = settled && job.updatedAt ? new Date(job.updatedAt).getTime() : nowMs;
  return fmtElapsed(end - start);
}

// ── Pure frame renderer ───────────────────────────────────────────────────────

/**
 * Render a board frame as a string.
 * Pure function: deterministic given the same inputs; no TTY, no Date.now(),
 * no process.env. Snapshot-testable without a terminal.
 *
 * Jobs are sorted blocked → running/queued → terminal regardless of input order.
 * `selection` is an index into the sorted list (-1 = nothing selected).
 */
export function renderFrame(
  jobs: BoardJob[],
  selection: number,
  width: number,
  opts: FrameOpts = {},
): string {
  const noColor = opts.noColor ?? false;
  const now = opts.now ?? 0;
  const pulse = opts.pulseOn ?? false;
  const w = Math.max(40, width);

  const col = makeCol(noColor);

  const sorted = [...jobs].sort((a, b) => stateRank(a) - stateRank(b));

  const blockedCount = jobs.filter((j) => j.state === 'blocked').length;
  const runningCount = jobs.filter((j) => j.state === 'running' || j.state === 'queued').length;
  const doneCount = jobs.filter((j) => j.state === 'done' || j.state === 'cancelled').length;

  const lines: string[] = [];

  // ── Banner (interactive mode only) ───────────────────────────────────────
  if (opts.showBanner) {
    lines.push(renderBanner(w, noColor, opts.colorLevel ?? '256'));
  }

  // ── Context strip ─────────────────────────────────────────────────────────
  lines.push(renderContextStrip(blockedCount, runningCount, doneCount, w, opts));

  // ── Table header ──────────────────────────────────────────────────────────
  lines.push(renderTableHeader(w, noColor));

  if (sorted.length === 0) {
    lines.push(col('  no jobs — delegate one with: fleet delegate <target>', 90));
  }

  for (let i = 0; i < sorted.length; i++) {
    const job = sorted[i];
    const isSel = i === selection;
    const sel = isSel ? col('▶', 36) : ' ';
    const elapsed = jobElapsed(job, now);
    const mode = job.workOrder?.mode ?? '?';
    const rawTarget = job.workOrder?.target ?? '?';
    const title = job.workOrder?.title;
    // Prefer "#<n> <title>" when both are present.
    const ref = /^\d+$/.test(rawTarget) ? `#${rawTarget}` : rawTarget;
    const targetDisplay = title ? `${ref} ${title}` : rawTarget;
    const stateDisplay = job.marker ? `${job.state}(${job.marker})` : job.state;

    if (job.state === 'blocked') {
      // Urgency marker pulses on a ~600ms cycle.
      const urgency = pulse ? col('!!', 1, 31) : col('!!', 33);
      const row = `${sel} ${urgency} ${visualClip(job.id, 22).padEnd(22)}  ${col(stateDisplay.padEnd(9), 33)}  ${mode.padEnd(10)}  ${visualClip(targetDisplay, 17).padEnd(17)}  ${elapsed}`;
      lines.push(visualClip(row, w));

      if (job.decision) {
        lines.push(visualClip(`     ${col(job.decision.question, 1)}`, w));
        for (const opt of job.decision.options) {
          const rec = opt.recommended ? col(' ★', 33) : '';
          const label = opt.label ?? opt.id;
          lines.push(visualClip(`     [${opt.id}] ${label}${rec}`, w));
        }
      }
      lines.push('');
    } else if (job.state === 'running' || job.state === 'queued') {
      const glyph = col('●', 32) + ' ';
      const row = `${sel} ${glyph} ${visualClip(job.id, 22).padEnd(22)}  ${col(job.state.padEnd(9), 32)}  ${mode.padEnd(10)}  ${visualClip(targetDisplay, 17).padEnd(17)}  ${elapsed}`;
      lines.push(visualClip(row, w));
      // Show lastActivity (server-sourced, all running/queued jobs) or lastPhase (live-follow, selected only).
      const activity = job.lastActivity;
      if (activity) {
        const age = fmtElapsed(now - new Date(activity.at).getTime());
        const ageStr = age ? ` (${age})` : '';
        lines.push(visualClip(`     ${col(`now: ${formatLogText(activity.text)}${ageStr}`, 90)}`, w));
      } else if (job.lastPhase) {
        lines.push(visualClip(`     ${col(job.lastPhase, 90)}`, w));
      }
      lines.push('');
    } else {
      // Terminal states: done, cancelled.
      const glyph = col('·', 90) + ' ';
      const row = `${sel} ${glyph} ${visualClip(job.id, 22).padEnd(22)}  ${col(stateDisplay.padEnd(9), 90)}  ${mode.padEnd(10)}  ${visualClip(targetDisplay, 17).padEnd(17)}  ${elapsed}`;
      lines.push(visualClip(row, w));
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const footerText = ROSTER_FOOTER_KEYS.map((k) => k.label).join('  ');
  lines.push(visualClip(col(`  ${footerText}`, 90), w));

  return lines.join('\n');
}

// ── Daemon helpers ────────────────────────────────────────────────────────────

type RawJob = {
  id: string;
  state: string;
  marker?: string;
  workOrder?: { mode?: string; target?: string; title?: string };
  createdAt?: string;
  updatedAt?: string;
  lastActivity?: { text: string; at: string };
};

type WireEvent = {
  seq?: number;
  type: string;
  text?: string;
  id?: string;
  question?: string;
  options?: Array<{ id: string; label?: string; recommended?: boolean }>;
};

/** Fetch the most recent pending decision for a blocked job from its event log. */
async function fetchDecision(
  jobId: string,
  env: Record<string, string | undefined>,
): Promise<BoardDecision | undefined> {
  try {
    let decision: BoardDecision | undefined;
    await request('GET', `/jobs/${encodeURIComponent(jobId)}/events`, undefined, {
      env,
      onLine: (line) => {
        try {
          const ev = JSON.parse(line) as WireEvent;
          if (ev.type === 'decision' && ev.id && ev.question && ev.options) {
            decision = { id: ev.id, question: ev.question, options: ev.options };
          }
          if (ev.type === 'answer') decision = undefined; // already answered elsewhere
        } catch {
          // ignore malformed events
        }
      },
      timeoutMs: 5_000,
    });
    return decision;
  } catch {
    return undefined;
  }
}

/**
 * Fetch current jobs from the daemon, enriching blocked jobs with their
 * pending decisions. Exported for tests.
 */
export async function fetchBoardJobs(
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; jobs?: BoardJob[]; error?: string }> {
  try {
    const res = await request('GET', '/jobs', undefined, { env });
    if (res.status !== 200) {
      return { ok: false, error: `daemon returned ${res.status}` };
    }
    const listed = res.json as { jobs: RawJob[] };
    const jobs: BoardJob[] = listed.jobs.map((r) => ({
      id: r.id,
      state: r.state,
      marker: r.marker,
      workOrder: r.workOrder,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastActivity: r.lastActivity,
    }));
    for (const job of jobs) {
      if (job.state === 'blocked') {
        job.decision = await fetchDecision(job.id, env);
      }
    }
    return { ok: true, jobs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Post an answer to a blocked job's open decision.
 * Exported so tests can verify the correct payload reaches the daemon
 * without needing a live TTY.
 */
export async function answerJob(
  jobId: string,
  body: { option?: string; text?: string },
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await request('POST', `/jobs/${encodeURIComponent(jobId)}/answer`, body, { env });
    if (res.status === 200) return { ok: true };
    const b = res.json as { error?: string } | undefined;
    return { ok: false, error: b?.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cancel a job. Exported for tests. */
export async function cancelJob(
  jobId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await request('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`, {}, { env });
    if (res.status === 200) return { ok: true };
    const b = res.json as { error?: string } | undefined;
    return { ok: false, error: b?.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Interactive board ─────────────────────────────────────────────────────────

const POLL_MS = 2_000;
const FRAME_MS = 100; // ≤10fps

/** Stream all events for a job into onEvent callbacks until signal aborts. */
async function followDetailEvents(
  jobId: string,
  onEvent: (ev: BoardEvent) => void,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<void> {
  let after: number | undefined;
  while (!signal.aborted) {
    const q = after === undefined ? '?follow=1' : `?after=${after}&follow=1`;
    try {
      await request('GET', `/jobs/${encodeURIComponent(jobId)}/events${q}`, undefined, {
        env,
        onLine: (line) => {
          try {
            const ev = JSON.parse(line) as BoardEvent;
            if (typeof ev.seq === 'number') after = ev.seq;
            onEvent(ev);
          } catch {
            // ignore malformed events
          }
        },
        timeoutMs: 30_000,
      });
    } catch {
      if (signal.aborted) break;
      await new Promise<void>((r) => setTimeout(r, 1_000));
    }
  }
}

/** Follow a job's events for live lastPhase updates until the signal aborts. */
async function followJobEvents(
  jobId: string,
  onPhase: (text: string) => void,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<void> {
  let after: number | undefined;
  while (!signal.aborted) {
    const q = after === undefined ? '?follow=1' : `?after=${after}&follow=1`;
    try {
      await request('GET', `/jobs/${encodeURIComponent(jobId)}/events${q}`, undefined, {
        env,
        onLine: (line) => {
          try {
            const ev = JSON.parse(line) as WireEvent;
            if (typeof ev.seq === 'number') after = ev.seq;
            if ((ev.type === 'think' || ev.type === 'log' || ev.type === 'phase') && ev.text) {
              onPhase(ev.text);
            }
          } catch {
            // ignore malformed events
          }
        },
        timeoutMs: 30_000,
      });
    } catch {
      if (signal.aborted) break;
      // Brief pause before retry on transient errors.
      await new Promise<void>((r) => setTimeout(r, 1_000));
    }
  }
}

export async function cmdBoard(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      once: { type: 'boolean' },
      // Force interactive mode even without a TTY (for automated tests of restore/SIGINT).
      'force-interactive': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });

  const forceInteractive = values['force-interactive'] === true;
  const once = values.once === true || (!forceInteractive && !process.stdout.isTTY);
  const noColor = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';
  const env = process.env as Record<string, string | undefined>;
  const endpoint = describeTarget(env);

  // ── Static (non-TTY / --once) mode ────────────────────────────────────────
  if (once) {
    const result = await fetchBoardJobs(env);
    if (!result.ok || result.jobs === undefined) {
      process.stderr.write(`board: cannot reach daemon at ${endpoint}: ${result.error ?? 'unknown error'}\n`);
      return 1;
    }
    const w = process.stdout.columns || 80;
    const frame = renderFrame(result.jobs, -1, w, { noColor, endpoint, now: Date.now() });
    process.stdout.write(`${frame}\n`);
    return 0;
  }

  // ── Interactive mode ───────────────────────────────────────────────────────

  // Gather context info at startup (best-effort; all fields optional).
  const contextInfo: ContextInfo = {};
  try {
    const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    if (branchRes.status === 0) contextInfo.branch = branchRes.stdout.trim();
    const originRes = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
    if (originRes.status === 0) {
      const m = originRes.stdout.trim().match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
      if (m) contextInfo.repo = m[1];
    }
  } catch { /* not in a git repo, or git not available */ }

  let jobs: BoardJob[] = [];
  let selection = 0;
  let running = true;
  let dirty = true;
  let lastPollMs = 0;
  let lastRenderMs = 0;

  // Roster phase-follow state.
  let followAbort: AbortController | null = null;
  let followedJobId: string | null = null;

  // Detail view state.
  let viewMode: 'roster' | 'detail' = 'roster';
  let detailJob: BoardJob | null = null;
  let detailEvents: BoardEvent[] = [];
  let detailScroll = 0;
  let detailFollowMode = true;
  let detailAbort: AbortController | null = null;

  // Answer mode state.
  let answerMode = false;
  let answerInput = '';
  let answerJobId: string | null = null;
  let answerOptions: Array<{ id: string; label?: string; recommended?: boolean }> = [];
  let statusMsg: string | null = null; // transient error shown on next render

  // Cancel confirm state.
  let confirmMode = false;

  const w = () => process.stdout.columns || 80;
  const h = () => process.stdout.rows || 24;

  // Use named handlers so they can be removed in cleanup.
  const onSignal = () => { running = false; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const cleanup = () => {
    followAbort?.abort();
    detailAbort?.abort();
    process.stdout.write(RESTORE_SEQ);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };

  // Enter alternate screen.
  process.stdout.write(`${ENTER_ALT}\x1b[2J\x1b[H`);

  const render = () => {
    const now = Date.now();
    if (now - lastRenderMs < FRAME_MS) return;
    lastRenderMs = now;
    dirty = false;

    let frame: string;

    if (viewMode === 'detail' && detailJob) {
      const counts = {
        blocked: jobs.filter((j) => j.state === 'blocked').length,
        running: jobs.filter((j) => j.state === 'running' || j.state === 'queued').length,
        done: jobs.filter((j) => j.state === 'done' || j.state === 'cancelled').length,
      };
      frame = renderDetailFrame(
        detailJob, detailEvents, detailScroll, detailFollowMode,
        w(), h(), { noColor, endpoint, context: contextInfo, now }, counts,
      );
    } else {
      const pulse = Math.floor(now / 600) % 2 === 0;
      const sorted = [...jobs].sort((a, b) => stateRank(a) - stateRank(b));
      const clampedSel = Math.max(0, Math.min(selection, sorted.length - 1));
      frame = renderFrame(sorted, clampedSel, w(), {
        noColor, endpoint, pulseOn: pulse, now, context: contextInfo, showBanner: true,
        colorLevel: detectColorLevel(process.env),
      });
    }

    // Overwrite from top without clearing: calm, no flicker.
    let out = '\x1b[H'; // cursor home
    for (const line of frame.split('\n')) {
      // Pad to terminal width to overwrite leftover characters from a shorter previous line.
      const vLen = visualLength(line);
      const pad = vLen < w() ? ' '.repeat(w() - vLen) : '';
      out += `${line}${pad}\r\n`;
    }
    // Overlay prompts; clear transient status once it has been shown.
    if (answerMode) {
      const opts = answerOptions.map((o) => o.id).join(' | ');
      out += `  Answer [${opts}] (id [note] or empty to cancel): ${answerInput}_`;
    } else if (confirmMode && detailJob) {
      out += `  Cancel ${detailJob.id}? [y/N]: `;
    } else if (statusMsg) {
      out += `  ${statusMsg}`;
      statusMsg = null;
    }
    out += '\x1b[J'; // clear to end of screen
    process.stdout.write(out);
  };

  const tick = async () => {
    try {
      const res = await request('GET', '/jobs', undefined, { env, timeoutMs: 5_000 });
      if (res.status !== 200) return;
      const listed = res.json as { jobs: RawJob[] };
      const next: BoardJob[] = listed.jobs as BoardJob[];

      // Carry over enriched data from previous state.
      for (const nj of next) {
        const oj = jobs.find((j) => j.id === nj.id);
        if (oj) {
          nj.lastPhase = oj.lastPhase;
          nj.decision = oj.decision;
          // lastActivity comes from the server; carry it if the new listing doesn't have it yet.
          if (!nj.lastActivity && oj.lastActivity) nj.lastActivity = oj.lastActivity;
        }
        // Fetch decisions for newly blocked jobs.
        if (nj.state === 'blocked' && !nj.decision) {
          nj.decision = await fetchDecision(nj.id, env);
        }
      }
      jobs = next;

      // Refresh detailJob in-place when its state changes.
      if (viewMode === 'detail' && detailJob) {
        const updated = jobs.find((j) => j.id === detailJob!.id);
        if (updated) detailJob = updated;
      }

      contextInfo.daemonReachable = true;
      dirty = true;

      // Long-poll selected running job (roster phase line) unless in detail mode.
      if (viewMode === 'roster') {
        const sorted = [...jobs].sort((a, b) => stateRank(a) - stateRank(b));
        const selJob = sorted[Math.max(0, Math.min(selection, sorted.length - 1))];
        if (
          selJob &&
          selJob.id !== followedJobId &&
          (selJob.state === 'running' || selJob.state === 'queued')
        ) {
          followAbort?.abort();
          followAbort = new AbortController();
          followedJobId = selJob.id;
          followJobEvents(
            selJob.id,
            (text) => {
              const j = jobs.find((jj) => jj.id === selJob.id);
              if (j) { j.lastPhase = text; dirty = true; }
            },
            env,
            followAbort.signal,
          ).catch(() => {});
        }
      }
    } catch {
      contextInfo.daemonReachable = false;
      // Keep last known state on transient daemon errors.
    }
  };

  const openDetail = (job: BoardJob) => {
    viewMode = 'detail';
    detailJob = job;
    detailEvents = [];
    detailScroll = 0;
    detailFollowMode = true;
    detailAbort?.abort();
    const ac = new AbortController();
    detailAbort = ac;
    followAbort?.abort();
    followAbort = null;
    followedJobId = null;
    followDetailEvents(
      job.id,
      // Guard against stale callbacks from aborted follows writing into new sessions.
      (ev) => { if (ac.signal.aborted) return; detailEvents = [...detailEvents, ev]; dirty = true; },
      env,
      ac.signal,
    ).catch(() => {});
    dirty = true;
  };

  const closeDetail = () => {
    viewMode = 'roster';
    detailAbort?.abort();
    detailAbort = null;
    detailJob = null;
    detailEvents = [];
    confirmMode = false;
    dirty = true;
  };

  const handleKey = async (key: string) => {
    if (answerMode) {
      if (key === '\r' || key === '\n') {
        const trimmed = answerInput.trim();
        answerInput = '';
        answerMode = false;
        if (trimmed && answerJobId) {
          const [optPart, ...rest] = trimmed.split(/\s+/);
          const body: { option?: string; text?: string } = {};
          if (optPart) body.option = optPart;
          if (rest.length > 0) body.text = rest.join(' ');
          const result = await answerJob(answerJobId, body, env);
          if (!result.ok) statusMsg = `answer failed: ${result.error ?? 'unknown error'}`;
        }
        answerJobId = null;
        answerOptions = [];
        dirty = true;
        return;
      }
      if (key === '\x7f' || key === '\b') {
        answerInput = answerInput.slice(0, -1);
        dirty = true;
        return;
      }
      if (key === '\x1b' || key === '\x03') {
        answerMode = false;
        answerInput = '';
        answerJobId = null;
        answerOptions = [];
        dirty = true;
        return;
      }
      if (key.length === 1 && key >= ' ') {
        answerInput += key;
        dirty = true;
      }
      return;
    }

    if (viewMode === 'detail') {
      // Cancel confirm prompt.
      if (confirmMode) {
        if (key === 'y' || key === 'Y') {
          confirmMode = false;
          if (detailJob) {
            await cancelJob(detailJob.id, env);
            closeDetail();
          }
        } else {
          confirmMode = false;
          dirty = true;
        }
        return;
      }

      switch (detailKeyAction(key)) {
        case 'back':
          closeDetail();
          break;
        case 'scroll-up':
          detailFollowMode = false;
          detailScroll = Math.max(0, detailScroll - 1);
          dirty = true;
          break;
        case 'scroll-down':
          detailFollowMode = false;
          detailScroll = detailScroll + 1;
          dirty = true;
          break;
        case 'restick':
          detailFollowMode = true;
          dirty = true;
          break;
        case 'answer':
          if (detailJob?.state === 'blocked' && detailJob.decision) {
            answerMode = true;
            answerJobId = detailJob.id;
            answerOptions = detailJob.decision.options;
            dirty = true;
          }
          break;
        case 'cancel':
          if (detailJob) {
            confirmMode = true;
            dirty = true;
          }
          break;
        case 'open': {
          // Print target to a status line in the frame (never launches a browser).
          const target = detailJob?.workOrder?.target ?? '';
          if (target) {
            process.stdout.write(`\r\n  open: ${target}\r\n`);
          }
          break;
        }
      }
      return;
    }

    // Roster mode.
    switch (rosterKeyAction(key)) {
      case 'quit':
        running = false;
        break;
      case 'navigate-up':
        selection = Math.max(0, selection - 1);
        dirty = true;
        break;
      case 'navigate-down': {
        const sortedLen = jobs.length; // same count as sorted; filter-safe if filtering added later
        selection = Math.min(sortedLen - 1, selection + 1);
        dirty = true;
        break;
      }
      case 'expand': {
        const sorted = [...jobs].sort((a, b) => stateRank(a) - stateRank(b));
        const selJob = sorted[Math.max(0, Math.min(selection, sorted.length - 1))];
        if (selJob) openDetail(selJob);
        break;
      }
      case 'answer': {
        const sorted = [...jobs].sort((a, b) => stateRank(a) - stateRank(b));
        const selJob = sorted[Math.max(0, Math.min(selection, sorted.length - 1))];
        if (selJob?.state === 'blocked' && selJob.decision) {
          answerMode = true;
          answerJobId = selJob.id;
          answerOptions = selJob.decision.options;
          dirty = true;
        }
        break;
      }
    }
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
  }
  process.stdin.on('data', (key: string) => { handleKey(key).catch(() => {}); });
  process.stdout.on('resize', () => { dirty = true; });

  // Initial fetch and render.
  await tick();
  render();

  // Main loop.
  await new Promise<void>((resolve) => {
    const loop = setInterval(() => {
      if (!running) { clearInterval(loop); resolve(); return; }
      const now = Date.now();
      if (now - lastPollMs >= POLL_MS) {
        lastPollMs = now;
        tick().catch(() => {});
      }
      if (dirty) render();
    }, FRAME_MS);
  });

  cleanup();
  return 0;
}
