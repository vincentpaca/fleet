import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { targetableRungs, validateWorkOrder } from '../src/validate.mjs';
import { runCli, makeTempDir, startMockDaemon, sendJson, type MockRequest } from './cli-helpers.ts';
import { toHttpsGitUrl } from '../src/shared/giturl.ts';

const MANIFEST = {
  version: 1,
  setup: { image: 'node:22', script: '.fleet/setup.sh' },
  workspace: {
    repo: 'git@github.com:acme/example-app.git',
    strategy: 'branch-per-job',
    sync: ['.env.fleet'],
  },
  env: { vars: ['ACME_API_TOKEN'] },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'node .fleet/check-ready.js', default_finish: 'merge-ready' },
};

function scaffold(manifest: unknown = MANIFEST): string {
  const cwd = makeTempDir('fleet-cli-delegate-');
  fs.mkdirSync(path.join(cwd, '.fleet'));
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(cwd, '.env.fleet'), 'ACME_SETTING=example.com\n');
  return cwd;
}

function jobsRoute() {
  return {
    'POST /jobs': (_req: MockRequest, res: ServerResponse) => {
      sendJson(res, 201, { job: { id: 'job-1', state: 'queued' } });
    },
  };
}
/** Dispatch and return the posted work order, asserting the CLI succeeded. */
async function postedOrder(
  args: string[],
  cwd: string,
  daemon: { url: string; requests: MockRequest[] },
  env: Record<string, string | undefined> = {},
): Promise<Record<string, unknown>> {
  const res = await runCli(['delegate', ...args], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', ...env },
  });
  assert.equal(res.code, 0, res.stderr);
  const order = JSON.parse(daemon.requests[daemon.requests.length - 1].body).workOrder;
  const { ok, errors } = validateWorkOrder(order);
  assert.equal(ok, true, JSON.stringify(errors));
  return order;
}

test('delegate builds a valid work order from the target shape and posts it', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /job-1 queued/);

  assert.equal(daemon.requests.length, 1);
  const body = JSON.parse(daemon.requests[0].body);

  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(body.workOrder.target, 'APP-123');
  // APP-123 is not an issue number, so this is a prose dispatch: read-only,
  // inspected, no PR. It is also the case the manifest's default_finish loses,
  // because a prose dispatch's rung is not a repo-configurable default.
  assert.equal(body.workOrder.finish, 'inspected');
  assert.equal(body.workOrder.authority.publish, false);
  assert.equal(body.workOrder.authority.merge, false, 'merge never grantable');
  assert.equal(body.workOrder.authority.deploy, false, 'deploy never grantable');

  assert.deepEqual(body.manifest, MANIFEST, 'manifest travels with the dispatch');
  assert.equal(body.env.ACME_API_TOKEN, 'token-value', 'env value read from the dispatching shell');
  assert.equal(
    Buffer.from(body.sync['.env.fleet'], 'base64').toString('utf8'),
    'ACME_SETTING=example.com\n',
    'sync file content shipped base64-encoded',
  );
});

// --- Shape-keyed defaults (#36) ---

