// The board's rendering primitives and the daemon reads that feed them.
// Every renderer here is pure, so these are exact-text assertions rather than
// terminal wrangling; the surface that composes them is test/cli-cockpit.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import {
  FLEET_BANNER,
  answerJob,
  cancelJob,
  clampTailScroll,
  fetchBoardJobs,
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
  type BoardJob,
} from '../src/cli/board.ts';
import { visualClip, visualLength } from '../src/cli/ansi.ts';
import type { FleetEvent, PendingDecision } from '../src/shared/events.ts';
import { startMockDaemon, sendJson, sendNdjson, EVENT_BATTERY, type MockRequest } from './cli-helpers.ts';

/** The roster as text, the way a pane would show it. */
function roster(jobs: BoardJob[], selection = -1, width = 100, now = 0, pulseOn = false): string {
  return renderRosterRows(sortJobs(jobs), selection, width, { noColor: true, now, pulseOn })
    .flatMap((r) => r.lines)
    .join('\n');
}

// ── Roster rows ───────────────────────────────────────────────────────────────

test('elapsed: settled jobs freeze at total runtime; live jobs keep counting', () => {
  const done: BoardJob = {
    id: 'job-done', state: 'done', workOrder: { mode: 'implement', target: '3' },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:12:00Z',
  };
  const run: BoardJob = { ...done, id: 'job-run', state: 'running' };
  const at = (min: number) => Date.parse('2026-01-01T00:00:00Z') + min * 60_000;
  // Done: 12m at settle, still 12m a day later.
  assert.match(roster([done], -1, 100, at(20)), /job-done.*12m/);
  assert.match(roster([done], -1, 100, at(60 * 24)), /job-done.*12m/);
  // Running: counts from dispatch, not from the last event.
  assert.match(roster([run], -1, 100, at(20)), /job-run.*20m/);
  assert.match(roster([run], -1, 100, at(45)), /job-run.*45m/);
});

test('sortJobs: blocked before running before terminal, stable within a rank', () => {
  const jobs: BoardJob[] = [
    { id: 'job-run', state: 'running' },
    { id: 'job-don', state: 'done' },
    { id: 'job-blk', state: 'blocked' },
    { id: 'job-run2', state: 'queued' },
  ];
  assert.deepEqual(sortJobs(jobs).map((j) => j.id), ['job-blk', 'job-run', 'job-run2', 'job-don']);
  // Sorting twice must not reshuffle: the selection index has to mean one row.
  assert.deepEqual(sortJobs(sortJobs(jobs)).map((j) => j.id), sortJobs(jobs).map((j) => j.id));
  assert.deepEqual(jobCounts(jobs), { blocked: 1, running: 2, done: 1 });
});

test('a cancelled job shows its reason — cancelled(stall) is not cancelled(wall-clock)', () => {
  const stalled: BoardJob = {
    id: 'job-stall', state: 'cancelled', reason: 'stall',
    workOrder: { mode: 'implement', target: '39' },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:25:00Z',
  };
  const budget: BoardJob = { ...stalled, id: 'job-budget', reason: 'wall-clock' };
  const text = roster([stalled, budget]);
  assert.match(text, /job-stall\s+cancelled\(stall\)/);
  assert.match(text, /job-budget\s+cancelled\(wall-clock\)/, 'the two cancellations must not look alike');
  assert.match(renderJobLine(stalled, { noColor: true }), /cancelled\(stall\)/, 'the job line carries it too');
});

test('decision options render verbatim; recommended marked, others not', () => {
  const blocked: BoardJob = {
    id: 'job-blk',
    state: 'blocked',
    workOrder: { mode: 'implement', target: 'app' },
    decision: {
      id: 'd1',
      question: 'Rename the endpoint?',
      options: [
        { id: 'keep', label: 'Keep /api/v1', recommended: true },
        { id: 'rename', label: 'Rename to /api/v2' },
      ],
    },
  };
  const lines = roster([blocked], -1, 120).split('\n');
  assert.ok(lines.some((l) => l.includes('Rename the endpoint?')), 'question rendered verbatim');
  const keep = lines.find((l) => l.includes('[keep]'));
  const rename = lines.find((l) => l.includes('[rename]'));
  assert.match(keep ?? '', /Keep \/api\/v1 ★/, 'recommended option carries its label and ★');
  assert.match(rename ?? '', /Rename to \/api\/v2/);
  assert.doesNotMatch(rename ?? '', /★/, 'non-recommended option has no ★');
});

