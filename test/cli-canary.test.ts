// `fleet canary` (#220): dispatch one live no-op job and turn its terminal
// state into an exit code. Everything here drives runCanary directly with
// scripted deps — the dispatch path itself is cli-delegate's to test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCanary, type CanaryOptions } from '../src/cli/canary.ts';

const JOB_ID = 'job-c1';
const BRANCH = `fleet/Canary-prove-this-deployment-${JOB_ID}`;

type JobView = { state: string; settle?: { rung?: string; report?: { status?: string; next_action?: string } } };

const DONE_READY: JobView = {
  state: 'done',
  settle: { rung: 'inspected', report: { status: 'READY', next_action: 'canary complete' } },
};

function eventsBody(branch: string | null = BRANCH): string {
  const lines = [
    JSON.stringify({ type: 'state', state: 'running' }),
    JSON.stringify({ type: 'log', text: 'runner image built at abc1234def5' }),
  ];
  if (branch !== null) lines.push(JSON.stringify({ type: 'log', text: `workspace on branch ${branch} (pushed)` }));
  return lines.join('\n') + '\n';
}

/**
 * Scripted deps: each GET /jobs/:id consumes the next state (the last one
 * repeats); a cancel POST reroutes every later GET to `afterCancel`. All
 * requests, log lines and deletions are recorded for the assertions.
 */
function makeOpts(config: {
  states: JobView[];
  afterCancel?: JobView;
  events?: string;
  deleteBranch?: boolean;
  deleteOk?: boolean;
  jobStatus?: number;
  /** The first N job GETs answer 404 before the scripted states begin. */
  flakyGets?: number;
  deadlineMs?: number;
}): { opts: CanaryOptions; requests: string[]; lines: string[]; deleted: string[]; targets: string[] } {
  const requests: string[] = [];
  const lines: string[] = [];
  const deleted: string[] = [];
  const targets: string[] = [];
  let index = 0;
  let flaky = config.flakyGets ?? 0;
  let cancelled = false;
  const opts: CanaryOptions = {
    delegate: async (req) => {
      targets.push(req.target);
      return { jobId: JOB_ID, state: 'queued' };
    },
    call: async (method, reqPath) => {
      requests.push(`${method} ${reqPath}`);
      if (method === 'POST' && reqPath.endsWith('/cancel')) {
        cancelled = true;
        return { status: 200, body: '', json: {} };
      }
      if (reqPath.endsWith('/events')) return { status: 200, body: config.events ?? eventsBody(), json: undefined };
      if (flaky > 0) {
        flaky -= 1;
        return { status: 404, body: '', json: undefined };
      }
      if (config.jobStatus !== undefined) return { status: config.jobStatus, body: '', json: undefined };
      const job = cancelled && config.afterCancel !== undefined
        ? config.afterCancel
        : config.states[Math.min(index++, config.states.length - 1)];
      return { status: 200, body: '', json: { job } };
    },
    deleteRemoteBranch: (branch) => {
      deleted.push(branch);
      return config.deleteOk !== false;
    },
    deleteBranch: config.deleteBranch === true,
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    pollMs: 1,
    ...(config.deadlineMs !== undefined ? { deadlineMs: config.deadlineMs } : {}),
    sleep: () => Promise.resolve(),
  };
  return { opts, requests, lines, deleted, targets };
}

test('a done job with a READY report passes: exit 0, evidence printed, branch kept by default', async () => {
  const { opts, lines, deleted, targets } = makeOpts({ states: [{ state: 'running' }, DONE_READY] });
  assert.equal(await runCanary(opts), 0);
  // The dispatched prompt is the contract: read-only, no decisions, READY report.
  assert.match(targets[0], /Change no files and ask no decisions/);
  assert.match(targets[0], /status READY/);
  assert.ok(lines.some((l) => l.includes('runner image built at abc1234def5')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('canary: PASS')), lines.join('\n'));
  // Evidence convention: kept, with the removal command named — never auto-deleted.
  assert.deepEqual(deleted, []);
  assert.ok(lines.some((l) => l.includes(`git push origin --delete ${BRANCH}`)), lines.join('\n'));
});

test('--delete-branch removes the claim branch, but only after a pass', async () => {
  const pass = makeOpts({ states: [DONE_READY], deleteBranch: true });
  assert.equal(await runCanary(pass.opts), 0);
  assert.deepEqual(pass.deleted, [BRANCH]);

  const fail = makeOpts({
    states: [{ state: 'cancelled', settle: { report: { status: 'BLOCKED', next_action: 'fix workspace git: …' } } }],
    deleteBranch: true,
  });
  assert.equal(await runCanary(fail.opts), 1);
  assert.deepEqual(fail.deleted, [], 'a failed canary’s branch is the post-mortem evidence');
});

