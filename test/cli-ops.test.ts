import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { runCli, makeTempDir, startMockDaemon, sendJson, sendNdjson, type MockRequest } from './cli-helpers.ts';
import { formatEvent, logsNoColor } from '../src/cli/format.ts';

const RUNNING_JOB = {
  id: 'job-1',
  state: 'running',
  workOrder: { mode: 'implement', target: 'APP-123', finish: 'merge-ready' },
  updatedAt: '2026-01-01T00:00:00Z',
};

// ── formatEvent / logsNoColor unit tests (no daemon needed) ──────────────────

test('logsNoColor: true when NO_COLOR set, TERM=dumb, or non-TTY; false otherwise', () => {
  assert.equal(logsNoColor({}, true), false, 'TTY with no env flags → color on');
  assert.equal(logsNoColor({ NO_COLOR: '' }, true), true, 'NO_COLOR present → no color');
  assert.equal(logsNoColor({ TERM: 'dumb' }, true), true, 'TERM=dumb → no color');
  assert.equal(logsNoColor({}, false), true, 'non-TTY → no color');
});

test('formatEvent: color mode produces ANSI codes; noColor suppresses them', () => {
  const ANSI_RE = /\x1b\[[0-9;]*m/;
  const stateEvent = { seq: 0, type: 'state', state: 'running' };
  const thinkEvent = { seq: 1, type: 'think', text: 'working' };
  const settleReady = { seq: 2, type: 'settle', rung: 'done', report: { status: 'READY' } };
  const settlePartial = { seq: 3, type: 'settle', rung: 'done', report: { status: 'PARTIAL' } };
  const decisionEvent = {
    seq: 4, type: 'decision', id: 'd1', question: 'Proceed?',
    options: [{ id: 'yes', recommended: true }],
  };

  // Color on: ANSI codes present in colored event types.
  assert.match(formatEvent(stateEvent, false), ANSI_RE, 'state: ANSI bold in color mode');
  assert.match(formatEvent(thinkEvent, false), ANSI_RE, 'think: ANSI dim in color mode');
  assert.match(formatEvent(settleReady, false), ANSI_RE, 'settle READY: ANSI green in color mode');
  assert.match(formatEvent(settlePartial, false), ANSI_RE, 'settle PARTIAL: ANSI red in color mode');
  assert.match(formatEvent(decisionEvent, false), ANSI_RE, 'decision: ANSI yellow in color mode');

  // No color: no ANSI codes.
  assert.doesNotMatch(formatEvent(stateEvent, true), ANSI_RE, 'state: no ANSI in noColor mode');
  assert.doesNotMatch(formatEvent(thinkEvent, true), ANSI_RE, 'think: no ANSI in noColor mode');
  assert.doesNotMatch(formatEvent(settleReady, true), ANSI_RE, 'settle: no ANSI in noColor mode');

  // Content still present regardless of color mode.
  assert.match(formatEvent(stateEvent, true), /\[0\] state → running/);
  assert.match(formatEvent(settleReady, true), /rung=done status=READY/);
  assert.match(formatEvent(settlePartial, true), /status=PARTIAL/);
});

test('formatEvent: settle green for READY, red for non-READY (ANSI code check)', () => {
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const ready = { seq: 0, type: 'settle', rung: 'r', report: { status: 'READY' } };
  const partial = { seq: 1, type: 'settle', rung: 'r', report: { status: 'PARTIAL' } };
  assert.ok(formatEvent(ready, false).includes(GREEN), 'READY → green');
  assert.ok(formatEvent(partial, false).includes(RED), 'PARTIAL → red');
});

test('formatEvent: log compacts tool_use and tool_result', () => {
  const toolUse = { seq: 0, type: 'log', text: 'tool_use Bash: {"command":"npm test"}' };
  const toolResult = { seq: 1, type: 'log', text: 'tool_result toolu_01: lots of output here' };
  const plainLog = { seq: 2, type: 'log', text: 'ran the tests successfully' };

  assert.match(formatEvent(toolUse, true), /tool_use Bash command=npm test/);
  assert.match(formatEvent(toolResult, true), /tool_result toolu_01 \(\d+ bytes\)/);
  assert.match(formatEvent(plainLog, true), /ran the tests successfully/);
});

test('status lists jobs and shows a single job', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => {
      sendJson(res, 200, {
        jobs: [
          { id: 'job-2', state: 'blocked', marker: 'parked', workOrder: { mode: 'assess', target: 'APP-456' } },
          RUNNING_JOB,
        ],
      });
    },
    'GET /jobs/job-1': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { job: RUNNING_JOB }),
  });
  t.after(daemon.close);
  const env = { FLEET_DAEMON_URL: daemon.url };

  const list = await runCli(['status'], { env });
  assert.equal(list.code, 0, list.stderr);
  const lines = list.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /job-2\s+blocked\(parked\)\s+mode=assess\s+target=APP-456/, 'blocked-first order preserved');
  assert.match(lines[1], /job-1\s+running\s+mode=implement\s+target=APP-123/);

  const one = await runCli(['status', 'job-1'], { env });
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /job-1\s+running/);

  const gone = await runCli(['status', 'job-9'], { env });
  assert.equal(gone.code, 1, 'unknown job fails');
});

