// fleet board — full-screen live terminal view of the fleet.
// Zero dependencies: hand-rolled ANSI; erasable TS only.
import { parseArgs } from 'node:util';
import { request, describeTarget } from './client.ts';

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
  workOrder?: { mode?: string; target?: string };
  updatedAt?: string;
  lastPhase?: string;       // last think/log/phase text enriched from event stream
  decision?: BoardDecision; // pending decision enriched from event stream
};

export type FrameOpts = {
  noColor?: boolean;
  endpoint?: string;
  pulseOn?: boolean;
  now?: number;
};

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

// ── Job ordering ──────────────────────────────────────────────────────────────

export function stateRank(j: BoardJob): number {
  if (j.state === 'blocked') return 0;
  if (j.state === 'running' || j.state === 'queued') return 1;
  return 2;
}

// ── Elapsed time ──────────────────────────────────────────────────────────────

function elapsedStr(iso: string | undefined, nowMs: number): string {
  if (!iso) return '';
  const ms = nowMs - new Date(iso).getTime();
  if (ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return m % 60 > 0 ? `${h}h${m % 60}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
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

  function col(text: string, ...codes: number[]): string {
    if (noColor) return text;
    return `${ansi(...codes)}${text}${RESET}`;
  }

  const sorted = [...jobs].sort((a, b) => stateRank(a) - stateRank(b));

  const blockedCount = jobs.filter((j) => j.state === 'blocked').length;
  const runningCount = jobs.filter((j) => j.state === 'running' || j.state === 'queued').length;
  const doneCount = jobs.filter((j) => j.state === 'done' || j.state === 'cancelled').length;

  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  const endpoint = opts.endpoint ?? '';
  const bLabel = blockedCount > 0 ? col(`blocked:${blockedCount}`, 33) : `blocked:0`;
  const rLabel = runningCount > 0 ? col(`running:${runningCount}`, 32) : `running:0`;
  const headerParts = [col('fleet board', 1), endpoint, bLabel, rLabel, `done:${doneCount}`]
    .filter(Boolean)
    .join('  ');
  lines.push(visualClip(headerParts, w));
  lines.push('─'.repeat(w));

  if (sorted.length === 0) {
    lines.push(col('  no jobs — delegate one with: fleet delegate <target>', 90));
  }

  for (let i = 0; i < sorted.length; i++) {
    const job = sorted[i];
    const isSel = i === selection;
    const sel = isSel ? col('▶', 36) : ' ';
    const elapsed = elapsedStr(job.updatedAt, now);
    const mode = job.workOrder?.mode ?? '?';
    const target = job.workOrder?.target ?? '?';
    const stateDisplay = job.marker ? `${job.state}(${job.marker})` : job.state;

    if (job.state === 'blocked') {
      // Urgency marker pulses on a ~600ms cycle.
      const urgency = pulse ? col('!!', 1, 31) : col('!!', 33);
      const row = `${sel} ${urgency} ${visualClip(job.id, 22)}  ${col(stateDisplay, 33)}  ${mode}  ${visualClip(target, 28)}  ${elapsed}`;
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
      const glyph = col('●', 32);
      const row = `${sel} ${glyph} ${visualClip(job.id, 22)}  ${col(job.state, 32)}  ${mode}  ${visualClip(target, 28)}  ${elapsed}`;
      lines.push(visualClip(row, w));
      if (job.lastPhase) {
        lines.push(visualClip(`     ${col(job.lastPhase, 90)}`, w));
      }
      lines.push('');
    } else {
      // Terminal states: done, cancelled.
      const glyph = col('·', 90);
      const row = `${sel} ${glyph} ${visualClip(job.id, 22)}  ${col(stateDisplay, 90)}  ${mode}  ${visualClip(target, 28)}  ${elapsed}`;
      lines.push(visualClip(row, w));
    }
  }

  lines.push('─'.repeat(w));
  lines.push(visualClip(col('  ↑↓ select  enter expand  a answer  q quit', 90), w));

  return lines.join('\n');
}

// ── Daemon helpers ────────────────────────────────────────────────────────────

type RawJob = {
  id: string;
  state: string;
  marker?: string;
  workOrder?: { mode?: string; target?: string };
  updatedAt?: string;
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
    const jobs: BoardJob[] = listed.jobs as BoardJob[];
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

// ── Interactive board ─────────────────────────────────────────────────────────

const POLL_MS = 2_000;
const FRAME_MS = 100; // ≤10fps

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
  let jobs: BoardJob[] = [];
  let selection = 0;
  let running = true;
  let dirty = true;
  let lastPollMs = 0;
  let lastRenderMs = 0;
  let followAbort: AbortController | null = null;
  let followedJobId: string | null = null;

  // Answer mode state.
  let answerMode = false;
  let answerInput = '';
  let answerJobId: string | null = null;
  let answerOptions: Array<{ id: string; label?: string; recommended?: boolean }> = [];

  const w = () => process.stdout.columns || 80;

  // Use named handlers so they can be removed in cleanup.
  const onSignal = () => { running = false; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const cleanup = () => {
    followAbort?.abort();
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
    const pulse = Math.floor(now / 600) % 2 === 0;
    const sorted = [...jobs].sort((a, b) => stateRank(a) - stateRank(b));
    const clampedSel = Math.max(0, Math.min(selection, sorted.length - 1));
    const frame = renderFrame(sorted, clampedSel, w(), { noColor, endpoint, pulseOn: pulse, now });

    // Overwrite from top without clearing: calm, no flicker.
    let out = '\x1b[H'; // cursor home
    for (const line of frame.split('\n')) {
      // Pad to terminal width to overwrite leftover characters from a shorter previous line.
      const vLen = visualLength(line);
      const pad = vLen < w() ? ' '.repeat(w() - vLen) : '';
      out += `${line}${pad}\r\n`;
    }
    // Append answer prompt when active.
    if (answerMode) {
      const opts = answerOptions.map((o) => o.id).join(' | ');
      out += `  Answer [${opts}] (id [note] or empty to cancel): ${answerInput}_`;
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
        }
        // Fetch decisions for newly blocked jobs.
        if (nj.state === 'blocked' && !nj.decision) {
          nj.decision = await fetchDecision(nj.id, env);
        }
      }
      jobs = next;
      dirty = true;

      // Long-poll selected running job for live phase updates.
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
    } catch {
      // Keep last known state on transient daemon errors.
    }
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
          await answerJob(answerJobId, body, env);
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

    if (key === 'q' || key === '\x03') { running = false; return; }
    if (key === '\x1b[A') {
      // arrow up
      selection = Math.max(0, selection - 1);
      dirty = true;
    } else if (key === '\x1b[B') {
      // arrow down
      selection = Math.min(jobs.length - 1, selection + 1);
      dirty = true;
    } else if (key === 'a') {
      // Answer selected blocked job.
      const sorted = [...jobs].sort((a, b) => stateRank(a) - stateRank(b));
      const selJob = sorted[Math.max(0, Math.min(selection, sorted.length - 1))];
      if (selJob?.state === 'blocked' && selJob.decision) {
        answerMode = true;
        answerJobId = selJob.id;
        answerOptions = selJob.decision.options;
        dirty = true;
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
