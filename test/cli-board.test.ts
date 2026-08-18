// fleet board: frame renderer unit tests + mock-daemon integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import {
  renderFrame,
  renderDetailFrame,
  renderBanner,
  renderContextStrip,
  renderEventLines,
  answerJob,
  cancelJob,
  fetchBoardJobs,
  RESTORE_SEQ,
  ENTER_ALT,
  FLEET_BANNER,
  ROSTER_FOOTER_KEYS,
  DETAIL_FOOTER_KEYS,
  rosterKeyAction,
  detailKeyAction,
  type BoardJob,
  type BoardEvent,
} from '../src/cli/board.ts';
import { runCli, startMockDaemon, sendJson, sendNdjson, type MockRequest } from './cli-helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'src', 'cli', 'main.ts');

// ── renderFrame unit tests ────────────────────────────────────────────────────

test('elapsed: settled jobs freeze at total runtime; live jobs keep counting', () => {
  const done: BoardJob = {
    id: 'job-done', state: 'done', workOrder: { mode: 'implement', target: '3' },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:12:00Z',
  };
  const run: BoardJob = {
    id: 'job-run', state: 'running', workOrder: { mode: 'implement', target: '4' },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:12:00Z',
  };
  const at = (min: number) => Date.parse('2026-01-01T00:00:00Z') + min * 60_000;
  const frame = (j: BoardJob, now: number) => renderFrame([j], -1, 100, { noColor: true, now });
  // Done: 12m at settle, still 12m a day later.
  assert.match(frame(done, at(20)), /job-done.*12m/);
  assert.match(frame(done, at(60 * 24)), /job-done.*12m/);
  // Running: counts from dispatch, not from last event.
  assert.match(frame(run, at(20)), /job-run.*20m/);
  assert.match(frame(run, at(45)), /job-run.*45m/);
});

test('renderFrame: blocked jobs sort before running and terminal jobs', () => {
  const jobs: BoardJob[] = [
    { id: 'job-run', state: 'running', workOrder: { mode: 'implement', target: 'app' }, updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'job-blk', state: 'blocked', workOrder: { mode: 'assess', target: 'docs' }, updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'job-don', state: 'done', workOrder: { mode: 'implement', target: 'other' }, updatedAt: '2026-01-01T00:00:00Z' },
  ];
  const frame = renderFrame(jobs, -1, 80, { noColor: true, now: 0 });
  const lines = frame.split('\n');
  const blkIdx = lines.findIndex((l) => l.includes('job-blk'));
  const runIdx = lines.findIndex((l) => l.includes('job-run'));
  const donIdx = lines.findIndex((l) => l.includes('job-don'));
  assert.ok(blkIdx !== -1, 'blocked job appears in frame');
  assert.ok(runIdx !== -1, 'running job appears in frame');
  assert.ok(donIdx !== -1, 'done job appears in frame');
  assert.ok(blkIdx < runIdx, 'blocked comes before running');
  assert.ok(runIdx < donIdx, 'running comes before done');
});

test('renderFrame: decision options rendered verbatim; recommended marked; non-recommended not marked', () => {
  const jobs: BoardJob[] = [
    {
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
    },
  ];
  const frame = renderFrame(jobs, -1, 120, { noColor: true, now: 0 });
  assert.match(frame, /Rename the endpoint\?/, 'question rendered verbatim');
  assert.match(frame, /Keep \/api\/v1/, 'first option label rendered');
  assert.match(frame, /Rename to \/api\/v2/, 'second option label rendered');
  // Recommended marker (★) appears near the keep option but not the rename option.
  const lines = frame.split('\n');
  const keepLine = lines.find((l) => l.includes('keep') && l.includes('Keep'));
  const renameLine = lines.find((l) => l.includes('rename') && l.includes('Rename to'));
  assert.ok(keepLine, 'keep option line found');
  assert.ok(renameLine, 'rename option line found');
  assert.match(keepLine!, /★/, 'recommended option carries ★');
  assert.doesNotMatch(renameLine!, /★/, 'non-recommended option has no ★');
});

