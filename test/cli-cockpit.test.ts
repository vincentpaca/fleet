// The cockpit (#61): bare `fleet` on a terminal — layout, key precedence, the
// command line's grammar, and the tunnel it adopts or owns.
//
// The pure layers are asserted directly (a frame is a string built from a
// model), and the loop is driven end to end through the real CLI with piped
// stdin: typing `delegate 61` must reach the daemon, and typing an option id
// must answer a blocked job — with nothing answered until a human types it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import {
  BANNER_MIN_ROWS,
  COCKPIT_FOOTER_KEYS,
  InputHistory,
  MIN_COLUMNS,
  SCROLL_LINES,
  cockpitKeyAction,
  completeCockpitInput,
  parseCockpitInput,
  renderCockpit,
  splitKeys,
  windowRosterRows,
  windowTail,
  type CockpitModel,
} from '../src/cli/cockpit.ts';
import { renderRosterRows, sortJobs, type BoardJob } from '../src/cli/board.ts';
import { visualLength } from '../src/cli/ansi.ts';
import type { FleetEvent } from '../src/shared/events.ts';
import { readTunnelRecord, portAccepts, probeDaemonHealth } from '../src/cli/connect.ts';
import { pidAlive } from '../src/shared/process.ts';
import {
  CLI,
  closedPort,
  fakeAwsBin,
  makeTempDir,
  projectWithConfig,
  runCli,
  sendJson,
  sendNdjson,
  startMockDaemon,
  until,
  type MockRequest,
} from './cli-helpers.ts';

// ---------- fixtures ----------

const BLOCKED: BoardJob = {
  id: 'job-blk',
  state: 'blocked',
  workOrder: { finish: 'merge-ready', target: '61', title: 'Cockpit' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:05:00Z',
  decision: {
    id: 'd1',
    question: 'Rename the endpoint?',
    options: [
      { id: 'keep', label: 'Keep /api/v1', recommended: true },
      { id: 'rename', label: 'Rename to /api/v2' },
    ],
  },
};

const RUNNING: BoardJob = {
  id: 'job-run',
  state: 'running',
  workOrder: { finish: 'inspected', target: 'docs' },
  createdAt: '2026-01-01T00:00:00Z',
  lastActivity: { text: 'reading the schema', at: '2026-01-01T00:04:00Z' },
};

const TAIL: FleetEvent[] = [
  { seq: 0, type: 'state', state: 'running' },
  { seq: 1, type: 'think', text: 'reading the schema' },
  {
    seq: 2, type: 'decision', id: 'd1', question: 'Rename the endpoint?',
    options: [{ id: 'keep', label: 'Keep /api/v1', recommended: true }, { id: 'rename', label: 'Rename to /api/v2' }],
  },
];

function model(over: Partial<CockpitModel> = {}): CockpitModel {
  return {
    jobs: sortJobs([RUNNING, BLOCKED]),
    selection: 0,
    view: 'board',
    tail: TAIL,
    tailScroll: 0,
    input: '',
    tunnel: { kind: 'adopted' },
    ...over,
  };
}

const NOW = Date.parse('2026-01-01T00:06:00Z');

function frame(m: CockpitModel, w = 80, h = 24): string[] {
  return renderCockpit(m, w, h, { noColor: true, now: NOW, endpoint: 'http://127.0.0.1:19000' }).split('\n');
}

// ---------- layout ----------

test('a frame is exactly the terminal it was given, at every size', () => {
  // A frame taller than the terminal scrolls the alternate screen on every
  // repaint; a line wider than it wraps and pushes every row below it down.
  // Both are unrecoverable in a full-screen view, so this holds at every size —
  // including the absurd ones, and in both views.
  for (const h of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 21, 22, 24, 40, 60]) {
    for (const w of [MIN_COLUMNS, 80, 200]) {
      for (const view of ['board', 'job'] as const) {
        const lines = frame(model({ view }), w, h);
        assert.equal(lines.length, h, `${view} at ${w}x${h} must be exactly ${h} lines`);
        for (const line of lines) {
          assert.ok(visualLength(line) <= w, `${view} at ${w}x${h}: line wider than ${w}: "${line}"`);
        }
      }
    }
  }
  // Whatever the terminal claims, the command line is always the last row.
  for (const h of [1, 4, 24]) assert.match(frame(model(), 80, h).at(-1) ?? '', /^› _/);
});

test('a shrinking terminal drops chrome from the outside in, keeping the board', () => {
  const has = (h: number, needle: string): boolean => frame(model(), 80, h).some((l) => l.includes(needle));
  // 24 rows: everything.
  assert.ok(has(24, 'F L E E T') && has(24, 'JOB ') && has(24, '↑↓ select'));
  // The banner goes first, then the table header, then the context strip — the
  // board and the command line are the last things standing.
  assert.ok(!has(21, 'F L E E T'), 'the banner is the first thing dropped');
  assert.ok(has(21, 'JOB '));
  assert.ok(!has(8, 'JOB '), 'the table header goes next');
  assert.ok(has(8, 'job-blk'), 'the board survives');
  assert.ok(!has(5, 'FLEET  http'), 'the context strip goes last');
  assert.ok(has(5, 'job-blk') && has(2, '↑↓ select'));
});

test('the board view stacks banner, strip, header, board, hints, input — and never a tail', () => {
  const lines = frame(model());
  const index = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(index('F L E E T') >= 0, 'the banner is the top of the frame');
  assert.ok(index('FLEET  http://127.0.0.1:19000') > index('F L E E T'), 'then the context strip');
  assert.ok(index('JOB ') > index('FLEET  http'), 'then the table header');
  assert.ok(index('job-blk') > index('JOB '), 'then the board');
  assert.equal(lines.length - 2, index('↑↓ select'), 'the key hints sit above the input line');
  assert.match(lines.at(-1) ?? '', /^› _/, 'the input line is the last line, with the caret');
  // Logs never stream onto the board: no tail divider, no event lines. The tail
  // exists only in the drill-down the operator opens on purpose (operator
  // feedback from the first live run: an uninvited tail floods the surface).
  assert.equal(index('tail:'), -1, 'no tail divider on the board');
  assert.equal(index('[1] reading the schema'), -1, 'no event lines on the board');
});

test('blocked jobs come first on the board, and their decision card is on the board', () => {
  const lines = frame(model());
  const blk = lines.findIndex((l) => l.includes('job-blk'));
  const run = lines.findIndex((l) => l.includes('job-run'));
  assert.ok(blk >= 0 && run > blk, 'blocked above running');
  assert.ok(lines[blk].includes('▶'), 'selection starts on the job that wants a human');
  // The board itself advertises what the blocked job wants — the roster card,
  // not a tail pane, is where the question and options live.
  const board = lines.join('\n');
  assert.match(board, /Rename the endpoint\?/);
  assert.match(board, /\[keep\] Keep \/api\/v1 ★/);
  assert.match(board, /\[rename\] Rename to \/api\/v2/);
  // And the card says how to act on it — an option id with no visible way to
  // send it reads as a dead end.
  assert.match(board, /answer: type an option id below — keep \| rename/);
});