test('rows keep a job with its own detail: one group per job', () => {
  const jobs: BoardJob[] = [
    {
      id: 'job-blk', state: 'blocked',
      decision: { id: 'd1', question: 'Q?', options: [{ id: 'a' }, { id: 'b' }] },
    },
    { id: 'job-run', state: 'running', lastActivity: { text: 'writing tests', at: new Date(0).toISOString() } },
  ];
  const rows = renderRosterRows(sortJobs(jobs), 0, 100, { noColor: true, now: 5_000 });
  assert.equal(rows.length, 2, 'one group per job');
  // Blocked: row + question + two options + the answer hint + a blank separator.
  assert.equal(rows[0].lines.length, 6);
  assert.equal(rows[0].jobIndex, 0);
  // Running: row + its now-line.
  assert.equal(rows[1].lines.length, 2);
  assert.match(rows[1].lines[1], /now: writing tests \(5s\)/);
});

test('a running job with no reported activity gets no now-line', () => {
  const rows = renderRosterRows([{ id: 'job-x', state: 'running' }], -1, 100, { noColor: true, now: 0 });
  assert.equal(rows[0].lines.length, 1);
});

test('roster rows are clipped to the given width', () => {
  const jobs: BoardJob[] = [
    {
      id: 'job-with-a-very-long-identifier-that-overflows',
      state: 'running',
      workOrder: { mode: 'implement', target: 'a-target-name-that-is-also-unreasonably-long' },
    },
    {
      id: 'blocked-job',
      state: 'blocked',
      workOrder: { mode: 'assess', target: 'some-repo' },
      decision: {
        id: 'd1',
        question: 'A question that is also extremely long and will definitely exceed the terminal width on its own',
        options: [{ id: 'yes', label: 'Yes please do the thing that is very long label', recommended: true }],
      },
    },
  ];
  for (const line of roster(jobs, -1, 60).split('\n')) {
    assert.ok(line.length <= 60, `line exceeds width 60: "${line}" (${line.length})`);
  }
});