test('renderFrame: lines are clipped to the specified width (noColor)', () => {
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
        options: [
          { id: 'yes', label: 'Yes please do the thing that is very long label', recommended: true },
          { id: 'no', label: 'No, do not do it' },
        ],
      },
    },
  ];
  const width = 60;
  const frame = renderFrame(jobs, -1, width, { noColor: true, now: 0 });
  for (const line of frame.split('\n')) {
    assert.ok(
      line.length <= width,
      `line exceeds width ${width}: "${line}" (${line.length})`,
    );
  }
});

test('renderFrame: NO_COLOR mode produces no ANSI escape codes', () => {
  const jobs: BoardJob[] = [
    { id: 'job-blk', state: 'blocked', decision: { id: 'd1', question: 'Q?', options: [{ id: 'a', label: 'Option A', recommended: true }, { id: 'b', label: 'Option B' }] } },
    { id: 'job-run', state: 'running' },
    { id: 'job-don', state: 'done' },
  ];
  const frame = renderFrame(jobs, 0, 80, { noColor: true, now: 0 });
  assert.doesNotMatch(frame, /\x1b\[/, 'ANSI escape codes present with noColor=true');
  // Same data WITH color enabled should contain escape codes.
  const colored = renderFrame(jobs, 0, 80, { noColor: false, now: 0 });
  assert.match(colored, /\x1b\[/, 'color mode should contain ANSI codes');
});

test('renderFrame: NO_COLOR output is stable (snapshot)', () => {
  // Snapshot: this exact text is the contract. A change here is a visible rendering change.
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
  ];
  const frame = renderFrame(jobs, -1, 80, { noColor: true, now: 0 });
  const expected = [
    '┌ FLEET ────────────────────────────────────────────────────blk:1 run:1 done:0 ┐',
    '└──────────────────────────────────────────────────────────────────────────────┘',
    '     JOB                     STATE      MODE        TARGET             ELAPSED',
    '  ──────────────────────────────────────────────────────────────────────────────',
    '  !! job-blk                 blocked    assess      docs               ',
    '     Deploy now?',
    '     [go] Deploy now ★',
    '     [wait] Wait for review',
    '',
    '  ●  job-run                 running    implement   app                ',
    '',
    '  ↑↓ navigate  enter expand  a answer  q quit',
  ].join('\n');
  assert.equal(frame, expected);
});

test('renderFrame: title in workOrder shows as #<n> <title> in TARGET column (clipped to column)', () => {
  const jobs: BoardJob[] = [
    {
      id: 'job-run',
      state: 'running',
      workOrder: { mode: 'implement', target: '42', title: 'Fix login' },
    },
  ];
  // Use wide enough frame so "Fix login" fits in 17-char TARGET column (#42 Fix login = 13 chars).
  const frame = renderFrame(jobs, -1, 120, { noColor: true, now: 0 });
  assert.match(frame, /#42 Fix login/, 'title shown as #<n> <title> in TARGET column');
  // Without title: numeric target renders without # prefix.
  const noTitle: BoardJob[] = [
    { id: 'job-run', state: 'running', workOrder: { mode: 'implement', target: '42' } },
  ];
  const noTitleFrame = renderFrame(noTitle, -1, 120, { noColor: true, now: 0 });
  assert.doesNotMatch(noTitleFrame, /#42/, 'bare numeric target has no # prefix without title');
});

test('renderFrame: now-line from lastActivity appears under all running/queued jobs', () => {
  // now=10000ms; at = new Date(10000 - 3000).toISOString() ≈ 3s ago
  const AT = new Date(10000 - 3000).toISOString();
  const jobs: BoardJob[] = [
    {
      id: 'job-run1',
      state: 'running',
      workOrder: { mode: 'implement', target: 'app' },
      lastActivity: { text: 'reading the codebase', at: AT },
    },
    {
      id: 'job-run2',
      state: 'running',
      workOrder: { mode: 'assess', target: 'docs' },
      lastActivity: { text: 'running tests', at: AT },
    },
    {
      id: 'job-no-activity',
      state: 'running',
      workOrder: { mode: 'review', target: 'pr' },
      // no lastActivity
    },
  ];
  const frame = renderFrame(jobs, -1, 120, { noColor: true, now: 10000 });
  assert.match(frame, /now: reading the codebase/, 'now-line for job-run1');
  assert.match(frame, /now: running tests/, 'now-line for job-run2');
  assert.match(frame, /\(3s\)/, 'age shown in now-line');
  // Job with no lastActivity has no now-line.
  const lines = frame.split('\n');
  const noActLines = lines.filter((l) => l.includes('job-no-activity'));
  // The job-no-activity row is present but has no "now:" below it.
  assert.ok(noActLines.length > 0, 'no-activity job rendered');
  assert.doesNotMatch(noActLines.join('\n'), /now:/, 'no now-line without lastActivity');
});

test('renderFrame: now-line snapshot (noColor)', () => {
  const AT = new Date(0).toISOString(); // epoch — 5s before now=5000
  const jobs: BoardJob[] = [
    {
      id: 'job-run',
      state: 'running',
      workOrder: { mode: 'implement', target: 'app' },
      lastActivity: { text: 'writing tests', at: AT },
    },
  ];
  const frame = renderFrame(jobs, -1, 80, { noColor: true, now: 5000 });
  const lines = frame.split('\n');
  // Find the now-line (should be immediately after the job row).
  const jobRowIdx = lines.findIndex((l) => l.includes('job-run'));
  assert.ok(jobRowIdx !== -1, 'job row found');
  const nowLine = lines[jobRowIdx + 1];
  assert.match(nowLine ?? '', /now: writing tests \(5s\)/, 'now-line shows text and age');
});

test('renderDetailFrame: title shown in full in detail header', () => {
  const job: BoardJob = {
    id: 'job-x',
    state: 'running',
    workOrder: { mode: 'implement', target: '99', title: 'Migrate to PostgreSQL' },
  };
  const frame = renderDetailFrame(job, [], 0, true, 120, 24, { noColor: true, now: 0 });
  const lines = frame.split('\n');
  // Context strip middle line has the job line with full title.
  const jobLine = lines[1];
  assert.match(jobLine, /#99: Migrate to PostgreSQL/, 'full title in detail header');
});

test('renderFrame: selection indicator appears on the correct sorted row', () => {
  // sorted order: blocked (index 0), running (index 1)
  const jobs: BoardJob[] = [
    { id: 'job-run', state: 'running' },
    { id: 'job-blk', state: 'blocked' },
  ];
  // selection=0 → blocked job (first in sorted order)
  const frameSelBlk = renderFrame(jobs, 0, 80, { noColor: true, now: 0 });
  const linesSelBlk = frameSelBlk.split('\n');
  const blkLine = linesSelBlk.find((l) => l.includes('job-blk'));
  const runLine = linesSelBlk.find((l) => l.includes('job-run'));
  assert.ok(blkLine?.includes('▶'), 'selected blocked job has selection marker');
  assert.ok(!runLine?.includes('▶'), 'unselected running job has no selection marker');

  // selection=1 → running job
  const frameSelRun = renderFrame(jobs, 1, 80, { noColor: true, now: 0 });
  const runLine2 = frameSelRun.split('\n').find((l) => l.includes('job-run'));
  assert.ok(runLine2?.includes('▶'), 'selected running job has selection marker');
});

test('ENTER_ALT and RESTORE_SEQ export the correct ANSI sequences', () => {
  assert.equal(ENTER_ALT, '\x1b[?1049h\x1b[?25l', 'ENTER_ALT enters alternate screen and hides cursor');
  assert.equal(RESTORE_SEQ, '\x1b[?25h\x1b[?1049l', 'RESTORE_SEQ shows cursor and exits alternate screen');
});

// ── Visual identity ───────────────────────────────────────────────────────────

test('FLEET_BANNER is exactly 4 lines and under 30 chars wide', () => {
  const lines = FLEET_BANNER.split('\n');
  assert.equal(lines.length, 4, 'banner has 4 lines');
  for (const line of lines) {
    assert.ok(line.length <= 30, `banner line too wide (${line.length}): "${line}"`);
  }
});

test('renderBanner: noColor produces no ANSI codes', () => {
  const out = renderBanner(80, true);
  assert.doesNotMatch(out, /\x1b\[/, 'no ANSI codes in noColor mode');
  assert.equal(out.split('\n').length, 4, 'still 4 lines');
});

test('renderBanner: clips long lines to width', () => {
  const out = renderBanner(10, true);
  for (const line of out.split('\n')) {
    assert.ok(line.length <= 10, `line exceeds width 10: "${line}"`);
  }
});

test('renderContextStrip: two-line output in roster mode, three-line in detail mode', () => {
  const roster = renderContextStrip(1, 2, 3, 80, { noColor: true });
  assert.equal(roster.split('\n').length, 2, 'roster strip is 2 lines');

  const detail = renderContextStrip(1, 2, 3, 80, { noColor: true }, 'job-x  running  implement  app');
  assert.equal(detail.split('\n').length, 3, 'detail strip is 3 lines with job line');
});

test('renderContextStrip: context info appears in the strip', () => {
  const out = renderContextStrip(0, 1, 0, 80, {
    noColor: true,
    endpoint: 'http://localhost:7744',
    context: { repo: 'acme/app', branch: 'main', provider: 'docker' },
  });
  assert.match(out, /acme\/app\/main/, 'repo/branch shown');
  assert.match(out, /http:\/\/localhost:7744/, 'endpoint shown');
  assert.match(out, /docker/, 'provider shown');
  assert.match(out, /run:1/, 'running count shown');
});

// ── Footer key parity (the v1 lesson, mechanized) ────────────────────────────

test('every ROSTER_FOOTER_KEYS entry has a rosterKeyAction handler (not unknown)', () => {
  for (const { label, rawKeys } of ROSTER_FOOTER_KEYS) {
    for (const key of rawKeys) {
      const action = rosterKeyAction(key);
      assert.notEqual(action, 'unknown',
        `key ${JSON.stringify(key)} (${label}) has no handler in rosterKeyAction`);
    }
  }
});

test('every DETAIL_FOOTER_KEYS entry has a detailKeyAction handler (not unknown)', () => {
  for (const { label, rawKeys } of DETAIL_FOOTER_KEYS) {
    for (const key of rawKeys) {
      const action = detailKeyAction(key);
      assert.notEqual(action, 'unknown',
        `key ${JSON.stringify(key)} (${label}) has no handler in detailKeyAction`);
    }
  }
});

test('roster footer text advertises exactly ROSTER_FOOTER_KEYS labels', () => {
  const frame = renderFrame([], -1, 80, { noColor: true, now: 0 });
  const footerLine = frame.split('\n').at(-1) ?? '';
  for (const { label } of ROSTER_FOOTER_KEYS) {
    assert.ok(footerLine.includes(label), `roster footer missing label: "${label}"`);
  }
});

test('detail footer text advertises exactly DETAIL_FOOTER_KEYS labels', () => {
  const job: BoardJob = { id: 'job-x', state: 'running', workOrder: { mode: 'implement', target: 'app' } };
  const frame = renderDetailFrame(job, [], 0, true, 80, 24, { noColor: true, now: 0 });
  const footerLine = frame.split('\n').at(-1) ?? '';
  for (const { label } of DETAIL_FOOTER_KEYS) {
    assert.ok(footerLine.includes(label), `detail footer missing label: "${label}"`);
  }
});

test('renderContextStrip: jobLine row visual width matches terminal width in color mode', () => {
  // This catches the ANSI-blind padEnd bug: String.padEnd inflates length with ANSI bytes,
  // leaving the closing │ at the wrong visual column.
  const job: BoardJob = { id: 'job-blk', state: 'blocked', workOrder: { mode: 'assess', target: '#42' } };
  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  const visualLen = (s: string) => s.replace(ANSI_RE, '').length;
  for (const noColor of [true, false]) {
    const jobLineContent = `${job.id}  ${job.state}  ${job.workOrder?.mode}  ${job.workOrder?.target}`;
    const strip = renderContextStrip(1, 0, 0, 80, { noColor }, jobLineContent);
    const lines = strip.split('\n');
    const jobRow = lines[1]; // middle row
    assert.equal(visualLen(jobRow), 80,
      `color=${!noColor} jobLine row visual width should be 80, got ${visualLen(jobRow)}`);
  }
});

// ── renderDetailFrame ─────────────────────────────────────────────────────────

test('renderDetailFrame: snapshot (noColor, 80 col, 24 rows)', () => {
  const job: BoardJob = {
    id: 'job-blk',
    state: 'blocked',
    workOrder: { mode: 'assess', target: '#42' },
    decision: { id: 'd1', question: 'Which path?', options: [{ id: 'a', label: 'Alpha', recommended: true }, { id: 'b', label: 'Beta' }] },
  };
  const events: BoardEvent[] = [
    { seq: 0, type: 'state', state: 'running' },
    { seq: 1, type: 'think', text: 'analysing the codebase' },
    { seq: 2, type: 'decision', id: 'd1', question: 'Which path?', options: [{ id: 'a', label: 'Alpha', recommended: true }, { id: 'b', label: 'Beta' }] },
  ];
  const frame = renderDetailFrame(job, events, 0, false, 80, 24, { noColor: true, now: 0 });
  const lines = frame.split('\n');
  // Header: 3 lines (context strip with job line).
  assert.match(lines[0], /FLEET/, 'context strip line 0 has FLEET');
  assert.match(lines[1], /job-blk/, 'context strip line 1 has job id');
  assert.match(lines[2], /^└/, 'context strip line 2 is bottom border');
  // Event content in body.
  const body = lines.slice(3, -1).join('\n');
  assert.match(body, /running/, 'state event rendered');
  assert.match(body, /analysing the codebase/, 'think event rendered');
  assert.match(body, /Which path\?/, 'decision event rendered');
  // Footer.
  assert.match(lines.at(-1) ?? '', /esc back/, 'footer has esc back');
  assert.match(lines.at(-1) ?? '', /a answer/, 'footer has a answer');
});

test('renderDetailFrame: scroll clamping — scroll > max clamps to last available window', () => {
  const job: BoardJob = { id: 'job-x', state: 'running' };
  // Generate 30 events so there are more lines than the 17-line body (24 - 3 header - 1 footer = 20).
  const events: BoardEvent[] = Array.from({ length: 30 }, (_, i) => ({
    seq: i, type: 'log', text: `line ${i}`,
  }));
  const frame0 = renderDetailFrame(job, events, 0, false, 80, 24, { noColor: true, now: 0 });
  const frameMax = renderDetailFrame(job, events, 9999, false, 80, 24, { noColor: true, now: 0 });
  // Scroll=0 shows first events; scroll=9999 (clamped) shows last events.
  assert.match(frame0, /line 0/, 'scroll=0 shows first line');
  assert.doesNotMatch(frame0, /line 29/, 'scroll=0 does not show last line');
  assert.match(frameMax, /line 29/, 'over-scroll shows last line');
  assert.doesNotMatch(frameMax, /line 0/, 'over-scroll does not show first line');
});

test('renderDetailFrame: followMode sticks to bottom regardless of scroll value', () => {
  const job: BoardJob = { id: 'job-x', state: 'running' };
  const events: BoardEvent[] = Array.from({ length: 30 }, (_, i) => ({
    seq: i, type: 'log', text: `line ${i}`,
  }));
  const frame = renderDetailFrame(job, events, 0, true, 80, 24, { noColor: true, now: 0 });
  assert.match(frame, /line 29/, 'followMode shows last line');
  assert.doesNotMatch(frame, /line 0/, 'followMode does not show first line');
});

test('renderDetailFrame: narrow width (80 col minimum) clips all lines', () => {
  const job: BoardJob = {
    id: 'very-long-job-identifier-exceeding-normal-length',
    state: 'blocked',
    workOrder: { mode: 'implement', target: 'an-extremely-long-target-string-that-would-overflow' },
  };
  const events: BoardEvent[] = [
    { seq: 0, type: 'log', text: 'a '.repeat(60) },
  ];
  const frame = renderDetailFrame(job, events, 0, false, 80, 24, { noColor: true, now: 0 });
  for (const line of frame.split('\n')) {
    assert.ok(line.length <= 80, `line exceeds 80 chars: "${line.slice(0, 40)}…" (${line.length})`);
  }
});

// ── Mock daemon integration tests ─────────────────────────────────────────────

test('fleet board --once: renders jobs blocked-first with decision shown', async (t) => {
  const DECISION_EVENTS = [
    { job: 'job-blk', seq: 0, type: 'state', state: 'running' },
    {
      job: 'job-blk',
      seq: 1,
      type: 'decision',
      id: 'd1',
      question: 'Which strategy?',
      options: [
        { id: 'fast', label: 'Fast path', recommended: true },
        { id: 'safe', label: 'Safe path' },
      ],
    },
    { job: 'job-blk', seq: 2, type: 'state', state: 'blocked' },
  ];
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        jobs: [
          { id: 'job-run', state: 'running', workOrder: { mode: 'implement', target: 'app' } },
          { id: 'job-blk', state: 'blocked', workOrder: { mode: 'assess', target: 'docs' } },
        ],
      }),
    'GET /jobs/job-blk/events': (_req: MockRequest, res: ServerResponse) =>
      sendNdjson(res, DECISION_EVENTS),
  });
  t.after(daemon.close);

  const res = await runCli(['board', '--once'], { env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);

  const lines = res.stdout.split('\n');
  const blkIdx = lines.findIndex((l) => l.includes('job-blk'));
  const runIdx = lines.findIndex((l) => l.includes('job-run'));
  assert.ok(blkIdx !== -1 && runIdx !== -1, 'both jobs rendered');
  assert.ok(blkIdx < runIdx, 'blocked job rendered before running job');

  assert.match(res.stdout, /Which strategy\?/, 'decision question shown');
  assert.match(res.stdout, /Fast path/, 'first option shown');
  assert.match(res.stdout, /Safe path/, 'second option shown');
  assert.match(res.stdout, /★/, 'recommended marker shown');
});

test('fleet board --once: reflects state transition between polls', async (t) => {
  // The daemon changes job state from running → done between the first and second call.
  // Two separate --once invocations simulate what the polling loop sees on consecutive ticks.
  let calls = 0;
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => {
      calls += 1;
      const state = calls === 1 ? 'running' : 'done';
      sendJson(res, 200, {
        jobs: [{ id: 'job-1', state, workOrder: { mode: 'implement', target: 'app' } }],
      });
    },
  });
  t.after(daemon.close);

  const first = await runCli(['board', '--once'], { env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(first.code, 0, `first call stderr: ${first.stderr}`);
  assert.match(first.stdout, /running/, 'first poll shows running state');

  const second = await runCli(['board', '--once'], { env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(second.code, 0, `second call stderr: ${second.stderr}`);
  assert.match(second.stdout, /done/, 'second poll reflects the transition to done');
  assert.equal(calls, 2, 'daemon called once per --once invocation');
});

test('fleet board --once: unreachable daemon fails with exit code 1 and useful message', async () => {
  const res = await runCli(['board', '--once'], {
    env: { FLEET_DAEMON_URL: 'http://127.0.0.1:9' },
  });
  assert.equal(res.code, 1, 'exit code 1 on daemon error');
  assert.match(res.stderr, /board: cannot reach daemon/, 'readable error message');
});

test('answerJob: posts the correct option and text to the daemon answer endpoint', async (t) => {
  const daemon = await startMockDaemon({
    'POST /jobs/job-blk/answer': (req: MockRequest, res: ServerResponse) => {
      const body = JSON.parse(req.body);
      if (body.option === 'fast') {
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 422, { error: 'unknown option' });
      }
    },
  });
  t.after(daemon.close);

  const env = { FLEET_DAEMON_URL: daemon.url };

  const ok = await answerJob('job-blk', { option: 'fast', text: 'let us go' }, env);
  assert.ok(ok.ok, `expected ok, got error: ${ok.error}`);
  assert.deepEqual(
    JSON.parse(daemon.requests[0].body),
    { option: 'fast', text: 'let us go' },
    'daemon received correct payload',
  );

  const bad = await answerJob('job-blk', { option: 'wrong' }, env);
  assert.ok(!bad.ok, 'bad option returns not-ok');
  assert.match(bad.error ?? '', /unknown option/, 'error message from daemon propagated');
});

test('cancelJob: posts to /cancel and returns ok', async (t) => {
  const daemon = await startMockDaemon({
    'POST /jobs/job-x/cancel': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { ok: true }),
  });
  t.after(daemon.close);
  const result = await cancelJob('job-x', { FLEET_DAEMON_URL: daemon.url });
  assert.ok(result.ok, `expected ok, got: ${result.error}`);
  assert.equal(daemon.requests.length, 1, 'one request sent');
  assert.equal(daemon.requests[0].url, '/jobs/job-x/cancel');
});

test('fetchBoardJobs: enriches blocked jobs with their decision', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        jobs: [
          { id: 'job-blk', state: 'blocked', workOrder: { mode: 'assess', target: 'docs' } },
        ],
      }),
    'GET /jobs/job-blk/events': (_req: MockRequest, res: ServerResponse) =>
      sendNdjson(res, [
        { job: 'job-blk', seq: 0, type: 'state', state: 'running' },
        {
          job: 'job-blk',
          seq: 1,
          type: 'decision',
          id: 'd1',
          question: 'Merge now?',
          options: [
            { id: 'yes', label: 'Yes', recommended: true },
            { id: 'no', label: 'No' },
          ],
        },
        { job: 'job-blk', seq: 2, type: 'state', state: 'blocked' },
      ]),
  });
  t.after(daemon.close);

  const result = await fetchBoardJobs({ FLEET_DAEMON_URL: daemon.url });
  assert.ok(result.ok, `fetchBoardJobs failed: ${result.error}`);
  assert.equal(result.jobs!.length, 1);
  const job = result.jobs![0];
  assert.ok(job.decision, 'decision enriched');
  assert.equal(job.decision!.question, 'Merge now?');
  assert.equal(job.decision!.options.length, 2);
  assert.equal(job.decision!.options[0].id, 'yes');
  assert.ok(job.decision!.options[0].recommended);
});