test('the tail renders only in the drill-down, verbatim, windowed to its end', () => {
  // The drill-down's copy is the event log's, seq and all.
  const lines = frame(model({ view: 'job' }));
  const tail = lines.join('\n');
  assert.match(tail, /\[2\] \? Rename the endpoint\?/);
  assert.match(tail, /\[keep\] Keep \/api\/v1 ★/);
  assert.match(tail, /\[rename\] Rename to \/api\/v2/);
  assert.match(tail, /answer: type an option id below — keep \| rename/, 'the tail card says how to answer too');
  // Windowed, not re-rendered whole: a long history still shows its end.
  const long: FleetEvent[] = Array.from({ length: 5_000 }, (_, i) => ({ seq: i, type: 'log', text: `line ${i}` }));
  const drilled = frame(model({ view: 'job', tail: long }));
  assert.match(drilled.join('\n'), /line 4999/, 'the newest event is on screen');
  assert.doesNotMatch(drilled.join('\n'), /line 0\b/, 'the oldest is not');
  // A blocked job's open decision is pinned above the input line — visible no
  // matter how much transcript is above it (the question was unfindable under
  // a long noisy tail: operator feedback, first parked decision).
  const pinned = drilled.slice(-6).join('\n');
  assert.match(pinned, /Rename the endpoint\?/, 'the question is pinned at the bottom');
  assert.match(pinned, /answer: type an option id below — keep \| rename/, 'and how to act on it');
  // A running selection pins nothing.
  const runningDrill = frame(model({ view: 'job', selection: 1, tail: long }));
  assert.doesNotMatch(runningDrill.slice(-6).join('\n'), /answer: type an option id/);
  // Scrolled back, the window moves with the scroll rather than clamping to the
  // slice that happened to be rendered.
  assert.match(frame(model({ view: 'job', tail: long, tailScroll: 100 })).join('\n'), /line 489\d/);
});

test('the banner yields to the board on a short terminal', () => {
  assert.ok(frame(model(), 80, BANNER_MIN_ROWS).some((l) => l.includes('F L E E T')));
  assert.ok(!frame(model(), 80, BANNER_MIN_ROWS - 1).some((l) => l.includes('F L E E T')));
  // What the banner cost goes to the board, not to nothing.
  const populated = frame(model(), 80, BANNER_MIN_ROWS - 1).filter((l) => l.trim() !== '').length;
  assert.ok(populated > 6, 'a short frame is still populated');
});

test('the board owns the whole body: many jobs use the rows the tail no longer takes', () => {
  const jobs = sortJobs(Array.from({ length: 20 }, (_, i) => ({ id: `job-${i}`, state: 'running' as const })));
  const lines = frame(model({ jobs }), 80, 30);
  const shown = lines.filter((l) => /job-\d/.test(l)).length;
  // Under the old split layout the board was capped at half the space (~10 rows
  // at this height). With the tail gone it runs to the footer. Fourteen rather
  // than fifteen because the dart banner is ten rows where the hand-drawn plane
  // was six (#225) — the point is that the board takes whatever chrome does not,
  // not the exact number.
  assert.ok(shown >= 14, `the board should fill the body, got ${shown} job rows`);
  assert.equal(lines.length, 30, 'the frame is still exactly the terminal');
});

test('an empty fleet says how to start one, from the line below', () => {
  const lines = frame(model({ jobs: [], selection: -1, tail: [] }));
  assert.match(lines.join('\n'), /no jobs — dispatch one from the line below: delegate <target>/);
  assert.match(lines.at(-1) ?? '', /^› _/, 'the input line is still there');
});

test('the drill-down keeps the command line: a job is answered from where it is read', () => {
  const lines = frame(model({ view: 'job' }));
  assert.match(lines[1], /job-blk.*blocked.*#61: Cockpit/, 'the job line names it in full');
  assert.ok(!lines.some((l) => l.includes('F L E E T')), 'a drill-down is focused: no banner');
  assert.ok(!lines.some((l) => l.includes('JOB ')), 'and no roster');
  assert.match(lines.join('\n'), /Rename the endpoint\?/, 'the tail is the point');
  assert.match(lines.at(-1) ?? '', /^› _/);
  assert.equal(lines.length, 24);
});

test('a pending confirmation replaces the input line and says what it will do', () => {
  const lines = frame(model({ confirm: 'cancel job-blk?' }));
  assert.match(lines.at(-1) ?? '', /cancel job-blk\? \[y\/N\]/);
});

test('a transient notice displaces the key hints, not a pane', () => {
  const lines = frame(model({ status: 'job-9 queued — 61' }));
  assert.equal(lines.length, 24);
  assert.match(lines.at(-2) ?? '', /job-9 queued — 61/);
  assert.ok(!lines.some((l) => l.includes('↑↓ select')), 'the notice takes the hint line');
});

test('a long input line keeps its caret visible', () => {
  const typed = 'delegate '.padEnd(300, 'x');
  const last = frame(model({ input: typed })).at(-1) ?? '';
  assert.ok(last.endsWith('_'), 'the caret is on screen');
  assert.ok(visualLength(last) <= 80);
});

// ---------- windowing ----------

test('windowRosterRows keeps the selected job on screen, scrolling by job', () => {
  const jobs: BoardJob[] = Array.from({ length: 12 }, (_, i) => ({ id: `job-${i}`, state: 'running' }));
  const rows = renderRosterRows(jobs, 11, 80, { noColor: true });
  const top = windowRosterRows(rows, 0, 4);
  assert.deepEqual(top.map((l) => l.trim().split(/\s+/)[1]), ['job-0', 'job-1', 'job-2', 'job-3']);
  const bottom = windowRosterRows(rows, 11, 4);
  assert.ok(bottom.some((l) => l.includes('job-11')), 'the selected job is in the window');
  assert.ok(!bottom.some((l) => l.includes('job-0')), 'and the top has scrolled away');
  assert.equal(windowRosterRows(rows, 11, 0).length, 0, 'no budget, no rows');
});

test('windowRosterRows never splits a job from its own decision card', () => {
  const jobs: BoardJob[] = [
    { id: 'job-a', state: 'running' },
    { id: 'job-blk', state: 'blocked', decision: { id: 'd1', question: 'Q?', options: [{ id: 'x' }, { id: 'y' }] } },
  ];
  const rows = renderRosterRows(sortJobs(jobs), 0, 80, { noColor: true });
  // The blocked group is 6 lines (row, question, two options, the answer
  // hint, a blank); a 6-line budget must show it whole.
  const window = windowRosterRows(rows, 0, 6);
  assert.equal(window.length, 6);
  assert.match(window.join('\n'), /Q\?[\s\S]*\[x\][\s\S]*\[y\][\s\S]*answer: type an option id/);
});

test('windowTail follows the end by default and clamps a scroll past the top', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  assert.deepEqual(windowTail(lines, 0, 3), ['line 27', 'line 28', 'line 29']);
  assert.deepEqual(windowTail(lines, 5, 3), ['line 22', 'line 23', 'line 24']);
  assert.deepEqual(windowTail(lines, 9_999, 3), ['line 0', 'line 1', 'line 2']);
  // Fewer lines than the budget: the pane keeps its shape and the transcript
  // grows downward from the top, the way a terminal fills.
  assert.deepEqual(windowTail(['only'], 0, 3), ['only', '', '']);
  assert.deepEqual(windowTail([], 0, 2), ['', '']);
  assert.deepEqual(windowTail(lines, 0, 0), [], 'no budget, no lines');
});

// ---------- keys ----------

test('every advertised key reaches a handler', () => {
  for (const { label, rawKeys } of COCKPIT_FOOTER_KEYS) {
    for (const key of rawKeys) {
      // Each advertised key must do something in the state its label describes:
      // navigation on an empty line, editing on a written one.
      const empty = cockpitKeyAction(key, { inputEmpty: true });
      const written = cockpitKeyAction(key, { inputEmpty: false });
      assert.ok(
        empty.kind !== 'ignore' || written.kind !== 'ignore',
        `key ${JSON.stringify(key)} (${label}) has no handler`,
      );
    }
  }
});