test('noColor emits no ANSI; colour mode does', () => {
  const jobs: BoardJob[] = [
    { id: 'job-blk', state: 'blocked', decision: { id: 'd1', question: 'Q?', options: [{ id: 'a', recommended: true }] } },
    { id: 'job-run', state: 'running' },
    { id: 'job-don', state: 'done' },
  ];
  assert.doesNotMatch(roster(jobs, 0), /\x1b\[/, 'ANSI escapes present with noColor=true');
  const coloured = renderRosterRows(sortJobs(jobs), 0, 80, { noColor: false })
    .flatMap((r) => r.lines).join('\n');
  assert.match(coloured, /\x1b\[/, 'colour mode should contain ANSI codes');
});

test('roster rows: NO_COLOR output is stable (snapshot)', () => {
  // This exact text is the contract. A change here is a visible rendering change.
  const jobs: BoardJob[] = [
    {
      id: 'job-blk',
      state: 'blocked',
      workOrder: { mode: 'assess', target: 'docs' },
      decision: {
        id: 'd1',
        question: 'Deploy now?',
        options: [
          { id: 'go', label: 'Deploy now', recommended: true },
          { id: 'wait', label: 'Wait for review' },
        ],
      },
    },
    { id: 'job-run', state: 'running', workOrder: { mode: 'implement', target: 'app' } },
    { id: 'job-done', state: 'done', workOrder: { mode: 'assess', target: 'notes' }, artifacts: 3 },
  ];
  assert.equal(roster(jobs, 0, 80), [
    '▶ !! job-blk                 blocked    assess      docs               ',
    '     Deploy now?',
    '     [go] Deploy now ★',
    '     [wait] Wait for review',
    '     answer: type an option id below — go | wait',
    '',
    '  ●  job-run                 running    implement   app                ',
    '  ·  job-done                done       assess      notes                3 files',
  ].join('\n'));
});

test('a done row shows its delivered-artifact count; empty or live rows do not (#81)', () => {
  // The delivery guarantee has to be visible where the job reads as finished:
  // a done job with files waiting must not look identical to an empty-handed one.
  const done: BoardJob = { id: 'job-done', state: 'done', workOrder: { mode: 'assess', target: 'docs' }, artifacts: 3 };
  assert.match(roster([done]), /job-done.*3 files/);
  // Singular for one file — "1 files" reads as a bug.
  assert.match(roster([{ ...done, artifacts: 1 }]), /job-done.*1 file(?!s)/);
  // Zero or unknown: no marker at all, not "0 files".
  assert.doesNotMatch(roster([{ ...done, artifacts: 0 }]), /file/);
  assert.doesNotMatch(roster([{ ...done, artifacts: undefined }]), /file/);
  // A live job never carries the marker: its settle has not happened, so any
  // count on it would be stale data wearing a delivery badge.
  assert.doesNotMatch(roster([{ ...done, state: 'running' }]), /file/);
  // A cancelled job that still delivered artifacts shows them — partial
  // delivery is exactly when the operator needs to know files exist.
  assert.match(roster([{ ...done, state: 'cancelled', reason: 'stall' }]), /job-done.*3 files/);
});

test('the blocked marker pulses, and only the blocked one', () => {
  const jobs: BoardJob[] = [{ id: 'job-blk', state: 'blocked' }, { id: 'job-run', state: 'running' }];
  const off = renderRosterRows(sortJobs(jobs), -1, 80, { noColor: false, pulseOn: false })[0].lines[0];
  const on = renderRosterRows(sortJobs(jobs), -1, 80, { noColor: false, pulseOn: true })[0].lines[0];
  assert.notEqual(off, on, 'the urgency marker must change between pulse phases');
  const runOff = renderRosterRows(sortJobs(jobs), -1, 80, { noColor: false, pulseOn: false })[1].lines[0];
  const runOn = renderRosterRows(sortJobs(jobs), -1, 80, { noColor: false, pulseOn: true })[1].lines[0];
  assert.equal(runOff, runOn, 'a running row must not flicker');
});

test('title renders as #<n> <title> in the roster and #<n>: <title> in a job line', () => {
  const job: BoardJob = { id: 'job-run', state: 'running', workOrder: { mode: 'implement', target: '42', title: 'Fix login' } };
  assert.match(roster([job], -1, 120), /#42 Fix login/);
  assert.match(renderJobLine(job, { noColor: true }), /#42: Fix login/);
  // Without a title, a numeric target renders bare — no invented # prefix.
  const bare: BoardJob = { id: 'job-run', state: 'running', workOrder: { mode: 'implement', target: '42' } };
  assert.doesNotMatch(roster([bare], -1, 120), /#42/);
});

test('the selection marker lands on the selected row and nowhere else', () => {
  const jobs: BoardJob[] = [{ id: 'job-run', state: 'running' }, { id: 'job-blk', state: 'blocked' }];
  // Sorted order puts blocked at index 0.
  const first = roster(jobs, 0).split('\n');
  assert.ok(first.find((l) => l.includes('job-blk'))?.includes('▶'));
  assert.ok(!first.find((l) => l.includes('job-run'))?.includes('▶'));
  const second = roster(jobs, 1).split('\n');
  assert.ok(second.find((l) => l.includes('job-run'))?.includes('▶'));
});

// ── Event lines ───────────────────────────────────────────────────────────────

test('renderEventLines: a decision becomes a card, and its answer names the question', () => {
  const events: FleetEvent[] = [
    { seq: 0, type: 'state', state: 'running' },
    { seq: 1, type: 'think', text: 'reading the schema' },
    {
      seq: 2, type: 'decision', id: 'd1', question: 'Which path?',
      options: [{ id: 'a', label: 'Alpha', recommended: true }, { id: 'b', label: 'Beta' }],
    },
    { seq: 3, type: 'answer', decision: 'd1', option: 'a', by: 'operator' },
    { seq: 4, type: 'settle', rung: 'pr-open', report: { status: 'READY' } },
  ];
  const text = renderEventLines(events, 100, true).join('\n');
  assert.match(text, /\[2\] \? Which path\?/, 'the question, verbatim');
  assert.match(text, /\[a\] Alpha ★/);
  assert.match(text, /\[b\] Beta/);
  assert.match(text, /\[3\] ✓ "Which path\?" → \[a\] by operator/, 'the answer names what it answered');
  assert.match(text, /\[4\] settle rung=pr-open status=READY/);
  // An unknown event type still renders as a line rather than disappearing.
  assert.match(renderEventLines([{ seq: 9, type: 'tool_use' }], 100, true).join('\n'), /\[9\] tool_use/);
});

test('renderEventLines: exact output for every event type, color and noColor (#128 characterization)', () => {
  // Byte-for-byte pins captured before the rendering paths were unified: the
  // cockpit pane convention must not drift when the shared rendering core
  // changes. If a change here is deliberate, update the pin and say why in
  // the commit. Same battery as the formatEvent pin in cli-ops.test.ts.
  const expectedColor = [
    '\x1b[90m[1]\x1b[0m \x1b[90m→\x1b[0m \x1b[32mrunning\x1b[0m',
    '\x1b[90m[2]\x1b[0m \x1b[90m→\x1b[0m \x1b[33mblocked\x1b[0m',
    '\x1b[90m[3]\x1b[0m \x1b[90mphase\x1b[0m \x1b[90msetup\x1b[0m',
    '\x1b[90m[4]\x1b[0m \x1b[90mplanning the change\x1b[0m',
    '\x1b[90m[5]\x1b[0m \x1b[90mtool_use Read: {"file_path":"/p/a.ts","limit":5}\x1b[0m',
    '\x1b[90m[6]\x1b[0m \x1b[90mplain line\x1b[0m',
    '\x1b[90m[7]\x1b[0m \x1b[90mprogress\x1b[0m',
    '\x1b[90m[8]\x1b[0m \x1b[1;33m?\x1b[0m \x1b[1mWhich way?\x1b[0m',
    '     \x1b[33m[a]\x1b[0m Left\x1b[33m ★\x1b[0m',
    '     \x1b[33m[b]\x1b[0m Right',
    '     \x1b[33m[c]\x1b[0m c',
    '     \x1b[33manswer: type an option id below — a | b | c\x1b[0m',
    '\x1b[90m[9]\x1b[0m \x1b[32m✓\x1b[0m \x1b[90m"Which way?"\x1b[0m → \x1b[32m[a]\x1b[0m\x1b[90m by vince\x1b[0m',
    '\x1b[90m[10]\x1b[0m \x1b[32m✓\x1b[0m answer: \x1b[90m(free text)\x1b[0m',
    '\x1b[90m[11]\x1b[0m \x1b[32m✓\x1b[0m answer: \x1b[90m(free text)\x1b[0m',
    '\x1b[90m[12]\x1b[0m \x1b[36msettle\x1b[0m rung=\x1b[36mpr-open\x1b[0m status=\x1b[36mREADY\x1b[0m',
    '\x1b[90m[13]\x1b[0m \x1b[36msettle\x1b[0m rung=\x1b[36m?\x1b[0m status=\x1b[36mPARTIAL\x1b[0m',
    '\x1b[90m[14]\x1b[0m \x1b[90mpair\x1b[0m',
  ];
  const expectedNoColor = [
    '[1] → running',
    '[2] → blocked',
    '[3] phase setup',
    '[4] planning the change',
    '[5] tool_use Read: {"file_path":"/p/a.ts","limit":5}',
    '[6] plain line',
    '[7] progress',
    '[8] ? Which way?',
    '     [a] Left ★',
    '     [b] Right',
    '     [c] c',
    '     answer: type an option id below — a | b | c',
    '[9] ✓ "Which way?" → [a] by vince',
    '[10] ✓ answer: (free text)',
    '[11] ✓ answer: (free text)',
    '[12] settle rung=pr-open status=READY',
    '[13] settle rung=? status=PARTIAL',
    '[14] pair',
  ];
  const battery = EVENT_BATTERY as FleetEvent[];
  assert.deepEqual(renderEventLines(battery, 100, false), expectedColor);
  assert.deepEqual(renderEventLines(battery, 100, true), expectedNoColor);
  // Width applies to every line, including card lines, without reordering.
  const narrow = renderEventLines(battery, 40, false);
  assert.equal(narrow[4], '\x1b[90m[5]\x1b[0m \x1b[90mtool_use Read: {"file_path":"/p/a.t…\x1b[0m');
  assert.equal(narrow[11], '     \x1b[33manswer: type an option id below — …\x1b[0m');
});

test('renderEventLines: every line is clipped to width', () => {
  const events: FleetEvent[] = [{ seq: 0, type: 'log', text: 'a '.repeat(80) }];
  for (const line of renderEventLines(events, 60, true)) assert.ok(line.length <= 60);
});

test('clampTailScroll agrees with the full render it replaces, at every proposal', () => {
  // The cockpit used to render the entire tail per PgUp keypress just to learn
  // the scroll ceiling (#125). The cheap count must clamp exactly like
  // min(proposed, total lines − 1) over renderEventLines — the battery includes
  // multi-line decision cards, so a per-event line count that drifted from the
  // renderer's would fail here.
  const battery = EVENT_BATTERY as FleetEvent[];
  const total = renderEventLines(battery, 1_000, true).length;
  for (const proposed of [-5, 0, 1, 3, total - 1, total, total + 50]) {
    assert.equal(
      clampTailScroll(battery, proposed),
      Math.max(0, Math.min(proposed, total - 1)),
      `proposal ${proposed} (total ${total} lines)`,
    );
  }
  assert.equal(clampTailScroll([], 7), 0, 'an empty tail has nowhere to scroll');
});

test('invalidateDecision drops exactly one job\'s cached decisions', () => {
  const decision: PendingDecision = { id: 'd1', question: 'q', options: [{ id: 'a' }, { id: 'b' }] };
  const cache = new Map<string, PendingDecision>([
    ['job-a@2026-01-01T00:00:00Z', decision],
    ['job-a@2026-01-02T00:00:00Z', decision],
    ['job-b@2026-01-01T00:00:00Z', decision],
  ]);
  invalidateDecision(cache, 'job-a');
  assert.deepEqual([...cache.keys()], ['job-b@2026-01-01T00:00:00Z'], 'only the answered job is dropped');
});

// ── Chrome ────────────────────────────────────────────────────────────────────

test('FLEET_BANNER is exactly 4 lines and under 30 chars wide', () => {
  const lines = FLEET_BANNER.split('\n');
  assert.equal(lines.length, 4);
  for (const line of lines) assert.ok(line.length <= 30, `banner line too wide (${line.length}): "${line}"`);
});

test('renderBanner: noColor is plain, colour is not, both clip to width', () => {
  const plain = renderBanner(80, true);
  assert.doesNotMatch(plain, /\x1b\[/);
  assert.equal(plain.split('\n').length, 4);
  assert.match(renderBanner(80, false, '24bit'), /\x1b\[38;2;/, 'truecolor terminals get truecolor');
  assert.match(renderBanner(80, false, '256'), /\x1b\[38;5;/, '256-colour terminals get the cube');
  for (const line of renderBanner(10, true).split('\n')) assert.ok(line.length <= 10);
});

test('renderContextStrip: two lines, or three with a job line', () => {
  assert.equal(renderContextStrip(1, 2, 3, 80, { noColor: true }).split('\n').length, 2);
  assert.equal(renderContextStrip(1, 2, 3, 80, { noColor: true }, 'job-x  running').split('\n').length, 3);
});

test('renderContextStrip: context, counts and tunnel ownership all appear', () => {
  const out = renderContextStrip(0, 1, 0, 100, {
    noColor: true,
    endpoint: 'http://localhost:7744',
    context: { repo: 'acme/app', branch: 'main', provider: 'docker', tunnel: 'tunnel:adopted' },
  });
  assert.match(out, /acme\/app\/main/, 'repo/branch shown');
  assert.match(out, /http:\/\/localhost:7744/, 'endpoint shown');
  assert.match(out, /docker/, 'provider shown');
  assert.match(out, /tunnel:adopted/, 'who owns the tunnel is part of the context');
  assert.match(out, /run:1/, 'running count shown');
});

test('renderContextStrip: the job-line row is exactly terminal width in colour mode', () => {
  // Catches the ANSI-blind padEnd bug: String.padEnd counts escape bytes, which
  // leaves the closing │ at the wrong visual column.
  const job: BoardJob = { id: 'job-blk', state: 'blocked', workOrder: { mode: 'assess', target: '#42' } };
  for (const noColor of [true, false]) {
    const strip = renderContextStrip(1, 0, 0, 80, { noColor }, renderJobLine(job, { noColor }));
    assert.equal(visualLength(strip.split('\n')[1]), 80, `colour=${!noColor} job row must fill the width`);
  }
});

test('renderTableHeader: two lines, clipped, dim', () => {
  assert.match(renderTableHeader(100, true).split('\n')[0], /JOB\s+STATE\s+MODE\s+TARGET\s+ELAPSED/);
  const header = renderTableHeader(60, true).split('\n');
  assert.equal(header.length, 2);
  for (const line of header) assert.ok(line.length <= 60);
});

test('visualClip counts visible characters, not escape bytes', () => {
  assert.equal(visualClip('abcdef', 4), 'abc…');
  assert.equal(visualClip('abc', 4), 'abc');
  const coloured = visualClip('\x1b[32mabcdef\x1b[0m', 4);
  assert.equal(visualLength(coloured), 4, 'clipped to 4 visible columns');
  assert.ok(coloured.endsWith('\x1b[0m'), 'an open colour is closed when clipped');
});

// ── The answer grammar ────────────────────────────────────────────────────────

test('parseAnswerLine: one grammar for every place an answer is typed', () => {
  assert.deepEqual(parseAnswerLine('keep'), { option: 'keep' });
  assert.deepEqual(parseAnswerLine('  keep  '), { option: 'keep' });
  assert.deepEqual(parseAnswerLine('keep but rename later'), { option: 'keep', text: 'but rename later' });
  assert.deepEqual(parseAnswerLine('text: do whatever seems right'), { text: 'do whatever seems right' });
  assert.equal(parseAnswerLine(''), undefined, 'an empty line answers nothing');
  assert.equal(parseAnswerLine('text:'), undefined, 'an empty free text answers nothing either');
});

// ── Daemon reads ──────────────────────────────────────────────────────────────

const DECISION_EVENTS = [
  { job: 'job-blk', seq: 0, type: 'state', state: 'running' },
  {
    job: 'job-blk', seq: 1, type: 'decision', id: 'd1', question: 'Merge now?',
    options: [{ id: 'yes', label: 'Yes', recommended: true }, { id: 'no', label: 'No' }],
  },
  { job: 'job-blk', seq: 2, type: 'state', state: 'blocked' },
];

test('fetchBoardJobs enriches a blocked job with the decision it is waiting on', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        jobs: [{ id: 'job-blk', state: 'blocked', updatedAt: '2026-01-01T00:00:00Z', workOrder: { mode: 'assess', target: 'docs' } }],
      }),
    'GET /jobs/job-blk/events': (_req: MockRequest, res: ServerResponse) => sendNdjson(res, DECISION_EVENTS),
  });
  t.after(daemon.close);

  const result = await fetchBoardJobs({ FLEET_DAEMON_URL: daemon.url });
  assert.ok(result.ok, `fetchBoardJobs failed: ${result.error}`);
  const decision = result.jobs![0].decision;
  assert.equal(decision?.question, 'Merge now?');
  assert.deepEqual(decision?.options.map((o) => o.id), ['yes', 'no']);
  assert.ok(decision?.options[0].recommended);
});

test('fetchBoardJobs: a cached decision is not re-read, and a re-block is not served the old one', async (t) => {
  // A resident board polls every couple of seconds. Re-reading a blocked job's
  // whole event log each time is the one expensive thing it does — and caching it
  // by job id alone is how the previous question ends up under the new one.
  let reads = 0;
  let updatedAt = '2026-01-01T00:00:00Z';
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { jobs: [{ id: 'job-blk', state: 'blocked', updatedAt }] }),
    'GET /jobs/job-blk/events': (_req: MockRequest, res: ServerResponse) => {
      reads += 1;
      sendNdjson(res, [
        { job: 'job-blk', seq: 0, type: 'decision', id: `d${reads}`, question: `question ${reads}`, options: [{ id: 'a' }] },
        { job: 'job-blk', seq: 1, type: 'state', state: 'blocked' },
      ]);
    },
  });
  t.after(daemon.close);
  const env = { FLEET_DAEMON_URL: daemon.url };
  const cache = new Map<string, PendingDecision>();

  const first = await fetchBoardJobs(env, cache);
  const second = await fetchBoardJobs(env, cache);
  assert.equal(reads, 1, 'the same open question is read once');
  assert.equal(second.jobs![0].decision?.question, 'question 1');

  // The job was answered and blocked again: the daemon stamped a new revision,
  // so the cache must not answer for it.
  updatedAt = '2026-01-01T00:05:00Z';
  const third = await fetchBoardJobs(env, cache);
  assert.equal(reads, 2, 'a changed job is re-read');
  assert.equal(third.jobs![0].decision?.question, 'question 2');
  assert.equal(cache.size, 1, 'the cache is pruned to what is on the board');
});

