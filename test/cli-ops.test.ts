import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { runCli, makeTempDir, startMockDaemon, sendJson, sendNdjson, EVENT_BATTERY, type MockRequest } from './cli-helpers.ts';
import { formatEvent, formatJobState, logsNoColor, isNarrativeEvent } from '../src/cli/format.ts';
import { TERSE_RESULT_MAX } from '../src/shared/tool-text.ts';
import { translateLine } from '../src/runner/translate.ts';

const RUNNING_JOB = {
  id: 'job-1',
  state: 'running',
  workOrder: { target: 'APP-123', finish: 'merge-ready' },
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

test('formatEvent: exact output for every event type, color and noColor (#128 characterization)', () => {
  // Byte-for-byte pins captured before the rendering paths were unified: the
  // plain-line convention (`fleet logs` / `fleet attach`) must not drift when
  // the shared rendering core changes. If a change here is deliberate, update
  // the pin and say why in the commit.
  const expectedColor = [
    '\x1b[1m[1] state → running\x1b[0m',
    '\x1b[1m[2] state → blocked reason=decision marker=parked\x1b[0m',
    '[3] phase setup',
    '\x1b[2m[4] think planning the change\x1b[0m',
    '[5] log tool_use Read file_path=/p/a.ts',
    '[6] log plain line',
    '[7] progress 42%',
    '\x1b[33m[8] decision d1: Which way?\n  - a (recommended): Left\n  - b: Right\n  - c\n  answer with: fleet answer <jobId> --option <id> [--text s]\x1b[0m',
    '[9] answer d1 → a "go left" by vince',
    '[10] answer d9 → (free text) "freeform"',
    '[11] answer undefined → (free text)',
    '\x1b[32m[12] settle rung=pr-open status=READY next: review it\x1b[0m',
    '\x1b[31m[13] settle rung=? status=PARTIAL\x1b[0m',
    '[14] pair {"minutes":3}',
  ];
  const expectedNoColor = [
    '[1] state → running',
    '[2] state → blocked reason=decision marker=parked',
    '[3] phase setup',
    '[4] think planning the change',
    '[5] log tool_use Read file_path=/p/a.ts',
    '[6] log plain line',
    '[7] progress 42%',
    '[8] decision d1: Which way?\n  - a (recommended): Left\n  - b: Right\n  - c\n  answer with: fleet answer <jobId> --option <id> [--text s]',
    '[9] answer d1 → a "go left" by vince',
    '[10] answer d9 → (free text) "freeform"',
    '[11] answer undefined → (free text)',
    '[12] settle rung=pr-open status=READY next: review it',
    '[13] settle rung=? status=PARTIAL',
    '[14] pair {"minutes":3}',
  ];
  assert.deepEqual(EVENT_BATTERY.map((e) => formatEvent(e, false)), expectedColor);
  assert.deepEqual(EVENT_BATTERY.map((e) => formatEvent(e, true)), expectedNoColor);
});

test('formatEvent: settle green for READY, red for non-READY (ANSI code check)', () => {
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const ready = { seq: 0, type: 'settle', rung: 'r', report: { status: 'READY' } };
  const partial = { seq: 1, type: 'settle', rung: 'r', report: { status: 'PARTIAL' } };
  assert.ok(formatEvent(ready, false).includes(GREEN), 'READY → green');
  assert.ok(formatEvent(partial, false).includes(RED), 'PARTIAL → red');
});

test('isNarrativeEvent: narrative mode includes spine; excludes tool lines and progress/pair/agent', () => {
  // Narrative includes: state, phase, think, decision, answer, settle, non-tool log.
  assert.ok(isNarrativeEvent({ seq: 0, type: 'state', state: 'running' }, false));
  assert.ok(isNarrativeEvent({ seq: 1, type: 'phase', text: 'reading' }, false));
  assert.ok(isNarrativeEvent({ seq: 2, type: 'think', text: 'thinking' }, false));
  assert.ok(isNarrativeEvent({ seq: 3, type: 'decision', id: 'd1', question: 'Q?', options: [] }, false));
  assert.ok(isNarrativeEvent({ seq: 4, type: 'answer', decision: 'd1' }, false));
  assert.ok(isNarrativeEvent({ seq: 5, type: 'settle' }, false));
  assert.ok(isNarrativeEvent({ seq: 6, type: 'log', text: 'runner note: pushed to branch' }, false));
  // Tool lines excluded from narrative.
  assert.ok(!isNarrativeEvent({ seq: 7, type: 'log', text: 'tool_use Bash: {}' }, false), 'tool_use excluded');
  assert.ok(!isNarrativeEvent({ seq: 8, type: 'log', text: 'tool_result id: data' }, false), 'tool_result excluded');
  // Tool lines included with tools=true.
  assert.ok(isNarrativeEvent({ seq: 7, type: 'log', text: 'tool_use Bash: {}' }, true), 'tool_use included with tools=true');
  assert.ok(isNarrativeEvent({ seq: 8, type: 'log', text: 'tool_result id: data' }, true), 'tool_result included with tools=true');
  // Operational events always excluded.
  assert.ok(!isNarrativeEvent({ seq: 9, type: 'progress', value: 0.5 }, false), 'progress excluded');
  assert.ok(!isNarrativeEvent({ seq: 10, type: 'pair', worker: 'w', critic: 'c' }, false), 'pair excluded');
  assert.ok(!isNarrativeEvent({ seq: 11, type: 'agent', name: 'a', state: 'work' }, false), 'agent excluded');
  // Even with tools=true, progress/pair/agent stay excluded.
  assert.ok(!isNarrativeEvent({ seq: 9, type: 'progress', value: 0.5 }, true), 'progress excluded even with tools=true');
});

test('formatEvent: log compacts tool_use and tool_result', () => {
  // Legacy shapes: events persisted by a pre-#50 runner, which the retained
  // log of an older job still carries.
  const toolUse = { seq: 0, type: 'log', text: 'tool_use Bash: {"command":"npm test"}' };
  const rawDump = { seq: 1, type: 'log', text: `tool_result toolu_01: ${'output line\n'.repeat(40)}` };
  const plainLog = { seq: 2, type: 'log', text: 'ran the tests successfully' };

  assert.match(formatEvent(toolUse, true), /tool_use Bash command=npm test/);
  assert.match(formatEvent(rawDump, true), /tool_result toolu_01 \(\d+ bytes\)/);
  assert.match(formatEvent(plainLog, true), /ran the tests successfully/);
});

test('formatEvent: a terse tool_result summary survives compaction verbatim', () => {
  // #50: the translator now emits the one-line summary itself. Trading it for
  // "(42 bytes)" would hide the line AND misreport the tool output's size.
  const terse = { seq: 3, type: 'log', text: 'tool_result toolu_07: # fail 1 (+12 lines)' };
  assert.match(formatEvent(terse, true), /tool_result toolu_07: # fail 1 \(\+12 lines\)/);
  assert.doesNotMatch(formatEvent(terse, true), /bytes/);
});

test('formatEvent: a LOUD tool_result summary survives too — it is the diagnosis', () => {
  // A failed call gets the translator's wide budget (MAX_RESULT_ERROR = 800),
  // so the compaction threshold must sit above it. A threshold tuned to the
  // non-error budget silently deletes exactly the line the operator needs.
  const body = `AssertionError: ${'stack frame / '.repeat(50)}exit 1`;
  assert.ok(body.length > 240 && body.length <= TERSE_RESULT_MAX, `fixture body is ${body.length} chars`);
  const loud = { seq: 4, type: 'log', text: `tool_result toolu_08 ERROR: ${body}` };
  assert.match(formatEvent(loud, true), /AssertionError: stack frame/);
  assert.doesNotMatch(formatEvent(loud, true), /bytes/);
});

test('translator output survives the CLI compactor, across the module boundary', () => {
  // #50's original bug was drift between two modules that each looked correct
  // alone: the translator's error budget and the compactor's dump threshold.
  // Two hand-written fixtures on opposite sides cannot catch that — only
  // feeding real translator output through the real formatter can.
  // Frames long enough that the joined head clears any plausible dump
  // threshold — that head is exactly what a mis-tuned threshold would delete.
  const frame = '  at deeplyNestedHelper (file:///workspace/src/some/long/path/to/module.ts:1234:56)';
  const [rendered] = translateLine(JSON.stringify({
    type: 'user',
    message: { content: [{
      type: 'tool_result', tool_use_id: 'toolu_42', is_error: true,
      content: `AssertionError: expected 0 got 1\n${`${frame}\n`.repeat(30)}# fail 1`,
    }] },
  }));
  assert.ok(rendered.type === 'log');
  assert.ok(rendered.text.length > 320, `rendered head was only ${rendered.text.length} chars`);
  const compacted = formatEvent({ seq: 0, type: 'log', text: rendered.text }, true);
  assert.match(compacted, /AssertionError: expected 0 got 1/, 'the diagnosis must survive both hops');
  assert.doesNotMatch(compacted, /bytes/, 'a summary must never be traded for a byte count');
});

test('formatJobState: cancellations name their kind; blocked keeps its marker', () => {
  // The whole point of #39: a silent job and an over-budget job look different.
  assert.equal(formatJobState({ state: 'cancelled', reason: 'stall' }), 'cancelled(stall)');
  assert.equal(formatJobState({ state: 'cancelled', reason: 'wall-clock' }), 'cancelled(wall-clock)');
  assert.equal(formatJobState({ state: 'cancelled' }), 'cancelled', 'no reason → plain state');
  assert.equal(formatJobState({ state: 'blocked', marker: 'parked' }), 'blocked(parked)');
  // A reason left over from an earlier event never decorates a live state.
  assert.equal(formatJobState({ state: 'running', reason: 'stall' }), 'running');
  assert.equal(formatJobState({ state: 'done' }), 'done');
});

test('formatJobState: attempt count shows on retried jobs — twice-failed must not look once-failed (#30)', () => {
  assert.equal(
    formatJobState({ state: 'cancelled', reason: 'harness-exit', attempt: 2 }),
    'cancelled(harness-exit) [attempt 2]',
  );
  assert.equal(formatJobState({ state: 'running', attempt: 2 }), 'running [attempt 2]');
  assert.equal(formatJobState({ state: 'done', attempt: 2 }), 'done [attempt 2]');
  // Attempt 1 is the default and stays unadorned.
  assert.equal(formatJobState({ state: 'cancelled', reason: 'harness-exit' }), 'cancelled(harness-exit)');
  assert.equal(formatJobState({ state: 'cancelled', reason: 'harness-exit', attempt: 1 }), 'cancelled(harness-exit)');
});

test('renderState: the retry re-queue event carries its reason and attempt in plain logs (#30)', () => {
  const line = formatEvent({ seq: 7, type: 'state', state: 'queued', reason: 'retry', attempt: 2 }, true);
  assert.equal(line, '[7] state → queued reason=retry attempt=2');
});

test('status shows cancelled(stall) distinctly from cancelled(wall-clock)', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => {
      sendJson(res, 200, {
        jobs: [
          { id: 'job-s', state: 'cancelled', reason: 'stall', workOrder: { finish: 'merge-ready', target: '39' } },
          { id: 'job-w', state: 'cancelled', reason: 'wall-clock', workOrder: { finish: 'merge-ready', target: '7' } },
        ],
      });
    },
  });
  t.after(daemon.close);

  const list = await runCli(['status'], { env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(list.code, 0, list.stderr);
  const lines = list.stdout.trim().split('\n');
  assert.match(lines[0], /job-s\s+cancelled\(stall\)\s+finish=merge-ready/);
  assert.match(lines[1], /job-w\s+cancelled\(wall-clock\)\s+finish=merge-ready/);
});

test('status lists jobs and shows a single job', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => {
      sendJson(res, 200, {
        jobs: [
          // Pre-#36 order shape: still carries `mode`. `fleet status` must
          // render its finish rung, not blank the column for every old job.
          { id: 'job-2', state: 'blocked', marker: 'parked', workOrder: { mode: 'assess', finish: 'inspected', target: 'APP-456' } },
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
  assert.match(lines[0], /job-2\s+blocked\(parked\)\s+finish=inspected\s+target=APP-456/, 'blocked-first order preserved');
  assert.match(lines[1], /job-1\s+running\s+finish=merge-ready\s+target=APP-123/);

  const one = await runCli(['status', 'job-1'], { env });
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /job-1\s+running/);

  const gone = await runCli(['status', 'job-9'], { env });
  assert.equal(gone.code, 1, 'unknown job fails');
});

test('status: shows #<n> <title> when work order has a title', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        jobs: [
          {
            id: 'job-3',
            state: 'running',
            workOrder: { finish: 'merge-ready', target: '37', title: 'Add legibility features' },
          },
        ],
      }),
    'GET /jobs/job-3': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        job: {
          id: 'job-3',
          state: 'running',
          workOrder: { finish: 'merge-ready', target: '37', title: 'Add legibility features' },
        },
      }),
  });
  t.after(daemon.close);
  const env = { FLEET_DAEMON_URL: daemon.url };

  const list = await runCli(['status'], { env });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /#37 Add legibility features/, 'title shown as #<n> <title>');

  const one = await runCli(['status', 'job-3'], { env });
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /#37 Add legibility features/, 'title shown for single job');
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