test('the hint line advertises every key manifest entry, and every key that moves the view', () => {
  const hints = frame(model()).at(-2) ?? '';
  for (const { label } of COCKPIT_FOOTER_KEYS) assert.ok(hints.includes(label), `missing hint: ${label}`);
  // The other direction: a key that navigates, opens, scrolls or quits must be
  // advertised. Editing keys (backspace, ^u, ^d) and printable text are exempt —
  // nobody needs telling that letters type.
  const advertised = new Set(COCKPIT_FOOTER_KEYS.flatMap((k) => k.rawKeys));
  for (const key of ['\x1b[A', '\x1b[B', 'j', 'k', '\r', '\n', '\x1b', '\t', '\x10', '\x0e', '\x1b[5~', '\x1b[6~', '\x03']) {
    assert.ok(advertised.has(key), `key ${JSON.stringify(key)} is bound but not advertised`);
  }
});

test('printable characters go to the input line — except j/k while it is empty', () => {
  assert.deepEqual(cockpitKeyAction('j', { inputEmpty: true }), { kind: 'select', delta: 1 });
  assert.deepEqual(cockpitKeyAction('k', { inputEmpty: true }), { kind: 'select', delta: -1 });
  assert.deepEqual(cockpitKeyAction('j', { inputEmpty: false }), { kind: 'insert', text: 'j' });
  assert.deepEqual(cockpitKeyAction('d', { inputEmpty: true }), { kind: 'insert', text: 'd' });
  assert.deepEqual(cockpitKeyAction('é', { inputEmpty: false }), { kind: 'insert', text: 'é' });
  // An open option that starts with a navigation letter takes it back: with
  // "keep" on screen, `k` is the first character of an answer. Arrows still move,
  // so neither the answer nor the next job is out of reach.
  assert.deepEqual(cockpitKeyAction('k', { inputEmpty: true, optionIds: ['keep', 'rename'] }), { kind: 'insert', text: 'k' });
  assert.deepEqual(cockpitKeyAction('j', { inputEmpty: true, optionIds: ['keep'] }), { kind: 'select', delta: 1 });
  assert.deepEqual(cockpitKeyAction('\x1b[A', { inputEmpty: true, optionIds: ['keep'] }), { kind: 'select', delta: -1 });
  // An escape sequence with no meaning here must be ignored, never typed: a
  // shift-tab that arrives as "[Z" in the command line is worse than nothing.
  assert.equal(cockpitKeyAction('\x1b[Z', { inputEmpty: true }).kind, 'ignore');
  assert.equal(cockpitKeyAction('\x1bOP', { inputEmpty: false }).kind, 'ignore');
});

test('arrows navigate an empty line and walk history a written one; ^p/^n always walk', () => {
  assert.deepEqual(cockpitKeyAction('\x1b[A', { inputEmpty: true }), { kind: 'select', delta: -1 });
  assert.deepEqual(cockpitKeyAction('\x1b[B', { inputEmpty: true }), { kind: 'select', delta: 1 });
  assert.deepEqual(cockpitKeyAction('\x1b[A', { inputEmpty: false }), { kind: 'history', delta: -1 });
  assert.deepEqual(cockpitKeyAction('\x10', { inputEmpty: true }), { kind: 'history', delta: -1 });
  assert.deepEqual(cockpitKeyAction('\x0e', { inputEmpty: false }), { kind: 'history', delta: 1 });
});

test('enter opens a job from an empty line and submits a written one; esc backs out or clears', () => {
  assert.deepEqual(cockpitKeyAction('\r', { inputEmpty: true }), { kind: 'open' });
  assert.deepEqual(cockpitKeyAction('\n', { inputEmpty: false }), { kind: 'submit' });
  assert.deepEqual(cockpitKeyAction('\x1b', { inputEmpty: true }), { kind: 'back' });
  assert.deepEqual(cockpitKeyAction('\x1b', { inputEmpty: false }), { kind: 'clear' });
  assert.deepEqual(cockpitKeyAction('\x7f', { inputEmpty: false }), { kind: 'erase' });
  assert.deepEqual(cockpitKeyAction('\x15', { inputEmpty: false }), { kind: 'clear' });
  assert.deepEqual(cockpitKeyAction('\x1b[5~', { inputEmpty: true }), { kind: 'scroll', delta: SCROLL_LINES });
  assert.deepEqual(cockpitKeyAction('\x1b[6~', { inputEmpty: true }), { kind: 'scroll', delta: -SCROLL_LINES });
});

test('^C quits from anywhere, including a pending confirmation', () => {
  assert.deepEqual(cockpitKeyAction('\x03', { inputEmpty: false }), { kind: 'quit' });
  assert.deepEqual(cockpitKeyAction('\x03', { inputEmpty: true, confirming: true }), { kind: 'quit' });
  assert.deepEqual(cockpitKeyAction('\x04', { inputEmpty: true }), { kind: 'quit' });
  assert.deepEqual(cockpitKeyAction('\x04', { inputEmpty: false }), { kind: 'ignore' }, '^D mid-line is not a quit');
});

test('a confirmation takes only y or n: anything else declines', () => {
  assert.deepEqual(cockpitKeyAction('y', { inputEmpty: true, confirming: true }), { kind: 'confirm', yes: true });
  assert.deepEqual(cockpitKeyAction('Y', { inputEmpty: true, confirming: true }), { kind: 'confirm', yes: true });
  for (const key of ['n', '\r', '\x1b', 'x', 'j']) {
    assert.deepEqual(
      cockpitKeyAction(key, { inputEmpty: true, confirming: true }),
      { kind: 'confirm', yes: false },
      `${JSON.stringify(key)} must not cancel a job`,
    );
  }
});

test('splitKeys turns one read into the keys it actually contains', () => {
  // One key per character, escape sequences whole. Grouping characters would
  // make a chunk mean something the same keys typed slowly do not: `jj` would
  // type into the line instead of moving twice, and the first character of a
  // chunk answering a y/N prompt would swallow the rest of it.
  assert.deepEqual(splitKeys('jj'), ['j', 'j']);
  assert.deepEqual(splitKeys('ncancel\r'), ['n', 'c', 'a', 'n', 'c', 'e', 'l', '\r']);
  assert.deepEqual(splitKeys('\x1b[A\x1b[B'), ['\x1b[A', '\x1b[B']);
  assert.deepEqual(splitKeys('\x1b'), ['\x1b'], 'a lone escape is a key');
  assert.deepEqual(splitKeys('a\x7f\x1b[5~b'), ['a', '\x7f', '\x1b[5~', 'b']);
  assert.deepEqual(splitKeys(''), []);
  // A code point, not a byte or a surrogate half.
  assert.deepEqual(splitKeys('é🚀'), ['é', '🚀']);
});

// ---------- the command line ----------