test('fetchBoardJobs carries the artifact count from the stored settle (#81)', async (t) => {
  // The daemon listing already stores the settle; the count must come from it
  // without any per-job event read — and an empty produced[] must map to no
  // count at all, not zero.
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        jobs: [
          {
            id: 'job-art', state: 'done',
            settle: { outcome: { produced: [{ id: 'a.md', type: 'file', title: 'a.md' }, { id: 'b.csv', type: 'file', title: 'b.csv' }], findings: 0, decisions: 0 } },
          },
          { id: 'job-empty', state: 'done', settle: { outcome: { produced: [], findings: 0, decisions: 0 } } },
          { id: 'job-nosettle', state: 'running' },
        ],
      }),
  });
  t.after(daemon.close);

  const result = await fetchBoardJobs({ FLEET_DAEMON_URL: daemon.url });
  assert.ok(result.ok, `fetchBoardJobs failed: ${result.error}`);
  const byId = new Map(result.jobs!.map((j) => [j.id, j]));
  assert.equal(byId.get('job-art')?.artifacts, 2);
  assert.equal(byId.get('job-empty')?.artifacts, undefined, 'empty produced[] maps to no count');
  assert.equal(byId.get('job-nosettle')?.artifacts, undefined);
});

test('fetchBoardJobs reports an unreachable daemon rather than throwing', async () => {
  const result = await fetchBoardJobs({ FLEET_DAEMON_URL: 'http://127.0.0.1:9' });
  assert.equal(result.ok, false);
  assert.ok((result.error ?? '').length > 0, 'the error says something');
});