test('--delete-branch refuses any branch that is not exactly this job’s claim', async () => {
  // job-c10 contains job-c1 as a substring — a containment check would delete it.
  for (const foreign of ['fleet/someone-elses-work-job-zz9', `${BRANCH}0`]) {
    const { opts, deleted, lines } = makeOpts({
      states: [DONE_READY],
      deleteBranch: true,
      events: eventsBody(foreign),
    });
    assert.equal(await runCanary(opts), 0);
    assert.deepEqual(deleted, [], `only the canary’s own claim branch is deletable (${foreign})`);
    assert.ok(lines.some((l) => l.includes('not deleting')), lines.join('\n'));
  }
});

test('a failure verdict outranks a settle that lands done during the cancel grace window', async () => {
  // The cancel/settle race (#114): the canary blocked, we cancelled it, an
  // answer from another surface let it settle done+READY anyway. The tool
  // already declared this run a failure — it must not flip to PASS, and it
  // must not delete the branch.
  const { opts, deleted, lines } = makeOpts({
    states: [{ state: 'blocked' }],
    afterCancel: DONE_READY,
    deleteBranch: true,
  });
  assert.equal(await runCanary(opts), 1);
  assert.deepEqual(deleted, []);
  assert.ok(lines.some((l) => l.startsWith('canary: FAIL') && l.includes('asked for a decision')), lines.join('\n'));
});

test('a cancel the daemon never lands ends after the grace bound, with exactly one cancel', async () => {
  // The anti-hang mechanism itself: the job sits blocked forever even after
  // the cancel. The watch must end (bounded polls), cancel exactly once, and
  // report failure — not follow a wedged daemon indefinitely.
  const { opts, requests } = makeOpts({
    states: [{ state: 'blocked' }],
    afterCancel: { state: 'blocked' },
  });
  assert.equal(await runCanary(opts), 1);
  assert.equal(requests.filter((r) => r.endsWith('/cancel')).length, 1, requests.join('\n'));
  assert.ok(requests.length < 50, `watch did not stay bounded: ${requests.length} requests`);
});

test('transient job-GET failures are tolerated, not treated as a dead daemon', async () => {
  const { opts } = makeOpts({ states: [DONE_READY], flakyGets: 2 });
  assert.equal(await runCanary(opts), 0, 'two blips must not fail a healthy canary');
});

test('a blocked canary is cancelled and fails: it was told not to ask', async () => {
  const { opts, requests, lines } = makeOpts({
    states: [{ state: 'blocked' }],
    afterCancel: { state: 'cancelled', settle: { report: { status: 'PARTIAL', next_action: 'job cancelled' } } },
    deleteBranch: true,
  });
  assert.equal(await runCanary(opts), 1);
  assert.ok(requests.includes(`POST /jobs/${JOB_ID}/cancel`), requests.join('\n'));
  assert.ok(lines.some((l) => l.includes('asked for a decision')), lines.join('\n'));
});

test('a canary past its deadline is cancelled and fails, never followed forever', async () => {
  const { opts, requests } = makeOpts({
    states: [{ state: 'running' }],
    afterCancel: { state: 'cancelled', settle: { report: { status: 'PARTIAL', next_action: 'job cancelled' } } },
    deadlineMs: 0,
  });
  assert.equal(await runCanary(opts), 1);
  assert.ok(requests.includes(`POST /jobs/${JOB_ID}/cancel`), requests.join('\n'));
});

test('done without a READY report is a failure — the daemon state alone is not the proof', async () => {
  const { opts, lines } = makeOpts({
    states: [{ state: 'done', settle: { rung: 'inspected', report: { status: 'PARTIAL', next_action: 'ran out of budget' } } }],
  });
  assert.equal(await runCanary(opts), 1);
  assert.ok(lines.some((l) => l.startsWith('canary: FAIL')), lines.join('\n'));
});

test('a daemon that stops answering fails the canary instead of throwing', async () => {
  const { opts, lines } = makeOpts({ states: [], jobStatus: 404 });
  assert.equal(await runCanary(opts), 1);
  assert.ok(lines.some((l) => l.includes('unreachable')), lines.join('\n'));
});

test('a git-less job passes on its settle but says the git path went unproven', async () => {
  const { opts, lines } = makeOpts({ states: [DONE_READY], events: eventsBody(null) });
  assert.equal(await runCanary(opts), 0);
  assert.ok(lines.some((l) => l.includes('git path goes unproven')), lines.join('\n'));
});