test('logs: default (narrative) filters tool_use/tool_result; --tools includes them; --full is raw JSON', async (t) => {
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

  // Default (narrative) mode: tool_use/tool_result lines are filtered out; spine is present.
  const narrative = await runCli(['logs', 'job-1'], { env: { ...env, NO_COLOR: '1' } });
  assert.equal(narrative.code, 0, narrative.stderr);
  assert.match(narrative.stdout, /\[0\] decision d1: Which approach\?/, 'decision in narrative');
  assert.match(narrative.stdout, /- a \(recommended\)/, 'decision option in narrative');
  assert.doesNotMatch(narrative.stdout, /\x1b\[/, 'NO_COLOR suppresses all ANSI codes');
  assert.doesNotMatch(narrative.stdout, /tool_use/, 'tool_use filtered from narrative');
  assert.doesNotMatch(narrative.stdout, /tool_result/, 'tool_result filtered from narrative');
  assert.match(narrative.stdout, /\[3\] think Considering options\./, 'think in narrative');
  assert.match(narrative.stdout, /\[4\] settle rung=merge-ready status=READY/, 'settle READY in narrative');
  assert.match(narrative.stdout, /\[5\] settle rung=blocked status=PARTIAL/, 'settle PARTIAL in narrative');

  // --tools mode: tool_use/tool_result rendered in compact form (superset of narrative).
  const withTools = await runCli(['logs', 'job-1', '--tools'], { env: { ...env, NO_COLOR: '1' } });
  assert.equal(withTools.code, 0, withTools.stderr);
  assert.match(withTools.stdout, /\[0\] decision d1: Which approach\?/, 'decision in --tools');
  assert.match(withTools.stdout, /\[1\] log tool_use Read file_path=\/src\/main\.ts/, 'tool_use compact in --tools');
  // Already a one-line summary (#50): shown verbatim, not traded for a byte count.
  assert.match(withTools.stdout, /\[2\] log tool_result toolu_01: console\.log\(hello\)/, 'terse tool_result verbatim in --tools');
  assert.match(withTools.stdout, /\[3\] think Considering options\./, 'think in --tools');
  assert.match(withTools.stdout, /\[4\] settle rung=merge-ready status=READY/, 'settle in --tools');
});

test('attach follows long-poll cycles until the job reaches a terminal state', async (t) => {
  let calls = 0;
  const daemon = await startMockDaemon({
    // attach probes the job before following (#124), so a typo'd id fails fast.
    'GET /jobs/job-1': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { job: RUNNING_JOB }),
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

// ── artifacts get --out: readable failures, never an ENOENT stack (#125) ─────

/** Mock daemon serving one artifact, the shape the real one returns. */
function artifactDaemon(): ReturnType<typeof startMockDaemon> {
  return startMockDaemon({
    'GET /jobs/job-1/artifacts/report.md': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { path: 'report.md', content: Buffer.from('# hi\n').toString('base64'), bytes: 5 }),
  });
}

test('artifacts get --out creates a missing directory instead of crashing on ENOENT', async (t) => {
  const daemon = await artifactDaemon();
  t.after(daemon.close);

  const outDir = path.join(makeTempDir('fleet-art-'), 'not', 'yet', 'there');
  const res = await runCli(['artifacts', 'job-1', 'get', 'report.md', '--out', outDir], {
    env: { FLEET_DAEMON_URL: daemon.url },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /saved to /);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(path.join(outDir, 'report.md'), 'utf8'), '# hi\n');
});

test('artifacts get --out that cannot be written is a one-line failure, exit 1, no stack', async (t) => {
  const daemon = await artifactDaemon();
  t.after(daemon.close);

  // --out names an existing *file*: mkdir/write must fail, readably.
  const blocked = path.join(makeTempDir('fleet-art-'), 'blocked');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(blocked, 'i am a file');
  const res = await runCli(['artifacts', 'job-1', 'get', 'report.md', '--out', blocked], {
    env: { FLEET_DAEMON_URL: daemon.url },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /artifacts get: cannot write /);
  assert.doesNotMatch(res.stderr, /node:internal|at .*\.ts:\d/, 'no stack trace');
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
