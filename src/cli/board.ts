// The board: how a fleet of jobs looks on a terminal.
//
// Everything here is either a pure renderer — data in, ANSI string out, no TTY,
// no clock, no env, so a frame is snapshot-testable — or a daemon read that
// feeds one. The resident surface that composes them into panes and owns the
// keyboard is the cockpit (./cockpit.ts, `fleet` on a TTY); this file holds no
// loop and no I/O of its own beyond those reads.
//
// Zero dependencies: hand-rolled ANSI; erasable TS only.
import { request } from './client.ts';
import { formatJobState, formatLogText, renderEvent } from './format.ts';
import { makeCol, visualClip, visualLength, type ColFn } from './ansi.ts';
import { optionId, type FleetEvent, type PendingDecision } from '../shared/events.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BoardJob = {
  id: string;
  state: string;
  marker?: string;
  /** Cancellation reason (stall, wall-clock, ...) — rendered as cancelled(<reason>). */
  reason?: string;
  workOrder?: { mode?: string; target?: string; title?: string };
  createdAt?: string;
  updatedAt?: string;
  lastActivity?: { text: string; at: string }; // most recent think/log from the daemon (all jobs)
  decision?: PendingDecision; // pending decision enriched from event stream
  /** Delivered artifacts (settle outcome produced[] length). Settled jobs only. */
  artifacts?: number;
};

/** Context info shown in the header strip. Gathered at startup; optional fields. */
export type ContextInfo = {
  repo?: string;           // e.g. "owner/repo"
  branch?: string;         // e.g. "main"
  provider?: string;       // e.g. "process" | "docker" | "ecs"
  harnessCli?: string;     // e.g. "claude-code"
  daemonReachable?: boolean;
  /** Who owns the tunnel carrying this endpoint, when one does — e.g. "tunnel:adopted". */
  tunnel?: string;
};