test('fleet board --once: empty job list renders with helpful hint', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { jobs: [] }),
  });
  t.after(daemon.close);

  const res = await runCli(['board', '--once'], { env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /no jobs/, 'empty state message shown');
  assert.match(res.stdout, /fleet delegate/, 'delegation hint shown');
});

test('fleet board --force-interactive: SIGINT writes RESTORE_SEQ and exits cleanly', async (t) => {
  const daemon = await startMockDaemon({
    // Respond immediately so the board can start and render once before SIGINT.
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { jobs: [] }),
  });
  t.after(daemon.close);

  const child = spawn(process.execPath, [CLI, 'board', '--force-interactive'], {
    env: { ...process.env, FLEET_DAEMON_URL: daemon.url, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let sigintSent = false;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('binary');
    // Send SIGINT once we see the alternate screen escape (board has started).
    if (!sigintSent && stdout.includes('\x1b[?1049h')) {
      sigintSent = true;
      child.kill('SIGINT');
    }
  });

  const [code] = (await once(child, 'close')) as [number];
  assert.equal(code, 0, `expected exit code 0, got ${code}\nstdout: ${JSON.stringify(stdout)}`);
  assert.ok(stdout.includes(RESTORE_SEQ), `RESTORE_SEQ not written to stdout on SIGINT\nstdout: ${JSON.stringify(stdout)}`);
});