test('delegate: target, flags, and a missing target', () => {
  assert.deepEqual(parseCockpitInput('delegate 61'), { kind: 'delegate', target: '61' });
  assert.deepEqual(parseCockpitInput('  delegate   61  '), { kind: 'delegate', target: '61' });
  assert.equal(parseCockpitInput('delegate').kind, 'error');
  // --publish is gone (#208): prose delivery is prompt-owned, so the word is
  // target text under the same unknown---word convention pinned below — the
  // cockpit must not keep honouring a flag `fleet delegate` now refuses.
  assert.deepEqual(parseCockpitInput('delegate --publish draft the note'), {
    kind: 'delegate', target: '--publish draft the note',
  });
  assert.deepEqual(parseCockpitInput('delegate look into the stall backstop'), {
    kind: 'delegate', target: 'look into the stall backstop',
  });
  assert.deepEqual(parseCockpitInput('delegate 61 --finish pushed'), {
    kind: 'delegate', target: '61', finish: 'pushed',
  });
  assert.equal(parseCockpitInput('delegate 61 --finish').kind, 'error');
  // An unrecognised --word is target text, not an error — this line has no
  // quoting layer, and Fleet's own domain is CLI flags, so a symptom statement
  // naming one has to stay dispatchable. Same trade nearVerb makes.
  assert.deepEqual(parseCockpitInput('delegate why does --watch hang after a settle'), {
    kind: 'delegate', target: 'why does --watch hang after a settle',
  });
  // --mode survives the migration window, deprecated, with its own refusals.
  assert.deepEqual(parseCockpitInput('delegate 61 --mode assess'), { kind: 'delegate', target: '61', mode: 'assess' });
  assert.equal(parseCockpitInput('delegate 61 --mode').kind, 'error');
});

test('a line that is not a verb is a delegate payload — a target or a symptom statement', () => {
  assert.deepEqual(parseCockpitInput('APP-123'), { kind: 'delegate', target: 'APP-123' });
  assert.deepEqual(parseCockpitInput('login redirects to /null on Safari'), {
    kind: 'delegate',
    target: 'login redirects to /null on Safari',
  });
});

test('a misspelled verb is a typo, not a job about a typo', () => {
  for (const line of ['delegat 61', 'delegat', 'answe keep', 'cance job-1']) {
    const typo = parseCockpitInput(line);
    assert.equal(typo.kind, 'error', `"${line}" must not dispatch`);
    // And it says how to dispatch the line anyway, since that is the only way
    // past a guard that has made the wrong call.
    assert.match(typo.kind === 'error' ? typo.message : '', /did you mean \w+\? \(to dispatch it as written: delegate /);
  }
});

test('the typo guard never eats an ordinary symptom statement', () => {
  // Free text is the headline of rule 3, and English starts sentences with short
  // words that shadow these verbs constantly. Every one of these is a dispatch.
  for (const line of [
    'a login page 500s',
    'an error appears on login',
    'at startup the app crashes',
    'log the user out and it fails',
    'login redirects to /null on Safari',
    'cancel-order endpoint times out', // hyphenated, so not the verb
    'APP-123',
    '61',
  ]) {
    assert.deepEqual(parseCockpitInput(line), { kind: 'delegate', target: line }, `"${line}" must dispatch as written`);
  }
});

test('a bare option id answers the selected job; a verb always wins over it', () => {
  const ctx = { optionIds: ['keep', 'rename'] };
  assert.deepEqual(parseCockpitInput('keep', ctx), { kind: 'answer', option: 'keep' });
  assert.deepEqual(parseCockpitInput('rename', ctx), { kind: 'answer', option: 'rename' });
  // With nothing open, the same word is a dispatch — the state is the difference,
  // which is why the option ids come from the job and not from a guess.
  assert.deepEqual(parseCockpitInput('keep'), { kind: 'delegate', target: 'keep' });
  // A word that happens to be a verb is the verb, whatever the job is waiting on.
  assert.equal(parseCockpitInput('cancel', { optionIds: ['cancel'] }).kind, 'cancel');
});

test('answer takes the one answer grammar the rest of the CLI takes', () => {
  assert.deepEqual(parseCockpitInput('answer keep'), { kind: 'answer', option: 'keep' });
  assert.deepEqual(parseCockpitInput('answer keep for now'), { kind: 'answer', option: 'keep', text: 'for now' });
  assert.deepEqual(parseCockpitInput('answer text: your call'), { kind: 'answer', text: 'your call' });
  assert.equal(parseCockpitInput('answer').kind, 'error');
});

test('cancel, logs and attach default to the selected job', () => {
  assert.deepEqual(parseCockpitInput('cancel'), { kind: 'cancel' });
  assert.deepEqual(parseCockpitInput('cancel job-7'), { kind: 'cancel', jobId: 'job-7' });
  assert.deepEqual(parseCockpitInput('logs'), { kind: 'focus' });
  assert.deepEqual(parseCockpitInput('logs job-7'), { kind: 'focus', jobId: 'job-7' });
  assert.deepEqual(parseCockpitInput('attach job-7'), { kind: 'focus', jobId: 'job-7' });
});

test('help and quit are commands; an empty line is nothing', () => {
  assert.equal(parseCockpitInput('help').kind, 'help');
  assert.equal(parseCockpitInput('?').kind, 'help');
  assert.equal(parseCockpitInput('quit').kind, 'quit');
  assert.equal(parseCockpitInput('exit').kind, 'quit');
  assert.equal(parseCockpitInput('   ').kind, 'nothing');
});

test('completion: verbs on the first word, job ids after it', () => {
  assert.equal(completeCockpitInput('del'), 'delegate ');
  assert.equal(completeCockpitInput('a'), 'a', 'answer and attach share a prefix: extend and wait');
  assert.equal(completeCockpitInput('an'), 'answer ');
  assert.equal(completeCockpitInput('zz'), 'zz', 'nothing to complete leaves the line alone');
  assert.equal(completeCockpitInput(''), '');
  assert.equal(completeCockpitInput('cancel job-', { jobIds: ['job-abc'] }), 'cancel job-abc ');
  assert.equal(completeCockpitInput('cancel job-', { jobIds: ['job-a', 'job-b'] }), 'cancel job-');
});

test('history: newest last, no repeats, and walkable in both directions', () => {
  const history = new InputHistory();
  history.add('delegate 61');
  history.add('delegate 61'); // typed twice, remembered once
  history.add('  ');          // nothing is not history
  history.add('cancel job-1');
  assert.deepEqual(history.entries, ['delegate 61', 'cancel job-1']);
  assert.equal(history.walk(-1), 'cancel job-1', 'one back is the last command');
  assert.equal(history.walk(-1), 'delegate 61');
  assert.equal(history.walk(-1), 'delegate 61', 'the top of history holds');
  assert.equal(history.walk(1), 'cancel job-1');
  assert.equal(history.walk(1), '', 'past the newest is an empty line again');
  assert.equal(new InputHistory().walk(-1), '', 'an empty history walks to nothing');
});

// ---------- end to end: the real cockpit, driven through stdin ----------

type Cockpit = {
  child: ChildProcess;
  output: () => string;
  /** The last frame painted: everything written since the most recent cursor-home. */
  frame: () => string;
  type: (keys: string) => void;
  /** Leave the cockpit the way an operator does, and wait for it to be gone. */
  quit: () => Promise<number | null>;
};

function startCockpit(opts: { cwd: string; env: Record<string, string | undefined> }): Cockpit {
  const env: Record<string, string | undefined> = {
    ...process.env,
    FLEET_DAEMON_URL: undefined,
    FLEET_FORCE_TTY: '1', // no pty in a test: drive the loop as if there were a terminal
    NO_COLOR: '1',
    ...opts.env,
  };
  const child = spawn(process.execPath, [CLI], {
    cwd: opts.cwd,
    env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  return {
    child,
    output: () => output,
    // Frames are written as cursor-home followed by every row, so the text after
    // the last '\x1b[H' is what is on screen right now.
    frame: () => output.slice(output.lastIndexOf('\x1b[H')),
    type: (keys) => child.stdin.write(keys),
    quit: async () => {
      const closed = Promise.withResolvers<number | null>();
      child.on('close', (code) => closed.resolve(code));
      child.stdin.write('\x03'); // ^C, the way it is advertised
      const code = await Promise.race([
        closed.promise,
        new Promise<number | null>((resolve) => setTimeout(() => resolve(-1), 15_000)),
      ]);
      if (code === -1) child.kill('SIGKILL');
      return code;
    },
  };
}

/**
 * Wait for a predicate about the cockpit, reporting what it was actually doing
 * when the wait ran out. The state has to be read at failure time, not when the
 * wait started — a diagnosis from before the thing failed to happen is worse
 * than none, and cost an afternoon.
 */
async function waitFor(cockpit: Cockpit, label: string, predicate: () => boolean): Promise<void> {
  try {
    await until(predicate, label, 15_000);
  } catch (err) {
    const how = cockpit.child.exitCode === null ? 'still running' : `exited ${cockpit.child.exitCode}`;
    throw new Error(`${(err as Error).message} (the cockpit is ${how})\nlast frame:\n${cockpit.frame()}`);
  }
}

/** Wait until the cockpit has painted something containing `needle`, ever. */
async function shows(cockpit: Cockpit, needle: string, label = needle): Promise<void> {
  await waitFor(cockpit, `the cockpit to show ${label}`, () => cockpit.output().includes(needle));
}

/**
 * Wait until the cockpit's *current* frame contains `needle` — for state that
 * has to be true now. `shows` matches anything ever painted, which cannot tell
 * a live prompt from one that was dismissed ten frames ago.
 */
async function nowShows(cockpit: Cockpit, needle: string, label = needle): Promise<void> {
  await waitFor(cockpit, `the current frame to show ${label}`, () => cockpit.frame().includes(needle));
}

/** Wait until the current frame no longer contains `needle`. */
async function noLongerShows(cockpit: Cockpit, needle: string): Promise<void> {
  await waitFor(cockpit, `the current frame to drop ${needle}`, () => !cockpit.frame().includes(needle));
}

/**
 * A repo a dispatch can actually be built from: a valid manifest, and a git
 * identity of its own — job commits are authored as the operator, so `delegate`
 * refuses without one, and a test must not depend on the machine's global config.
 */
function scaffold(): string {
  const cwd = makeTempDir('fleet-cockpit-repo-');
  fs.mkdirSync(path.join(cwd, '.fleet'));
  fs.writeFileSync(
    path.join(cwd, '.fleet', 'manifest.json'),
    JSON.stringify({
      version: 1,
      setup: { image: 'node:22' },
      workspace: { repo: 'https://github.com/acme/example-app.git', strategy: 'branch-per-job' },
      harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }] },
      gates: { pickup: 'true', default_finish: 'merge-ready' },
    }),
  );
  for (const args of [['init', '-q'], ['config', 'user.name', 'Cockpit Test'], ['config', 'user.email', 'cockpit@fleet.invalid']]) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return cwd;
}