export type FrameOpts = {
  noColor?: boolean;
  endpoint?: string;
  pulseOn?: boolean;
  now?: number;
  context?: ContextInfo;
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

/** Render one half-block character for a pair of pixel rows at column x. */
function renderPixelPair(top: boolean, bot: boolean, x: number, row: number, level: ColorLevel | undefined): string {
  if (!top && !bot) return ' ';
  if (!level) return top && bot ? '█' : top ? '▀' : '▄';
  const tc = planeColor(x, row * 2);
  const bc = planeColor(x, row * 2 + 1);
  if (top && bot) return fg(tc, level) + bg(bc, level) + '▀\x1b[0m';
  if (top) return fg(tc, level) + '▀\x1b[0m';
  return fg(bc, level) + '▄\x1b[0m';
}

/** Build the 4 banner lines: half-block plane + wordmark. Plain when level omitted. */
function buildBanner(level?: ColorLevel): string[] {
  const wide = PLANE_PX[0].length;
  const lines: string[] = [];
  for (let row = 0; row < PLANE_PX.length / 2; row++) {
    let line = ' ';
    for (let x = 0; x < wide; x++) {
      line += renderPixelPair(pxAt(x, row * 2), pxAt(x, row * 2 + 1), x, row, level);
    }
    lines.push(line);
  }
  lines[1] += !level ? '   F L E E T' : '   \x1b[1;38;5;153mF L E E T\x1b[0m';
  lines[2] += !level ? '   your cloud' : '   \x1b[2myour cloud\x1b[0m';
  return lines;
}

/** Small Fleet wordmark, plain form. Shown when the board starts; also `fleet --help`. */
export const FLEET_BANNER = buildBanner().join('\n');

// ── Terminal sequences ────────────────────────────────────────────────────────

/** Enter alternate screen buffer and hide cursor. */
export const ENTER_ALT = '\x1b[?1049h\x1b[?25l';
/** Show cursor and exit alternate screen buffer. */
export const RESTORE_SEQ = '\x1b[?25h\x1b[?1049l';

// ANSI helpers (makeCol / ColFn / visualLength / visualClip) live in ./ansi.ts
// (#128); the cockpit imports them from there directly.

/** Numeric-only target: #42 style. Hoisted so no inline regex in function bodies. */
const IS_NUMERIC = /^\d+$/;

// ── Pure frame renderers (new) ────────────────────────────────────────────────

/** Render the Fleet banner: gradient plane when colour is on, plain blocks otherwise. */
export function renderBanner(width: number, noColor: boolean, level: ColorLevel = '256'): string {
  const lines = noColor ? FLEET_BANNER.split('\n') : buildBanner(level);
  return lines.map((line) => visualClip(line, width)).join('\n');
}

/** Build the left-side context parts for the header strip. */
function buildContextParts(
  ctx: ContextInfo | undefined,
  endpoint: string | undefined,
  col: ColFn,
): string[] {
  const parts: string[] = [col('FLEET', 1, 36)];
  if (ctx?.repo) {
    const repoStr = ctx.branch ? ctx.repo + '/' + ctx.branch : ctx.repo;
    parts.push(col(repoStr, 36));
  }
  if (endpoint) {
    const dot = ctx?.daemonReachable === false ? col('○', 31) : col('●', 32);
    parts.push(col(endpoint, 90) + ' ' + dot);
  }
  if (ctx?.provider) parts.push(col(ctx.provider, 90));
  if (ctx?.harnessCli) parts.push(col(ctx.harnessCli, 90));
  if (ctx?.tunnel) parts.push(col(ctx.tunnel, 90));
  return parts;
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
  const ctx = opts.context;
  const endpoint = opts.endpoint;
  const parts = buildContextParts(ctx, endpoint, col);

  // Right-side: semantic count labels.
  const bLabel = blockedCount > 0 ? col(`blk:${blockedCount}`, 33) : col(`blk:0`, 90);
  const rLabel = runningCount > 0 ? col(`run:${runningCount}`, 32) : col(`run:0`, 90);
  const dLabel = col(`done:${doneCount}`, 90);
  const countsStr = `${bLabel} ${rLabel} ${dLabel}`;
  const countsVLen = visualLength(countsStr);

  // The counts are the smallest and most useful thing on this line, so the
  // context yields to them: a long repo/branch used to push them off the end
  // entirely, which is how "how many jobs want me" disappears on a narrow term.
  const leftContent = visualClip(` ${parts.join('  ')} `, Math.max(8, inner - countsVLen - 2));
  const leftVLen = visualLength(leftContent);

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

/**
 * Convert an event array to display lines for a job's tail, in the cockpit's
 * pane convention, every line clipped to width. The rendering itself is the
 * one switch in ./format.ts (#128); this owns what is pane-specific — the
 * pending-decisions map that lets an answer name its question, and clipping.
 */
export function renderEventLines(events: FleetEvent[], w: number, noColor: boolean): string[] {
  const col = makeCol(noColor);
  // Track pending decisions for "question → answer" rendering.
  const pending = new Map<string, string>();
  return events.flatMap((ev) =>
    renderEvent(ev, { kind: 'pane', col, pending }).map((line) => visualClip(line, w)),
  );
}

/**
 * Clamp a proposed tail scroll (lines back from the end) to the lines the tail
 * can actually render: min(proposed, total lines − 1), never negative. Counts
 * from the end and stops as soon as the proposal is known to fit — rendering
 * all ≤2000 tail events per keypress to learn one number was one of the two
 * O(n²) render costs #125 names. Line counts are what they would be in
 * `renderEventLines`: no renderer's line count depends on the pending map or
 * on colour, only on the event itself.
 */
export function clampTailScroll(events: FleetEvent[], proposed: number): number {
  if (proposed <= 0) return 0;
  const col = makeCol(true);
  const pending = new Map<string, string>();
  let lines = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    lines += renderEvent(events[i], { kind: 'pane', col, pending }).length;
    if (lines > proposed) return proposed;
  }
  return Math.max(0, lines - 1);
}

/**
 * The one-line identity of a job, for the drill-down header: id, state, mode,
 * target and elapsed. The title is shown in full (the caller clips to width),
 * and the separator is a colon here — "#42: Fix login" — against the roster's
 * space, because this is a contextual header and the roster is tabular data.
 */
export function renderJobLine(job: BoardJob, opts: FrameOpts): string {
  const col = makeCol(opts.noColor ?? false);
  const rawTarget = job.workOrder?.target ?? '?';
  const title = job.workOrder?.title;
  const ref = rawTarget.replace(IS_NUMERIC, '#$&');
  return [
    col(job.id, 1),
    col(formatJobState(job), stateColor(job)),
    job.workOrder?.mode ?? '?',
    title ? ref + ': ' + title : rawTarget,
    jobElapsed(job, opts.now ?? 0),
  ].filter(Boolean).join('  ');
}

// ── Job ordering ──────────────────────────────────────────────────────────────

export function stateRank(j: BoardJob): number {
  if (j.state === 'blocked') return 0;
  if (j.state === 'running' || j.state === 'queued') return 1;
  return 2;
}

/**
 * Board order: blocked first, then live, then settled. One sort for every
 * surface — a selection index means the same row wherever it is applied.
 * Stable within a rank, so a poll that returns the same jobs never reshuffles
 * the list under the operator's selection.
 */
export function sortJobs(jobs: BoardJob[]): BoardJob[] {
  return [...jobs].sort((a, b) => stateRank(a) - stateRank(b));
}

/** How many jobs are waiting on a human, running, and finished. */
export function jobCounts(jobs: BoardJob[]): { blocked: number; running: number; done: number } {
  return {
    blocked: jobs.filter((j) => j.state === 'blocked').length,
    running: jobs.filter((j) => j.state === 'running' || j.state === 'queued').length,
    done: jobs.filter((j) => j.state === 'done' || j.state === 'cancelled').length,
  };
}

/** Attention colour for a state: blocked wants the eye, running is alive, settled is quiet. */
function stateColor(job: BoardJob): number {
  if (job.state === 'blocked') return 33;
  if (job.state === 'running' || job.state === 'queued') return 32;
  return 90;
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

// ── Pure roster renderer ──────────────────────────────────────────────────────

/**
 * One job's rows: its table line plus whatever hangs under it (a decision card,
 * a `now:` activity line). Grouped rather than flattened so a bounded pane can
 * scroll by job without splitting a job away from its own detail.
 */
export type RosterRow = { jobIndex: number; lines: string[] };

/**
 * Render the roster rows for jobs already in board order (`sortJobs`).
 * Pure: deterministic given the same inputs; no TTY, no Date.now(), no env.
 *
 * `selection` is an index into that ordered list (-1 = nothing selected).
 * Blocked rows carry the pulsing urgency marker and their open decision;
 * running rows carry the latest activity the daemon reported.
 */
/**
 * A pending decision as lines: question, options (★ on the recommended one),
 * and how to act — an option id with no visible way to send it reads as a dead
 * end (operator feedback, first parked decision). One renderer for every place
 * a card appears: the roster and the drill-down's pinned card.
 */
export function decisionCardLines(decision: PendingDecision, w: number, noColor: boolean): string[] {
  const col = makeCol(noColor);
  const lines: string[] = [visualClip('     ' + col(decision.question, 1), w)];
  for (const opt of decision.options) {
    const rec = opt.recommended ? col(' ★', 33) : '';
    lines.push(visualClip('     [' + opt.id + '] ' + (opt.label ?? opt.id) + rec, w));
  }
  const ids = decision.options.map(optionId).join(' | ');
  lines.push(visualClip('     ' + col('answer: type an option id below — ' + ids, 33), w));
  return lines;
}

/** Urgency glyph for a roster row, pulsing on blocked. */
function jobGlyph(job: BoardJob, pulse: boolean, col: ColFn): string {
  if (job.state === 'blocked') return pulse ? col('!!', 1, 31) : col('!!', 33);
  if (job.state === 'running' || job.state === 'queued') return col('●', 32) + ' ';
  return col('·', 90) + ' ';
}

/**
 * Delivered-artifact suffix for a settled roster row (issue #81).
 * A done row with files must not look identical to an empty-handed one.
 */
function artifactSuffix(job: BoardJob, col: ColFn): string {
  const settled = job.state === 'done' || job.state === 'cancelled';
  if (!settled || (job.artifacts ?? 0) <= 0) return '';
  return '  ' + col(job.artifacts + ' file' + (job.artifacts === 1 ? '' : 's'), 90);
}

/** Extra lines below a roster row: decision card (blocked) or last activity (live). */
function jobExtraLines(job: BoardJob, noColor: boolean, now: number, w: number): string[] {
  const col = makeCol(noColor);
  if (job.state === 'blocked' && job.decision) {
    return [...decisionCardLines(job.decision, w, noColor), ''];
  }
  if ((job.state === 'running' || job.state === 'queued') && job.lastActivity) {
    // The daemon reports latest activity for every live job — not stream-dependent.
    // Only live jobs get it: "now:" under a settled job would describe the past.
    const age = fmtElapsed(now - new Date(job.lastActivity.at).getTime());
    const ageStr = age ? ' (' + age + ')' : '';
    return [visualClip('     ' + col('now: ' + formatLogText(job.lastActivity.text) + ageStr, 90), w)];
  }
  return [];
}

/** Build one roster row from a job snapshot. Called via .map() in renderRosterRows. */
function buildRosterRow(
  job: BoardJob,
  i: number,
  selection: number,
  col: ColFn,
  noColor: boolean,
  pulse: boolean,
  now: number,
  w: number,
): RosterRow {
  const sel = i === selection ? col('▶', 36) : ' ';
  const elapsed = jobElapsed(job, now);
  const mode = job.workOrder?.mode ?? '?';
  const rawTarget = job.workOrder?.target ?? '?';
  const title = job.workOrder?.title;
  // Prefer "#<n> <title>" when both are present.
  const ref = IS_NUMERIC.test(rawTarget) ? '#' + rawTarget : rawTarget;
  const targetDisplay = title ? ref + ' ' + title : rawTarget;
  const stateDisplay = formatJobState(job);
  const glyph = jobGlyph(job, pulse, col);
  const files = artifactSuffix(job, col);
  const row = sel + ' ' + glyph + ' ' + visualClip(job.id, 22).padEnd(22) + '  '
    + col(stateDisplay.padEnd(9), stateColor(job)) + '  ' + mode.padEnd(10) + '  '
    + visualClip(targetDisplay, 17).padEnd(17) + '  ' + elapsed + files;
  return { jobIndex: i, lines: [visualClip(row, w), ...jobExtraLines(job, noColor, now, w)] };
}

export function renderRosterRows(
  ordered: BoardJob[],
  selection: number,
  width: number,
  opts: FrameOpts = {},
): RosterRow[] {
  const noColor = opts.noColor ?? false;
  const now = opts.now ?? 0;
  const pulse = opts.pulseOn ?? false;
  const w = Math.max(40, width);
  const col = makeCol(noColor);

  return ordered.map((job, i) => buildRosterRow(job, i, selection, col, noColor, pulse, now, w));
}

// ── Daemon helpers ────────────────────────────────────────────────────────────

type RawJob = {
  id: string;
  state: string;
  marker?: string;
  reason?: string;
  workOrder?: { mode?: string; target?: string; title?: string };
  createdAt?: string;
  updatedAt?: string;
  lastActivity?: { text: string; at: string };
  /** Stored settle (daemon keeps it on the record); produced[] is the artifact list. */
  settle?: { outcome?: { produced?: unknown[] } };
};

/** Reduce one raw event line into the latest unanswered decision. */
function reducePendingDecision(
  line: string,
  current: PendingDecision | undefined,
): PendingDecision | undefined {
  try {
    const ev = JSON.parse(line) as FleetEvent;
    if (ev.type === 'decision' && ev.id && ev.question && ev.options) {
      return { id: ev.id, question: ev.question, options: ev.options };
    }
    if (ev.type === 'answer') return undefined; // already answered elsewhere
  } catch {
    // ignore malformed events
  }
  return current;
}

/** Transport for one events read: GET the path, stream body lines, return the status. */
type EventsGetter = (path: string, onLine: (line: string) => void) => Promise<{ status: number }>;

/**
 * Read a job's event log and reduce it to the most recent unanswered decision.
 * The one place that logic lives (#128): the board's roster (and through it
 * the cockpit) and `fleet resume` both come through here — the caller supplies
 * the transport, and with it its own error policy.
 */
export async function fetchPendingDecision(
  jobId: string,
  get: EventsGetter,
): Promise<{ status: number; decision?: PendingDecision }> {
  let decision: PendingDecision | undefined;
  const res = await get(`/jobs/${encodeURIComponent(jobId)}/events`, (line) => {
    decision = reducePendingDecision(line, decision);
  });
  return { status: res.status, decision };
}

/** Fetch the most recent pending decision for a blocked job from its event log. */
async function fetchDecision(
  jobId: string,
  env: Record<string, string | undefined>,
): Promise<PendingDecision | undefined> {
  try {
    const { decision } = await fetchPendingDecision(jobId, (reqPath, onLine) =>
      request('GET', reqPath, undefined, { env, onLine, timeoutMs: 5_000 }));
    return decision;
  } catch {
    return undefined;
  }
}

/**
 * A job's decision cache key: the job, at the revision it was last changed in.
 * The daemon bumps `updatedAt` on every state and marker change, and a blocked
 * job emits nothing while it waits — so this key is stable exactly as long as
 * the question is, and differs the moment a job is answered and blocks again.
 * Keying on the id alone is how a resident view ends up showing the previous
 * question next to the new one's job.
 */
function decisionKey(job: BoardJob): string {
  return `${job.id}@${job.updatedAt ?? ''}`;
}

/**
 * Drop one job's cached decision(s): the answer is the transition, so the next
 * poll must re-read what that job asks next. One job's, targeted — clearing
 * the whole cache here made answering one decision refetch every other blocked
 * job's full event log on the following poll (#125).
 */
export function invalidateDecision(cache: Map<string, PendingDecision>, jobId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${jobId}@`)) cache.delete(key);
  }
}

/**
 * Fetch current jobs from the daemon, enriching blocked jobs with their pending
 * decision — which the job listing does not carry, so it comes from the event
 * log, the same contract every other consumer reads (no daemon change earns a
 * view; if a view needs one, the event contract failed).
 *
 * `cache` makes that affordable for a polling caller: a blocked job's whole
 * event log, re-read every couple of seconds, is the one expensive thing a
 * resident board does. Pass a Map and it is read once per question; the cache is
 * pruned to the current listing, so it cannot outgrow the fleet.
 */
export async function fetchBoardJobs(
  env: Record<string, string | undefined>,
  cache?: Map<string, PendingDecision>,
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
      reason: r.reason,
      workOrder: r.workOrder,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastActivity: r.lastActivity,
      // Artifact count from the stored settle (issue #81): the listing already
      // carries it, so no extra read per job.
      ...(Array.isArray(r.settle?.outcome?.produced) && r.settle.outcome.produced.length > 0
        ? { artifacts: r.settle.outcome.produced.length }
        : {}),
    }));
    for (const job of jobs) {
      if (job.state !== 'blocked') continue;
      const key = decisionKey(job);
      const cached = cache?.get(key);
      if (cached !== undefined) {
        job.decision = cached;
        continue;
      }
      job.decision = await fetchDecision(job.id, env);
      if (job.decision !== undefined) cache?.set(key, job.decision);
    }
    if (cache) {
      const live = new Set(jobs.filter((j) => j.state === 'blocked').map(decisionKey));
      for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
    }
    return { ok: true, jobs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The one answer grammar, wherever an operator types one:
 *   "<option-id> [supplementary text]" | "text: <free text>" | "" (nothing).
 * `fleet attach --answer`, `fleet resume --answer` and the cockpit's input line
 * all parse through here, so an answer typed in one place cannot mean something
 * different in another.
 */
export function parseAnswerLine(line: string): { option?: string; text?: string } | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('text:')) {
    const text = trimmed.slice('text:'.length).trim();
    return text === '' ? undefined : { text };
  }
  const [option, ...rest] = trimmed.split(/\s+/);
  const text = rest.join(' ');
  return text ? { option, text } : { option };
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

// ── Live follow ───────────────────────────────────────────────────────────────

/**
 * Long-poll timeout: the daemon holds a `follow=1` read open, so this is not a
 * stall. Must exceed the daemon's long-poll window (exported so a test pins it).
 */
export const FOLLOW_TIMEOUT_MS = 30_000;

/** Pause before reopening a follow that failed or returned at once, so nothing is hammered. */
const FOLLOW_RETRY_MS = 1_000;

/**
 * A follow that comes back faster than this did not hold anything open. The
 * daemon holds one for its long-poll window, so this only fires against a peer
 * that closes immediately — and a resident view must idle there, not spin.
 */
const FOLLOW_HELD_MS = 250;

/**
 * Stream one job's events until the signal aborts, resuming with `?after=` from
 * the last daemon seq seen — daemon seqs are the authoritative ones, and the
 * only ones a consumer may resume from. The caller decides what an event means;
 * this only guarantees order and that a dropped connection reconnects.
 */
export async function followJobEvents(
  jobId: string,
  onEvent: (ev: FleetEvent) => void,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<void> {
  let after: number | undefined;
  while (!signal.aborted) {
    const q = after === undefined ? '?follow=1' : `?after=${after}&follow=1`;
    const startedAt = Date.now();
    let failed = false;
    try {
      await request('GET', `/jobs/${encodeURIComponent(jobId)}/events${q}`, undefined, {
        env,
        onLine: (line) => {
          try {
            const ev = JSON.parse(line) as FleetEvent;
            if (typeof ev.seq === 'number') after = ev.seq;
            onEvent(ev);
          } catch {
            // ignore malformed events
          }
        },
        timeoutMs: FOLLOW_TIMEOUT_MS,
        // Hanging up matters as much as reading: the daemon holds this open, and
        // a follow nobody is watching any more must not keep the socket — or the
        // process that owns it — alive.
        signal,
      });
    } catch {
      failed = true;
    }
    if (signal.aborted) break;
    if (failed || Date.now() - startedAt < FOLLOW_HELD_MS) {
      await new Promise<void>((r) => setTimeout(r, FOLLOW_RETRY_MS));
    }
  }
}