test('answerJob posts the option and text the operator gave', async (t) => {
  const daemon = await startMockDaemon({
    'POST /jobs/job-blk/answer': (req: MockRequest, res: ServerResponse) => {
      const body = JSON.parse(req.body);
      if (body.option === 'fast') sendJson(res, 200, { ok: true });
      else sendJson(res, 422, { error: 'unknown option' });
    },
  });
  t.after(daemon.close);
  const env = { FLEET_DAEMON_URL: daemon.url };

  const ok = await answerJob('job-blk', { option: 'fast', text: 'let us go' }, env);
  assert.ok(ok.ok, `expected ok, got error: ${ok.error}`);
  assert.deepEqual(JSON.parse(daemon.requests[0].body), { option: 'fast', text: 'let us go' });

  const bad = await answerJob('job-blk', { option: 'wrong' }, env);
  assert.ok(!bad.ok);
  assert.match(bad.error ?? '', /unknown option/, 'the daemon error reaches the operator');
});

test('cancelJob posts to /cancel', async (t) => {
  const daemon = await startMockDaemon({
    'POST /jobs/job-x/cancel': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { ok: true }),
  });
  t.after(daemon.close);
  assert.ok((await cancelJob('job-x', { FLEET_DAEMON_URL: daemon.url })).ok);
  assert.equal(daemon.requests[0].url, '/jobs/job-x/cancel');
});