test('the cockpit renders the board and quits clean, leaving the terminal as it found it', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        jobs: [
          { id: 'job-run', state: 'running', workOrder: { finish: 'merge-ready', target: 'app' } },
          { id: 'job-blk', state: 'blocked', updatedAt: '2026-01-01T00:00:00Z', workOrder: { finish: 'inspected', target: 'docs' } },
        ],
      }),
    'GET /jobs/job-blk/events': (_req: MockRequest, res: ServerResponse) =>
      sendNdjson(res, [
        { job: 'job-blk', seq: 0, type: 'decision', id: 'd1', question: 'Which strategy?', options: [{ id: 'fast', label: 'Fast path', recommended: true }, { id: 'safe', label: 'Safe path' }] },
        { job: 'job-blk', seq: 1, type: 'state', state: 'blocked' },
      ]),
    'GET /jobs/job-run/events': (_req: MockRequest, res: ServerResponse) => sendNdjson(res, []),
  });
  t.after(daemon.close);

  const cockpit = startCockpit({ cwd: makeTempDir('fleet-cockpit-'), env: { FLEET_DAEMON_URL: daemon.url } });
  t.after(() => cockpit.child.kill('SIGKILL'));

  await shows(cockpit, '\x1b[?1049h', 'the alternate screen');
  await nowShows(cockpit, 'job-blk');
  // One frame, so this is the board as it stands rather than anything ever drawn.
  const painted = cockpit.frame();
  assert.ok(painted.indexOf('job-blk') < painted.indexOf('job-run'), 'blocked first, on the real board');
  assert.match(painted, /Which strategy\?/, 'the open decision is on the board');
  assert.match(painted, /Fast path/);
  assert.match(painted, /› _/, 'the input line is there to type into');

  assert.equal(await cockpit.quit(), 0, `^C leaves cleanly:\n${cockpit.output()}`);
  assert.ok(cockpit.output().includes('\x1b[?25h\x1b[?1049l'), 'the alternate screen is restored on the way out');
});

test('a delegate typed at the input line dispatches, and nothing else does', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }),
    'POST /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 201, { job: { id: 'job-new', state: 'queued' } }),
  });
  t.after(daemon.close);

  const cwd = scaffold();
  const cockpit = startCockpit({ cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  t.after(() => cockpit.child.kill('SIGKILL'));
  await shows(cockpit, 'no jobs', 'the empty board');
  assert.equal(daemon.requests.filter((r) => r.method === 'POST').length, 0, 'a cockpit that just opened dispatches nothing');

  // Typed one keystroke at a time, the way a terminal delivers them.
  for (const key of 'delegate APP-123') cockpit.type(key);
  await shows(cockpit, '› delegate APP-123', 'the typed line');
  cockpit.type('\r');

  await shows(cockpit, 'job-new queued', 'the dispatched job');
  const posted = daemon.requests.filter((r) => r.method === 'POST' && r.url === '/jobs');
  assert.equal(posted.length, 1, 'exactly one dispatch');
  const body = JSON.parse(posted[0].body);
  assert.equal(body.workOrder.target, 'APP-123');
  // APP-123 is prose, so the shape defaults apply — read-only, inspected, no
  // PR — exactly as `fleet delegate APP-123` would build it (#36).
  assert.equal(body.workOrder.finish, 'inspected', 'the shape default, from the same path delegate uses');
  assert.equal(body.workOrder.authority.publish, false);
  assert.equal(body.workOrder.authority.merge, false, 'merge is never grantable, whoever typed it');
  assert.ok(body.manifest, 'the manifest travels with the dispatch, exactly as fleet delegate sends it');

  // The dispatch is recorded in this checkout's ledger — the cockpit uses the
  // same dispatch path, so `fleet resume` sees a cockpit-dispatched job.
  await until(
    () => fs.existsSync(path.join(cwd, '.fleet', 'dispatched.jsonl')),
    'the dispatch ledger to name the job',
  );
  assert.match(fs.readFileSync(path.join(cwd, '.fleet', 'dispatched.jsonl'), 'utf8'), /job-new/);
  assert.equal(await cockpit.quit(), 0);
});

test("a flag typed at the input line reaches the order, not just the parser", async (t) => {
  // The seam a pure parseCockpitInput test cannot see: cmdCockpit's `delegate`
  // dep is the only hop between the input line and dispatchDelegate, and it is
  // the one hop the cockpit's other e2e tests stub out. A field parsed, carried
  // through four types and dropped here looks exactly like a working flag.
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }),
    'POST /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 201, { job: { id: 'job-flagged', state: 'queued' } }),
  });
  t.after(daemon.close);

  const cockpit = startCockpit({ cwd: scaffold(), env: { FLEET_DAEMON_URL: daemon.url } });
  t.after(() => cockpit.child.kill('SIGKILL'));
  await shows(cockpit, 'no jobs', 'the empty board');

  for (const key of 'delegate --finish pushed look into the stall backstop') cockpit.type(key);
  cockpit.type('\r');
  await shows(cockpit, 'job-flagged queued', 'the dispatched job');

  const posted = daemon.requests.filter((r) => r.method === 'POST' && r.url === '/jobs');
  assert.equal(posted.length, 1);
  const order = JSON.parse(posted[0].body).workOrder;
  assert.equal(order.target, 'look into the stall backstop', 'the flag is not part of the target');
  assert.equal(order.finish, 'pushed', '--finish reached the order');
  assert.equal(order.authority.publish, false, 'prose has no publish default and no flag to change it (#208)');
  assert.equal(await cockpit.quit(), 0);
});