test('logs dumps events and forwards --after', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs/job-1/events': (req: MockRequest, res: ServerResponse) => {
      const after = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? '-1');
      const events = [
        { job: 'job-1', seq: 0, type: 'state', state: 'running' },
        { job: 'job-1', seq: 1, type: 'think', text: 'reading the ticket' },
        { job: 'job-1', seq: 2, type: 'log', text: 'ran focused tests' },
      ];
      sendNdjson(res, events.filter((e) => e.seq > after));
    },
  });
  t.after(daemon.close);
  const env = { FLEET_DAEMON_URL: daemon.url };

  const all = await runCli(['logs', 'job-1'], { env });
  assert.equal(all.code, 0, all.stderr);
  // State now renders with → arrow; think/log unchanged.
  assert.match(all.stdout, /\[0\] state → running/);
  assert.match(all.stdout, /\[1\] think reading the ticket/);
  assert.match(all.stdout, /\[2\] log ran focused tests/);

  const tail = await runCli(['logs', 'job-1', '--after', '1'], { env });
  assert.equal(tail.code, 0, tail.stderr);
  assert.doesNotMatch(tail.stdout, /\[0\]|\[1\]/, 'earlier events filtered by the daemon');
  assert.match(tail.stdout, /\[2\] log/);
});

test('logs --full emits raw JSON per line, parseable', async (t) => {
  const events = [
    { job: 'job-1', seq: 0, type: 'state', state: 'running' },
    { job: 'job-1', seq: 1, type: 'think', text: 'working on it' },
    { job: 'job-1', seq: 2, type: 'settle', rung: 'done', report: { status: 'READY' } },
  ];
  const daemon = await startMockDaemon({
    'GET /jobs/job-1/events': (_req: MockRequest, res: ServerResponse) => sendNdjson(res, events),
  });
  t.after(daemon.close);

  const res = await runCli(['logs', 'job-1', '--full'], { env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);
  const outputLines = res.stdout.trim().split('\n');
  assert.equal(outputLines.length, events.length, 'one line per event in --full mode');
  for (const [i, rawLine] of outputLines.entries()) {
    let parsed: unknown;
    try { parsed = JSON.parse(rawLine); } catch { assert.fail(`line ${i} is not valid JSON: ${rawLine}`); }
    assert.deepStrictEqual(parsed, events[i], `line ${i} must be the original event verbatim`);
  }
});

test('logs renders decision yellow (NO_COLOR off) and think dim; tool_use/tool_result compact', async (t) => {
  const events = [
    {
      job: 'job-1', seq: 0, type: 'decision', id: 'd1',
      question: 'Which approach?',
      options: [{ id: 'a', label: 'Approach A', recommended: true }, { id: 'b', label: 'Approach B' }],
    },
    { job: 'job-1', seq: 1, type: 'log', text: 'tool_use Read: {"file_path":"/src/main.ts"}' },
    { job: 'job-1', seq: 2, type: 'log', text: 'tool_result toolu_01: console.log(hello)' },
    { job: 'job-1', seq: 3, type: 'think', text: 'Considering options.' },
    { job: 'job-1', seq: 4, type: 'settle', rung: 'merge-ready', report: { status: 'READY' } },
    { job: 'job-1', seq: 5, type: 'settle', rung: 'blocked', report: { status: 'PARTIAL' } },
  ];
  const daemon = await startMockDaemon({
    'GET /jobs/job-1/events': (_req: MockRequest, res: ServerResponse) => sendNdjson(res, events),
  });
  t.after(daemon.close);
  const env = { FLEET_DAEMON_URL: daemon.url };

  // NO_COLOR: plain text, no ANSI codes, but all content present.
  const noColor = await runCli(['logs', 'job-1'], { env: { ...env, NO_COLOR: '1' } });
  assert.equal(noColor.code, 0, noColor.stderr);
  assert.match(noColor.stdout, /\[0\] decision d1: Which approach\?/);
  assert.match(noColor.stdout, /- a \(recommended\)/);
  assert.doesNotMatch(noColor.stdout, /\x1b\[/, 'NO_COLOR must suppress all ANSI codes');
  // tool_use compact: show name + file_path, not raw JSON
  assert.match(noColor.stdout, /\[1\] log tool_use Read file_path=\/src\/main\.ts/);
  // tool_result compact: byte-count summary
  assert.match(noColor.stdout, /\[2\] log tool_result toolu_01 \(\d+ bytes\)/);
  // think present
  assert.match(noColor.stdout, /\[3\] think Considering options\./);
  // settle with status
  assert.match(noColor.stdout, /\[4\] settle rung=merge-ready status=READY/);
  assert.match(noColor.stdout, /\[5\] settle rung=blocked status=PARTIAL/);
});

test('attach follows long-poll cycles until the job reaches a terminal state', async (t) => {
  let calls = 0;
  const daemon = await startMockDaemon({
    'GET /jobs/job-1/events': (req: MockRequest, res: ServerResponse) => {
      calls += 1;
      const params = new URL(req.url, 'http://x').searchParams;
      assert.equal(params.get('follow'), '1', 'attach always long-polls');
      if (calls === 1) {
        sendNdjson(res, [
          { job: 'job-1', seq: 0, type: 'state', state: 'running' },
          { job: 'job-1', seq: 1, type: 'phase', text: 'implementing' },
        ]);
        return;
      }
      assert.equal(params.get('after'), '1', 'second poll resumes after the last seen seq');
      sendNdjson(res, [
        { job: 'job-1', seq: 2, type: 'settle', rung: 'implemented', outcome: {}, report: { status: 'READY' } },
        { job: 'job-1', seq: 3, type: 'state', state: 'done' },
      ]);
    },
  });
  t.after(daemon.close);

  const res = await runCli(['attach', 'job-1'], { env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(calls, 2);
  assert.match(res.stdout, /\[0\] state → running/);
  assert.match(res.stdout, /\[1\] phase implementing/);
  assert.match(res.stdout, /\[2\] settle rung=implemented status=READY/);
  assert.match(res.stdout, /\[3\] state → done/);
});

test('answer posts option and text; requires at least one', async (t) => {
  const daemon = await startMockDaemon({
    'POST /jobs/job-1/answer': (req: MockRequest, res: ServerResponse) => {
      const body = JSON.parse(req.body);
      if (body.option === 'wrong-id') {
        // Daemon contract: bad option → 422 {error: string} (never coerced to free text).
        sendJson(res, 422, { error: 'option does not match an open decision option' });
        return;
      }
      if (body.option === 'too-late') {
        // Daemon contract: job not blocked → 409 {error: string}.
        sendJson(res, 409, { error: 'job is not blocked' });
        return;
      }
      sendJson(res, 200, { job: { id: 'job-1', state: 'running' } });
    },
  });
  t.after(daemon.close);
  const env = { FLEET_DAEMON_URL: daemon.url };

  const ok = await runCli(['answer', 'job-1', '--option', 'ship-it', '--text', 'and update the changelog'], { env });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /answered job-1/);
  assert.deepEqual(JSON.parse(daemon.requests[0].body), { option: 'ship-it', text: 'and update the changelog' });

  const rejected = await runCli(['answer', 'job-1', '--option', 'wrong-id'], { env });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /answer failed: option does not match an open decision option/);

  const notBlocked = await runCli(['answer', 'job-1', '--option', 'too-late'], { env });
  assert.equal(notBlocked.code, 1);
  assert.match(notBlocked.stderr, /answer failed: job is not blocked/);
  const neither = await runCli(['answer', 'job-1'], { env });
  assert.equal(neither.code, 2, 'usage error without --option or --text');
  assert.match(neither.stderr, /--option/);
});

test('cancel posts to the cancel endpoint', async (t) => {
  const daemon = await startMockDaemon({
    'POST /jobs/job-1/cancel': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, {}),
  });
  t.after(daemon.close);

  const res = await runCli(['cancel', 'job-1'], { env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /cancelled job-1/);
  assert.equal(daemon.requests.length, 1);
  assert.equal(daemon.requests[0].method, 'POST');
});

test('status prints friendly empty-state with delegate hint when no jobs', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }),
  });
  t.after(daemon.close);
  const env = { FLEET_DAEMON_URL: daemon.url };

  const res = await runCli(['status'], { env });
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one line printed');
  assert.match(lines[0], /no jobs/);
  assert.match(lines[0], /fleet delegate <target>/);
});

test('client reaches the daemon over the FLEET_HOME unix socket', async (t) => {
  const home = makeTempDir('fleet-cli-home-');
  const daemon = await startMockDaemon(
    { 'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }) },
    { socketPath: path.join(home, 'daemon.sock') },
  );
  t.after(daemon.close);

  const res = await runCli(['status'], { env: { FLEET_HOME: home } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /no jobs — delegate one with: fleet delegate <target>/);
});

test('daemon-backed commands fail readably when the daemon is unreachable', async () => {
  const res = await runCli(['status'], { env: { FLEET_DAEMON_URL: 'http://127.0.0.1:9' } });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /cannot reach daemon at http:\/\/127\.0\.0\.1:9/);
});

test('unknown commands are usage errors', async () => {
  const unknown = await runCli(['conquer'], {});
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);

  const help = await runCli(['help'], {});
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: fleet/);
});