test('delegate: an issue dispatch publishes and aims at merge-ready; prose does neither', async (t) => {
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');

  const issue = await postedOrder(['42'], cwd, daemon, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(issue.finish, 'merge-ready');
  // The authority block is `publish` plus D5's two const-false limits, and
  // nothing else: the deprecated subfields have no reader and are not written
  // even in the migration window (test/gate-window-compat.test.ts proves the
  // pre-window schema accepts an order without them).
  assert.deepEqual(issue.authority, { publish: true, merge: false, deploy: false });

  const prose = await postedOrder(['why do queued jobs sit behind the capacity cap'], cwd, daemon);
  assert.equal(prose.finish, 'inspected');
  assert.equal((prose.authority as { publish: boolean }).publish, false, 'prose opens no PR by default');
});

test('delegate: #42 and 42 are the same issue dispatch — normalized at parse', async (t) => {
  // The bug this catches: the CLI and the pickup gate disagreeing about `#42`
  // (the gate stripped the hash, the CLI did not), which since #36 would mean a
  // dispatch whose authority and whose strictness disagree about what it is.
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');

  const order = await postedOrder(['#42'], cwd, daemon, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(order.target, '42', 'the hash is stripped — branch naming and the claim guard read this');
  assert.equal(order.finish, 'merge-ready', 'and it gets the issue row, not the prose row');
  assert.equal(order.title, 'Fix the flaky heartbeat', 'the title lookup sees an issue number too');
});

test('delegate: --publish is gone — refused like any unknown flag (#208)', async (t) => {
  // Prose delivery is prompt-owned: the flag restated what the prompt already
  // says, so it no longer exists. The bug this catches: the flag surviving as
  // an accepted no-op, which would silently dispatch a job the operator
  // believes carries publish authority.
  const cwd = scaffold({ ...MIN_MANIFEST, gates: { pickup: 'true' } });
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', '--publish', 'draft the retry-policy note and open a PR'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url },
  });
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stderr, /usage error/, 'the unknown-flag convention, not a custom refusal');
  assert.match(res.stderr, /--publish/, 'the refusal names the flag');
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate: manifest.gates.default_finish beats the shape default and loses to --finish', async (t) => {
  // The revived knob: presets/*.finish shadowed it into dead code before #36.
  const cwd = scaffold({ ...MIN_MANIFEST, gates: { pickup: 'true', default_finish: 'ci-green' } });
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');
  const env = { PATH: `${bin}:${process.env.PATH}` };

  assert.equal((await postedOrder(['42'], cwd, daemon, env)).finish, 'ci-green', 'manifest beats the shape default');
  assert.equal(
    (await postedOrder(['42', '--finish', 'pushed'], cwd, daemon, env)).finish,
    'pushed',
    '--finish beats the manifest',
  );
  // A mapped --mode is still a per-dispatch request, so it outranks repo config.
  assert.equal((await postedOrder(['42', '--mode', 'assess'], cwd, daemon, env)).finish, 'inspected');
});

test('delegate: a repo default_finish applies only where the dispatch could reach it (D17)', async (t) => {
  // The test is the RUNG, not the shape and not the publish bit: `pr-open` and
  // above need push authority, everything below is reachable without it,
  // because the runner pushes the job branch whenever the workspace has a git
  // URL and gates only PR creation on the bit. Two bugs this catches: a prose
  // dispatch inheriting a delivery rung it cannot reach (so every run reports
  // short of its own target), and the over-correction that throws away a
  // perfectly reachable repo default just because the dispatch is prose.
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const withDefault = (rung: string): string =>
    scaffold({ ...MIN_MANIFEST, gates: { pickup: 'true', default_finish: rung } });

  const unreachable = withDefault('ci-green');
  const prose = await postedOrder(['some open question'], unreachable, daemon);
  assert.equal(prose.finish, 'inspected', 'the shape default stands when the repo default needs publishing');
  assert.equal((prose.authority as { publish: boolean }).publish, false);
  // Grant publish (the one prose route left is the deprecated --mode, #208)
  // and the repo's delivery rung applies again — one rule, not a prose-shaped
  // exception.
  assert.equal((await postedOrder(['--mode', 'implement', 'some open question'], unreachable, daemon)).finish, 'ci-green');
  // An explicit --finish is never second-guessed, publish or not: naming a rung
  // is a decision, not a default.
  assert.equal((await postedOrder(['--finish', 'ci-green', 'some open question'], unreachable, daemon)).finish, 'ci-green');

  // Every rung the ladder offers, split at the real boundary rather than at a
  // hand-copied list: the schema owns the ladder, `pr-open` is where push
  // authority starts, and a rung added anywhere in that range must land on the
  // right side of this without anyone remembering to update a set. Iterating
  // the schema's own enum is what makes that true — a hardcoded list here would
  // drift in lockstep with a hardcoded list in the implementation.
  const floor = targetableRungs.indexOf('pr-open');
  assert.ok(floor > 0, 'the ladder must still have a pr-open rung with rungs below it');
  for (const [i, rung] of targetableRungs.entries()) {
    const cwd = withDefault(rung);
    const expected = i < floor ? rung : 'inspected';
    assert.equal(
      (await postedOrder(['some open question'], cwd, daemon)).finish,
      expected,
      i < floor ? `${rung} is reachable without publish` : `${rung} needs publish, so the shape default must stand`,
    );
  }
});