test('a dispatch the CLI would refuse is refused in the cockpit too, and says why', async (t) => {
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }),
    'POST /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 201, { job: { id: 'job-x', state: 'queued' } }),
  });
  t.after(daemon.close);
  const cockpit = startCockpit({ cwd: scaffold(), env: { FLEET_DAEMON_URL: daemon.url } });
  t.after(() => cockpit.child.kill('SIGKILL'));
  await shows(cockpit, 'no jobs');

  cockpit.type('delegate 61 --mode conquer\r');
  await shows(cockpit, 'unknown mode "conquer"', 'the same refusal fleet delegate gives');
  assert.equal(daemon.requests.filter((r) => r.method === 'POST').length, 0, 'nothing was dispatched');

  // And it stays put. This daemon answers no /health, so the tunnel check is
  // failing in the same seconds — background notices must not talk over what the
  // operator just did, or a refused command reads as an unrelated port message.
  // No fixed sleep: wait for the first tunnel probe to settle (the header strip
  // stops saying "tunnel:…"), so any notice it could post has had its chance,
  // then judge the refusal on the settled frame.
  await noLongerShows(cockpit, 'tunnel:…');
  await nowShows(cockpit, 'unknown mode "conquer"', 'the refusal is still the thing on screen');
  assert.doesNotMatch(cockpit.frame(), /accepts connections/, 'the tunnel note waited its turn');
  // The cockpit survives it: a refused command is a notice, not an exit.
  assert.match(cockpit.frame(), /› _/, 'and the line is ready for the next command');
  assert.equal(await cockpit.quit(), 0);
});

test("a blocked job's decision is answered from the cockpit, and never by the cockpit", async (t) => {
  let answered: string | undefined;
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        jobs: [{
          id: 'job-blk',
          state: answered === undefined ? 'blocked' : 'running',
          updatedAt: '2026-01-01T00:00:00Z',
          workOrder: { finish: 'merge-ready', target: '61' },
        }],
      }),
    'GET /jobs/job-blk/events': (_req: MockRequest, res: ServerResponse) =>
      sendNdjson(res, [
        { job: 'job-blk', seq: 0, type: 'think', text: 'weighing the options' },
        {
          job: 'job-blk', seq: 1, type: 'decision', id: 'd1', question: 'Rename the endpoint?',
          options: [{ id: 'keep', label: 'Keep /api/v1', recommended: true }, { id: 'rename', label: 'Rename to /api/v2' }],
        },
        { job: 'job-blk', seq: 2, type: 'state', state: 'blocked' },
      ]),
    'POST /jobs/job-blk/answer': (req: MockRequest, res: ServerResponse) => {
      answered = req.body;
      sendJson(res, 200, { ok: true });
    },
  });
  t.after(daemon.close);

  const cockpit = startCockpit({ cwd: makeTempDir('fleet-cockpit-'), env: { FLEET_DAEMON_URL: daemon.url } });
  t.after(() => cockpit.child.kill('SIGKILL'));

  // The card renders on the board itself with the schema's own options — no
  // tail pane needed to see what a blocked job wants.
  await shows(cockpit, 'Rename the endpoint?', 'the decision card');
  assert.match(cockpit.output(), /\[keep\] Keep \/api\/v1/, 'options verbatim');
  // A whole render cycle has passed with an open question and nothing answered:
  // an agent answering its own question is the bug this design exists to prevent.
  assert.equal(answered, undefined, 'the cockpit must never answer a decision on its own');

  // The option id, straight at the line — including its leading `k`, which is
  // also the navigation key. An open option takes its letter back, or the most
  // natural answer on the board would be the one thing that cannot be typed.
  cockpit.type('keep\r');
  await until(() => answered !== undefined, `the answer to reach the daemon\n${cockpit.output()}`);
  assert.deepEqual(JSON.parse(answered ?? '{}'), { option: 'keep' });
  await shows(cockpit, 'answered job-blk');
  assert.equal(await cockpit.quit(), 0);
});

test("answering one decision does not refetch the other blocked jobs' logs (#125)", async (t) => {
  const decisionOf = (id: string, option: string) => [
    { job: id, seq: 0, type: 'decision', id: 'd1', question: `Proceed on ${id}?`, options: [{ id: option, label: 'Go', recommended: true }, { id: 'halt', label: 'Halt' }] },
    { job: id, seq: 1, type: 'state', state: 'blocked' },
  ];
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        jobs: [
          { id: 'job-a', state: 'blocked', updatedAt: '2026-01-01T00:00:00Z', workOrder: { finish: 'merge-ready', target: '1' } },
          { id: 'job-b', state: 'blocked', updatedAt: '2026-01-01T00:00:00Z', workOrder: { finish: 'merge-ready', target: '2' } },
        ],
      }),
    'GET /jobs/job-a/events': (_req: MockRequest, res: ServerResponse) => sendNdjson(res, decisionOf('job-a', 'go')),
    'GET /jobs/job-b/events': (_req: MockRequest, res: ServerResponse) => sendNdjson(res, decisionOf('job-b', 'go')),
    'POST /jobs/job-a/answer': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { ok: true }),
  });
  t.after(daemon.close);

  const cockpit = startCockpit({ cwd: makeTempDir('fleet-cockpit-'), env: { FLEET_DAEMON_URL: daemon.url } });
  t.after(() => cockpit.child.kill('SIGKILL'));

  await shows(cockpit, 'Proceed on job-b?', "both jobs' decision cards");
  // Decision reads are the plain (non-follow) event GETs; the drill-down's own
  // tail follows with ?follow=1 and must not count here.
  const decisionReads = (id: string): number =>
    daemon.requests.filter((r) => r.method === 'GET' && r.url.startsWith(`/jobs/${id}/events`) && !r.url.includes('follow=1')).length;
  assert.equal(decisionReads('job-b'), 1, "job-b's log was read once to render its card");

  // Answer the selected job (job-a, first blocked row) with its option id.
  cockpit.type('go\r');
  await shows(cockpit, 'answered job-a');

  // Let two full poll cycles land: the cache decides what gets refetched now.
  const pollsAtAnswer = daemon.requests.filter((r) => r.method === 'GET' && r.url.startsWith('/jobs') && !r.url.includes('/events')).length;
  await waitFor(cockpit, 'two more board polls', () =>
    daemon.requests.filter((r) => r.method === 'GET' && r.url.startsWith('/jobs') && !r.url.includes('/events')).length >= pollsAtAnswer + 2);

  // The answer invalidated job-a's cached decision only: job-b's whole event
  // log must not be re-read because a different job was answered.
  assert.equal(decisionReads('job-b'), 1, "answering job-a must not refetch job-b's log");
  assert.equal(await cockpit.quit(), 0);
});