test('a settled job never shows a now-line, whatever activity it reported last', () => {
  // "now:" under a done job would be describing the past as the present.
  const settled: BoardJob = {
    id: 'job-done', state: 'done',
    lastActivity: { text: 'writing tests', at: new Date(0).toISOString() },
  };
  const rows = renderRosterRows([settled], -1, 100, { noColor: true, now: 5_000 });
  assert.equal(rows[0].lines.length, 1);
  assert.doesNotMatch(rows[0].lines.join('\n'), /now:/);
});

test('renderContextStrip: the counts survive a long repo, branch and endpoint', () => {
  // How many jobs want a human is the smallest and most useful thing on this
  // line. A long left side used to push it off the end, at exactly the width
  // where an operator most needs it.
  const strip = renderContextStrip(2, 3, 4, 80, {
    noColor: true,
    endpoint: 'http://127.0.0.1:19000',
    context: {
      repo: 'a-long-organisation/a-long-repository-name',
      branch: 'fleet/1234-job-abcdefgh-01234567',
      provider: 'ecs',
      tunnel: 'tunnel:ours:19000',
    },
  });
  const top = strip.split('\n')[0];
  assert.match(top, /blk:2 run:3 done:4/, 'the counts are still there');
  assert.ok(top.length <= 80, `the line still fits: ${top.length}`);
  assert.match(top, /FLEET/, 'and the identity survives at the other end');
});