test('delegate: the window release writes a compat mode computed from shape', async (t) => {
  // Operator repos carry their own gate copies, and every pre-#36 copy reads a
  // missing mode as implement (strict). Drop this field and every prose
  // dispatch dies against every un-updated repo gate.
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');

  assert.equal((await postedOrder(['some open question'], cwd, daemon)).mode, 'investigate');
  assert.equal((await postedOrder(['42'], cwd, daemon, { PATH: `${bin}:${process.env.PATH}` })).mode, 'implement');
  // A mapped --mode must NOT soften it: this is what keeps `--mode assess 42`
  // gating strict on an old gate as well as a new one (D17's inversion).
  const mapped = await postedOrder(['--mode', 'assess', '42'], cwd, daemon, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(mapped.mode, 'implement', 'the compat mode is keyed on shape, never on the flag');
});

// --- The operator's prompt (#240): instruction beside identity ---

test('delegate: an un-prompted dispatch writes no prompt at all', async (t) => {
  // The compatibility claim the whole field rests on. A deployed daemon
  // validates orders against the schema baked into its own image, so a `prompt`
  // written unconditionally — even the shape's own default — would 422 every
  // dispatch until the deployment caught up. The assertion is the WHOLE order,
  // not a `'prompt' in order` check: a defaulted prompt and any other field
  // this release started writing both fail here, which is what "the same order
  // the release before it posted" actually means. (Key ORDER is not asserted —
  // deepEqual ignores it, and JSON object order is not part of the contract.)
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');

  const issue = await postedOrder(['42'], cwd, daemon, { PATH: `${bin}:${process.env.PATH}` });
  assert.deepEqual(issue, {
    mode: 'implement',
    target: '42',
    finish: 'merge-ready',
    authority: { publish: true, merge: false, deploy: false },
    title: 'Fix the flaky heartbeat',
  });
  const prose = await postedOrder(['why do queued jobs sit behind the capacity cap'], cwd, daemon);
  assert.deepEqual(prose, {
    mode: 'investigate',
    target: 'why do queued jobs sit behind the capacity cap',
    finish: 'inspected',
    authority: { publish: false, merge: false, deploy: false },
  });
});

test('delegate --prompt: what the operator typed reaches the order verbatim', async (t) => {
  // What the field exists for: before it, the operator's own workflow could
  // only arrive as an argument to Fleet's. This covers the dispatch leg only —
  // that the runner then launches the harness with these same bytes is pinned
  // separately in test/runner-harness.test.ts. The characters are chosen:
  // backticks around an identifier and a `$` are idiomatic in a prompt, and
  // both survive JSON round-trips that a naive shell-quoting fix would eat.
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');
  const prompt = '/dev-work #42 — keep `parseVersion` reading $HOME, and say "why" in the body';

  const order = await postedOrder(['42', '--prompt', prompt], cwd, daemon, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(order.prompt, prompt, 'byte-for-byte, nothing prepended and nothing escaped');
  assert.equal(order.target, '42', 'and the target is still the identity every consumer reads');
});

test('delegate --prompt: the shape still comes from the target alone (D17)', async (t) => {
  // The inversion this field could have introduced, and the reason the prompt
  // is never parsed for an issue reference. Two bugs it catches: a prompt
  // naming an issue promoting a prose dispatch to issue strictness and publish
  // authority, and — the direction that costs a readiness check — a prompt on
  // an issue target demoting it to prose because the CLI decided the operator
  // asking for something specific means the number is no longer the job.
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');

  const onIssue = await postedOrder(['42', '--prompt', '/dev-work #42'], cwd, daemon, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(onIssue.target, '42', 'the branch, the claim guard and Closes #n all read this');
  assert.equal(onIssue.finish, 'merge-ready');
  assert.deepEqual(onIssue.authority, { publish: true, merge: false, deploy: false });
  assert.equal(onIssue.mode, 'implement', 'so an un-regenerated repo gate still runs the readiness check');

  const onProse = await postedOrder(['compare the two retry approaches', '--prompt', '/dev-work #42'], cwd, daemon);
  assert.equal(onProse.target, 'compare the two retry approaches', 'never derived back out of the prompt');
  assert.equal(onProse.finish, 'inspected');
  assert.equal((onProse.authority as { publish: boolean }).publish, false, 'a prompt grants no authority');
  assert.equal(onProse.mode, 'investigate');
});

test('delegate --prompt: an empty prompt is refused by the schema, before any POST', async (t) => {
  // `--prompt ""` is a typo, not a request to run with no instruction, and the
  // schema is where that is decided (minLength 1) rather than in a hand-rolled
  // check beside it.
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'some open question', '--prompt', ''], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url },
  });
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /prompt/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

// --- The deprecated --mode flag, for the life of the window ---

test('delegate --mode: read-only names ask for read-only and inspected, and it warns', async (t) => {
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');
  const env = { FLEET_DAEMON_URL: daemon.url, PATH: `${bin}:${process.env.PATH}` };

  const res = await runCli(['delegate', '42', '--mode', 'assess'], { cwd, env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /--mode is deprecated \(#36\)/, 'the flag announces its own removal');
  const order = JSON.parse(daemon.requests[0].body).workOrder;
  assert.equal(order.authority.publish, false, 'assess is a read-only request');
  assert.equal(order.finish, 'inspected');
});

test('delegate --mode implement/followthrough grant publish and no more, on any shape', async (t) => {
  // The window's back-compat promise: an invocation that published before #36
  // still publishes. The bug this catches is the tempting reading — "map every
  // name onto the dispatch's own row" — under which `--mode implement` on a
  // prose target silently withdraws the authority it was typed to grant.
  const cwd = scaffold({ ...MIN_MANIFEST, gates: { pickup: 'true', default_finish: 'ci-green' } });
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');
  const env = { PATH: `${bin}:${process.env.PATH}` };

  const prose = await postedOrder(['--mode', 'implement', 'refactor the retry backoff'], cwd, daemon);
  assert.equal((prose.authority as { publish: boolean }).publish, true, 'implement still means publish');

  // ... and no more: the flag has no opinion on the rung, so the repo's
  // default_finish decides and `--mode implement 42` is a bare `42`. Asserted
  // against ci-green, which is neither the shape default nor the old preset's
  // merge-ready — so this cannot pass by coincidence.
  assert.equal(prose.finish, 'ci-green');
  const issue = await postedOrder(['42', '--mode', 'implement'], cwd, daemon, env);
  assert.equal(issue.finish, 'ci-green');
  assert.deepEqual(
    await postedOrder(['42'], cwd, daemon, env),
    issue,
    '--mode implement must produce the same order as no flag at all',
  );
});

test('delegate: the specific --finish flag beats the mapped --mode bundle', async (t) => {
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');
  const env = { PATH: `${bin}:${process.env.PATH}` };

  const order = await postedOrder(['42', '--mode', 'assess', '--finish', 'merge-ready'], cwd, daemon, env);
  assert.equal(order.finish, 'merge-ready', '--finish beats the mapped bundle');
  assert.equal((order.authority as { publish: boolean }).publish, false, 'and only --finish moved');
});

test('delegate fails loudly on a missing env var, before any POST', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: undefined },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /missing env var: ACME_API_TOKEN/);
  assert.match(res.stderr, /\.fleet\/\.env/, 'error names the file as a fallback source');
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate: a missing auth credential teaches the seat path; other vars stay generic (#205)', async (t) => {
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  // Both auth vars carry the acquisition story, pre-POST.
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const cwd = scaffold({ ...MANIFEST, env: { vars: [name] } });
    const res = await runCli(['delegate', 'APP-123'], {
      cwd,
      env: { FLEET_DAEMON_URL: daemon.url, [name]: undefined },
    });
    assert.equal(res.code, 1);
    assert.match(res.stderr, new RegExp(`missing env var: ${name}`));
    assert.match(res.stderr, /claude setup-token/, `${name}: the refusal names the acquisition command`);
    assert.match(res.stderr, /fleet setup repo/, `${name}: and the interview that writes it`);
  }

  // A var Fleet has no acquisition story for keeps the plain refusal.
  const cwd = scaffold();
  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: undefined },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /missing env var: ACME_API_TOKEN/);
  assert.doesNotMatch(res.stderr, /setup-token/, 'no invented auth story for an ordinary var');
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate: var present only in .fleet/.env is injected into the job', async (t) => {
  const cwd = scaffold();
  // Write .fleet/.env with the var; remove it from the shell env.
  fs.writeFileSync(path.join(cwd, '.fleet', '.env'), 'ACME_API_TOKEN=from-dotenv\n');
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: undefined },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.env.ACME_API_TOKEN, 'from-dotenv', 'dotenv value injected when shell var absent');
});