test('cancelling from the cockpit asks first, and only y goes through', async (t) => {
  const cancels: string[] = [];
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { jobs: [{ id: 'job-run', state: 'running', workOrder: { finish: 'merge-ready', target: 'app' } }] }),
    'GET /jobs/job-run/events': (_req: MockRequest, res: ServerResponse) => sendNdjson(res, []),
    'POST /jobs/job-run/cancel': (req: MockRequest, res: ServerResponse) => {
      cancels.push(req.url);
      sendJson(res, 200, { ok: true });
    },
  });
  t.after(daemon.close);
  const cockpit = startCockpit({ cwd: makeTempDir('fleet-cockpit-'), env: { FLEET_DAEMON_URL: daemon.url } });
  t.after(() => cockpit.child.kill('SIGKILL'));
  await shows(cockpit, 'job-run');

  cockpit.type('cancel\r');
  await nowShows(cockpit, 'cancel job-run? [y/N]', 'the confirmation');
  cockpit.type('n');
  await noLongerShows(cockpit, '[y/N]');
  assert.deepEqual(cancels, [], 'declining cancels nothing');

  // Typed as one write, the way a paste or fast typing arrives: every character
  // after the first must still reach the input line rather than being eaten as
  // the answer to a prompt that is no longer up.
  cockpit.type('cancel job-run\r');
  await nowShows(cockpit, 'cancel job-run? [y/N]', 'the second confirmation');
  cockpit.type('y');
  await until(() => cancels.length === 1, `the cancel to reach the daemon\n${cockpit.frame()}`);
  await noLongerShows(cockpit, '[y/N]');
  assert.equal(await cockpit.quit(), 0);
});

test('the drill-down tails the selected job only; the board never tails anything', async (t) => {
  // These events exist only in the event stream, so nothing but a live follow
  // can put them on screen — and the only place a follow may render is the
  // drill-down the operator opened. A board that streams logs uninvited is the
  // firehose the first live run was rolled back for.
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, {
        jobs: [
          { id: 'job-alpha', state: 'running', workOrder: { finish: 'merge-ready', target: 'alpha' } },
          { id: 'job-beta', state: 'running', workOrder: { finish: 'inspected', target: 'beta' } },
        ],
      }),
    'GET /jobs/job-alpha/events': (_req: MockRequest, res: ServerResponse) =>
      sendNdjson(res, [{ job: 'job-alpha', seq: 0, type: 'think', text: 'alpha is reading the schema' }]),
    'GET /jobs/job-beta/events': (_req: MockRequest, res: ServerResponse) =>
      sendNdjson(res, [{ job: 'job-beta', seq: 0, type: 'think', text: 'beta is running the suite' }]),
  });
  t.after(daemon.close);

  const cockpit = startCockpit({ cwd: makeTempDir('fleet-cockpit-'), env: { FLEET_DAEMON_URL: daemon.url } });
  t.after(() => cockpit.child.kill('SIGKILL'));

  // The board renders both jobs and no events from either.
  await shows(cockpit, 'job-alpha', 'the board');
  await shows(cockpit, 'job-beta');
  assert.ok(!cockpit.frame().includes('alpha is reading'), 'no event lines on the board');
  assert.ok(!cockpit.frame().includes('beta is running'), 'from any job');

  // Enter opens the selected job: its events, nobody else's, roster gone.
  cockpit.type('\r');
  await nowShows(cockpit, 'job-alpha  running  merge-ready  alpha', 'the drill-down header');
  await nowShows(cockpit, '[0] alpha is reading the schema', "alpha's own events");
  assert.ok(!cockpit.frame().includes('JOB '), 'the roster is gone in the drill-down');
  assert.ok(!cockpit.frame().includes('beta is running'), "beta's events are not in alpha's tail");

  // Esc back, j to the second job, Enter: the follow moves with the selection,
  // and a follow that was replaced must not write into the new tail.
  cockpit.type('\x1b');
  await nowShows(cockpit, 'JOB ', 'the board again');
  cockpit.type('j');
  cockpit.type('\r');
  await nowShows(cockpit, '[0] beta is running the suite', "beta's own events");
  await noLongerShows(cockpit, 'alpha is reading');
  assert.equal(await cockpit.quit(), 0);
});

test('an unreachable daemon is a thing the cockpit shows, not a thing it dies of', async (t) => {
  const port = await closedPort();
  const cockpit = startCockpit({
    cwd: makeTempDir('fleet-cockpit-'),
    env: { FLEET_DAEMON_URL: `http://127.0.0.1:${port}` },
  });
  t.after(() => cockpit.child.kill('SIGKILL'));
  await nowShows(cockpit, `http://127.0.0.1:${port}`, 'the endpoint it cannot reach');
  await nowShows(cockpit, '○', 'the unreachable marker');
  assert.equal(await cockpit.quit(), 0, 'and it still leaves cleanly');
});

// ---------- the tunnel ----------

const DEPLOYMENT = {
  provider: 'ecs',
  cluster: 'fleet',
  daemon_service: 'fleet-daemon',
  daemon_container_name: 'fleet-daemon',
  daemon_port: 9000,
  runner_task_definition: 'fleet-runner',
  runner_container_name: 'fleet-runner',
};

test('a healthy tunnel is adopted, never owned: closing the cockpit leaves it up', async (t) => {
  // Somebody else's forward (here, a daemon already listening where daemon_url
  // points). The cockpit must use it, spawn nothing, and leave it running.
  const daemon = await startMockDaemon({
    'GET /health': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { ok: true }),
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }),
  });
  t.after(daemon.close);
  const port = Number(new URL(daemon.url).port);

  const cwd = projectWithConfig({ ...DEPLOYMENT, daemon_url: daemon.url });
  const state = path.join(makeTempDir('fleet-cockpit-aws-'), 'aws');
  const bin = fakeAwsBin(state);
  const home = makeTempDir('fleet-cockpit-home-');

  const cockpit = startCockpit({
    cwd,
    env: { FLEET_HOME: home, FAKE_AWS_DIR: state, PATH: `${bin}:${process.env.PATH}` },
  });
  t.after(() => cockpit.child.kill('SIGKILL'));

  await shows(cockpit, 'tunnel:adopted', 'the adopted tunnel');
  assert.ok(!fs.existsSync(path.join(state, 'sessions.log')), 'no forward was opened: nothing was needed');
  assert.equal(readTunnelRecord(home, port), undefined, 'an adopted tunnel is not ours to record');

  assert.equal(await cockpit.quit(), 0);
  assert.ok(await probeDaemonHealth('127.0.0.1', port), 'the tunnel we adopted outlives the cockpit');
});