test('delegate: shell env wins over .fleet/.env when var is in both', async (t) => {
  const cwd = scaffold();
  fs.writeFileSync(path.join(cwd, '.fleet', '.env'), 'ACME_API_TOKEN=from-dotenv\n');
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'from-shell' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.env.ACME_API_TOKEN, 'from-shell', 'shell value takes precedence over .fleet/.env');
});

test('delegate fails loudly on a missing sync file, before any POST', async (t) => {
  const cwd = scaffold();
  fs.rmSync(path.join(cwd, '.env.fleet'));
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /missing sync file: \.env\.fleet/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate rejects an unknown mode and an invalid manifest locally', async () => {
  const cwd = scaffold();
  const badMode = await runCli(['delegate', 'APP-123', '--mode', 'conquer'], {
    cwd,
    env: { ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(badMode.code, 1);
  assert.match(badMode.stderr, /unknown mode "conquer"/);
  assert.match(badMode.stderr, /implement/, 'lists available modes');

  const badCwd = scaffold({ version: 1 });
  const badManifest = await runCli(['delegate', 'APP-123'], { cwd: badCwd });
  assert.equal(badManifest.code, 1);
  assert.match(badManifest.stderr, /must have required property/);
});

test('delegate surfaces daemon 422 errors readably', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'POST /jobs': (req, res) => {
      sendJson(res, 422, { errors: [{ instancePath: '/workOrder/finish', message: 'is not targetable' }] });
    },
  });
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /\/workOrder\/finish is not targetable/);
});