test('with no tunnel there, the cockpit opens one and takes it down on the way out', async (t) => {
  // The acceptance case: no hand-run aws commands. The fake `aws` behaves like
  // the real one — a launcher whose grandchild binds the port and proxies it —
  // so /health goes through the forward, and an orphan would be visible.
  const daemon = await startMockDaemon({
    'GET /health': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { ok: true }),
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }),
  });
  t.after(daemon.close);
  const localPort = await closedPort();

  const cwd = projectWithConfig({ ...DEPLOYMENT, daemon_url: `http://127.0.0.1:${localPort}` });
  const state = path.join(makeTempDir('fleet-cockpit-aws-'), 'aws');
  const bin = fakeAwsBin(state);
  const home = makeTempDir('fleet-cockpit-home-');

  const cockpit = startCockpit({
    cwd,
    env: {
      FLEET_HOME: home,
      FAKE_AWS_DIR: state,
      FAKE_AWS_TARGET_PORT: new URL(daemon.url).port,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  t.after(() => cockpit.child.kill('SIGKILL'));

  await shows(cockpit, `tunnel:ours:${localPort}`, 'a tunnel of its own');
  const sessionsLog = path.join(state, 'sessions.log');
  await until(() => fs.existsSync(sessionsLog), 'a port-forward to be opened without anyone typing an aws command');
  const [, launcherPid, holderPid] = fs.readFileSync(sessionsLog, 'utf8').trim().split('\n')[0].split(' ').map(Number);
  t.after(() => {
    for (const pid of [launcherPid, holderPid]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already reaped — the good case
      }
    }
  });

  // The tunnel works and is on record, so doctor can explain a later failure.
  await until(() => readTunnelRecord(home, localPort) !== undefined, 'the tunnel record');
  assert.equal(readTunnelRecord(home, localPort)?.pid, cockpit.child.pid, 'the cockpit owns the session');
  assert.match(readTunnelRecord(home, localPort)?.endpointId ?? '', /^ecs:fleet_task-1_rt-1$/);
  // Reached through it: the board polled the daemon at the far end.
  await shows(cockpit, 'no jobs', 'the board, through the tunnel it opened');

  assert.equal(await cockpit.quit(), 0);
  assert.equal(readTunnelRecord(home, localPort), undefined, 'the record goes with it');
  // Both the launcher and the process actually holding the port must be gone:
  // an orphan keeps the port bound and makes the next attempt look like it worked.
  await until(() => !pidAlive(launcherPid), 'the forward launcher to be gone');
  await until(() => !pidAlive(holderPid), 'the process holding the forward to be gone');
  assert.equal(await portAccepts('127.0.0.1', localPort), false, 'the port is free again');
});

// ---------- a delegate that has to build its image (#121) ----------

/**
 * A `docker` on PATH whose `image inspect` always misses (the image is never
 * cached) and whose `build` records its own pid and argv, prints a line the way
 * a real build streams progress, then runs `buildScript`. The pid is what lets
 * a test prove the build was actually killed rather than orphaned.
 */
function fakeDockerBin(buildScript: string): { bin: string; log: string } {
  const bin = makeTempDir('fleet-fake-docker-');
  const log = path.join(bin, 'docker-calls.log');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh
case "$1" in
  build)
    echo "$$ $*" >> "${log}"
    echo "RAW_DOCKER_BUILD_OUTPUT step 1/3"
    ${buildScript}
    ;;
  image) exit 1 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  return { bin, log };
}

/** scaffold(), with harness.cli_version pinned so delegate takes the two-layer image path. */
function scaffoldColdImage(): string {
  const cwd = scaffold();
  const manifestPath = path.join(cwd, '.fleet', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.harness.cli_version = '9.9.9';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return cwd;
}

test('a cold-image delegate builds off the key queue: keys and polls keep working, a second dispatch is refused, and ^C kills the build', async (t) => {
  // The build sleeps far longer than any timeout here, so every assertion below
  // happens WHILE it runs. On the blocked-queue code (#121) the synchronous
  // build froze the whole event loop — no key, no poll, no repaint, no ^C —
  // and this test times out instead of passing.
  const docker = fakeDockerBin('exec sleep 120');
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }),
    'POST /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 201, { job: { id: 'job-new', state: 'queued' } }),
  });
  t.after(daemon.close);
  const cockpit = startCockpit({
    cwd: scaffoldColdImage(),
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${docker.bin}:${process.env.PATH}` },
  });
  t.after(() => cockpit.child.kill('SIGKILL'));
  await shows(cockpit, 'no jobs', 'the empty board');

  cockpit.type('delegate APP-123\r');
  await waitFor(cockpit, 'the docker build to start', () => fs.existsSync(docker.log));
  const buildPid = Number(fs.readFileSync(docker.log, 'utf8').trim().split(' ')[0]);
  t.after(() => {
    try {
      process.kill(buildPid, 'SIGKILL');
    } catch {
      // already dead — the good case
    }
  });

  // The loop is alive mid-build: a typed command is parsed, run, and painted.
  cockpit.type('help\r');
  await nowShows(cockpit, 'answer <id> [note]', 'the help line, typed mid-build');
  // And the background keeps breathing: the daemon poll continues.
  const pollsAtBuildStart = daemon.requests.filter((r) => r.method === 'GET' && r.url === '/jobs').length;
  await waitFor(cockpit, 'polling to continue during the build', () =>
    daemon.requests.filter((r) => r.method === 'GET' && r.url === '/jobs').length >= pollsAtBuildStart + 2);

  // A second delegate while one is building is refused with a reason — not
  // queued behind it, not a second build racing the first for the same tag.
  cockpit.type('delegate 99\r');
  await nowShows(cockpit, 'still dispatching APP-123', 'the refusal');
  assert.equal(
    fs.readFileSync(docker.log, 'utf8').trim().split('\n').length,
    1,
    'exactly one build, however many times delegate is typed',
  );

  // The cockpit owns the alternate screen: docker's own bytes never reach it.
  assert.ok(!cockpit.output().includes('RAW_DOCKER_BUILD_OUTPUT'), 'raw build output leaked to the terminal');
  // Build-before-POST still holds: no job exists while the image does not.
  assert.equal(daemon.requests.filter((r) => r.method === 'POST').length, 0, 'no job before the image is ready');

  // ^C mid-build leaves cleanly — and takes the build down with it, so an
  // abandoned dispatch is not minutes of orphaned docker.
  assert.equal(await cockpit.quit(), 0, '^C must work during a build');
  await until(() => !pidAlive(buildPid), 'the docker build to be killed with the view');
  assert.equal(daemon.requests.filter((r) => r.method === 'POST').length, 0, 'an aborted build creates no job');
});

test('a delegate whose build finishes posts the job with the tag it just built', async (t) => {
  const docker = fakeDockerBin('exit 0');
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }),
    'POST /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 201, { job: { id: 'job-new', state: 'queued' } }),
  });
  t.after(daemon.close);
  const cockpit = startCockpit({
    cwd: scaffoldColdImage(),
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${docker.bin}:${process.env.PATH}` },
  });
  t.after(() => cockpit.child.kill('SIGKILL'));
  await shows(cockpit, 'no jobs', 'the empty board');

  cockpit.type('delegate APP-123\r');
  await shows(cockpit, 'job-new queued — APP-123', 'the dispatched job');

  const posted = daemon.requests.filter((r) => r.method === 'POST' && r.url === '/jobs');
  assert.equal(posted.length, 1, 'exactly one dispatch');
  const body = JSON.parse(posted[0].body);
  assert.match(body.image, /^fleet-job:[0-9a-f]{16}$/, 'the computed tag rides the dispatch');
  assert.ok(
    fs.readFileSync(docker.log, 'utf8').includes(`-t ${body.image}`),
    'the daemon got exactly the tag the build produced',
  );
  // Even a successful build keeps its bytes off the cockpit screen.
  assert.ok(!cockpit.output().includes('RAW_DOCKER_BUILD_OUTPUT'), 'raw build output leaked to the terminal');
  assert.equal(await cockpit.quit(), 0);
});

// ---------- the command surface ----------

test('fleet board is gone: the cockpit is the live view', async () => {
  const res = await runCli(['board']);
  assert.equal(res.code, 2, 'board is not a command any more');
  assert.match(res.stderr, /unknown command: board/);
  assert.doesNotMatch(res.stdout + res.stderr, /^\s+board\b/m, 'and help does not advertise it');
});

test('without a terminal, bare fleet prints help instead of opening a view', async () => {
  const res = await runCli([]);
  assert.match(res.stdout, /Usage: fleet/, 'help, not a full-screen frame');
  assert.match(res.stdout, /the cockpit/, 'and it says what bare fleet does on a terminal');
  assert.doesNotMatch(res.stdout, /\x1b\[\?1049h/, 'nothing entered the alternate screen');
  assert.equal(res.code, 2, 'no command given is still a usage exit');
});