test('delegate requires a target argument (usage error)', async () => {
  const cwd = scaffold();
  const res = await runCli(['delegate'], { cwd });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage error/);
});

test('delegate: non-numeric target (APP-123) never sets workOrder.title', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.title, undefined, 'non-numeric target must never set title');
});

// Minimal manifest with no env vars or sync, so the gh-title tests are
// self-contained; gh itself is faked on PATH so both branches are forced,
// not left to whatever the machine's real gh returns.
const MIN_MANIFEST = {
  version: 1,
  setup: { image: 'node:22' },
  workspace: { repo: 'git@github.com:acme/example-app.git', strategy: 'branch-per-job' },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'node .fleet/check-ready.js', default_finish: 'merge-ready' },
};

function fakeGh(script: string): string {
  const bin = makeTempDir('fleet-fake-gh-');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

test('delegate: numeric target stamps workOrder.title from gh', async (t) => {
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');

  const res = await runCli(['delegate', '42'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.target, '42', 'target preserved');
  assert.equal(body.workOrder.title, 'Fix the flaky heartbeat', 'title stamped from gh');
  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.ok(ok, `work order with numeric target must validate: ${JSON.stringify(errors)}`);
});

test('delegate: a gh failure degrades to no title, never an empty one', async (t) => {
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('exit 1');

  const res = await runCli(['delegate', '42'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.title, undefined, 'failed gh lookup must leave title absent');
  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.ok(ok, `work order without title must validate: ${JSON.stringify(errors)}`);
});

test('delegate rewrites an ssh github remote to https when the job ships a GitHub token', async (t) => {
  const cwd = scaffold({ ...MANIFEST, env: { vars: ['ACME_API_TOKEN', 'GH_TOKEN'] } });
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', GH_TOKEN: 'gh-token' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(
    body.env.FLEET_GIT_URL,
    'https://github.com/acme/example-app.git',
    'ssh remote becomes https — containers hold no SSH keys, only the token',
  );
});

test('delegate keeps the ssh remote verbatim when no GitHub token ships', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(
    body.env.FLEET_GIT_URL,
    'git@github.com:acme/example-app.git',
    'without a token the URL is untouched — ssh-agent still covers the process provider',
  );
});

// --- Typed PR target (#80): delegate pr/<n> continues an existing PR ---

/** A bin dir whose `gh` prints the given JSON (recording its args); prepended to PATH. */
function fakeGhBin(stdout: string, exitCode = 0): { bin: string; calls: () => string[] } {
  const bin = makeTempDir('fleet-fake-gh-');
  const log = path.join(bin, 'gh-calls.log');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\necho "$@" >> "${log}"\ncat <<'EOF'\n${stdout}\nEOF\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return {
    bin,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

const OPEN_PR = JSON.stringify({
  number: 41,
  state: 'OPEN',
  headRefName: 'fleet/9-job-old',
  title: 'Fix the widget pipeline',
  closingIssuesReferences: [{ number: 9 }],
});

test('delegate pr/<n> implies followthrough, resolves the head branch, and ships continues', async (t) => {
  const cwd = scaffold();
  const gh = fakeGhBin(OPEN_PR);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'pr/41'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', PATH: `${gh.bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.mode, 'followthrough', 'a PR target implies followthrough');
  assert.deepEqual(body.workOrder.continues, { pr: 41, branch: 'fleet/9-job-old' });
  assert.equal(body.workOrder.target, '9', 'the linked issue becomes the target — board lineage');
  assert.equal(body.workOrder.title, 'Fix the widget pipeline');
  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.ok(ok, JSON.stringify(errors));
  assert.match(gh.calls()[0], /^pr view 41 --json /, 'resolved via gh pr view at dispatch');
});

test('delegate accepts a full GitHub PR URL and falls back to a pr/<n> target without a linked issue', async (t) => {
  const cwd = scaffold();
  const gh = fakeGhBin(JSON.stringify({
    number: 41, state: 'OPEN', headRefName: 'fleet/9-job-old', title: 'Fix the widget pipeline',
    closingIssuesReferences: [],
  }));
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'https://github.com/acme/example-app/pull/41'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', PATH: `${gh.bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.deepEqual(body.workOrder.continues, { pr: 41, branch: 'fleet/9-job-old' });
  assert.equal(body.workOrder.target, 'pr/41', 'no single linked issue — the PR reference is the target');
  assert.match(gh.calls()[0], /^pr view https:\/\/github\.com\/acme\/example-app\/pull\/41 /, 'URLs pass to gh verbatim — they name the repo');
});

test('delegate refuses a non-open PR before any POST', async (t) => {
  // The bug this catches: resolving (or failing) only after the daemon has a
  // job record — a container would burn on a branch nobody can update a PR from.
  const cwd = scaffold();
  const gh = fakeGhBin(JSON.stringify({ number: 41, state: 'MERGED', headRefName: 'fleet/9-job-old', title: 'x', closingIssuesReferences: [] }));
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'pr/41'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', PATH: `${gh.bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /PR #41 is MERGED, not open/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

// headRefName is chosen by whoever opened the PR and flows into the harness
// prompt and the runner's git argv. The second of these is a name git itself
// accepts as a ref — the vet is a whitelist for exactly that reason.
const HOSTILE_HEADS = ['--upload-pack=touch /tmp/pwned', 'fix/$(id)'];

for (const headRefName of HOSTILE_HEADS) {
  test(`delegate refuses PR head branch ${headRefName}, naming it, before any POST`, async (t) => {
    const cwd = scaffold();
    const gh = fakeGhBin(JSON.stringify({
      number: 41, state: 'OPEN', headRefName, title: 'x',
      closingIssuesReferences: [{ number: 9 }],
    }));
    const daemon = await startMockDaemon(jobsRoute());
    t.after(daemon.close);

    const res = await runCli(['delegate', 'pr/41'], {
      cwd,
      env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', PATH: `${gh.bin}:${process.env.PATH}` },
    });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /refusing head branch/);
    assert.ok(res.stderr.includes(headRefName), 'the refusal names the value it rejected');
    assert.equal(daemon.requests.length, 0, 'nothing posted');
  });
}

test('delegate refuses a gh resolution failure before any POST', async (t) => {
  const cwd = scaffold();
  const gh = fakeGhBin('', 1);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'pr/404'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', PATH: `${gh.bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /cannot resolve PR target pr\/404/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate rejects a PR target with a conflicting --mode', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'pr/41', '--mode', 'implement'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /implies --mode followthrough/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

// --- Two-layer image on the delegate path (#121): async build, streamed to this stdout ---

test('delegate with cli_version builds the job image, streams docker output to stdout, and ships the tag', async (t) => {
  const cwd = scaffold({ ...MIN_MANIFEST, harness: { ...MIN_MANIFEST.harness, cli_version: '9.9.9' } });
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  // A docker whose inspect always misses and whose build streams a line, the
  // way a real build narrates its layers.
  const bin = makeTempDir('fleet-fake-docker-');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    '#!/bin/sh\ncase "$1" in\n  build) echo "FAKE_BUILD_PROGRESS step 1/3" ;;\n  image) exit 1 ;;\nesac\nexit 0\n',
    { mode: 0o755 },
  );

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /building job image fleet-job:/);
  // The plain CLI owns its stdout: build progress streams through, the same
  // visibility stdio:'inherit' used to give — without blocking the event loop.
  assert.match(res.stdout, /FAKE_BUILD_PROGRESS step 1\/3/);
  const body = JSON.parse(daemon.requests[0].body);
  assert.match(body.image, /^fleet-job:[0-9a-f]{16}$/, 'the built tag rides the dispatch');
});

test('delegate fails loudly when the build fails, carrying the build tail, before any POST', async (t) => {
  const cwd = scaffold({ ...MIN_MANIFEST, harness: { ...MIN_MANIFEST.harness, cli_version: '9.9.9' } });
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = makeTempDir('fleet-fake-docker-');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    '#!/bin/sh\ncase "$1" in\n  build) echo "no space left on device" >&2; exit 17 ;;\n  image) exit 1 ;;\nesac\nexit 0\n',
    { mode: 0o755 },
  );

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /docker build exited 17/);
  assert.match(res.stderr, /no space left on device/, 'the failure carries the build tail');
  assert.equal(daemon.requests.length, 0, 'a failed build posts nothing — build-before-POST');
});

test('toHttpsGitUrl: github ssh forms rewrite, everything else passes through', () => {
  assert.equal(toHttpsGitUrl('git@github.com:acme/example-app.git'), 'https://github.com/acme/example-app.git');
  assert.equal(toHttpsGitUrl('ssh://git@github.com/acme/example-app.git'), 'https://github.com/acme/example-app.git');
  assert.equal(toHttpsGitUrl('https://github.com/acme/example-app.git'), 'https://github.com/acme/example-app.git');
  assert.equal(toHttpsGitUrl('git@git.example.com:acme/tools.git'), 'git@git.example.com:acme/tools.git', 'non-github hosts untouched — no credential can serve them yet');
  assert.equal(toHttpsGitUrl('/tmp/local/bare.git'), '/tmp/local/bare.git', 'local paths untouched');
});
