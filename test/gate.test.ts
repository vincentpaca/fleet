// The pickup gate's readiness decision, fixture-tested (issue #1 acceptance).
// The pure `evaluate` core takes facts; the script wrapper owns gh/git I/O.
// Shape-keying (#36, superseding #56's mode-keying) is tested on both halves:
// evaluate() per shape, and the script end to end in a temp workspace — the
// prose/issue/adoption fork lives in main(), so a unit test of evaluate() alone
// would not prove the dispatch path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// Executable-but-importable: the gate's main() only runs when invoked as argv[1].
import { dispatchShape, evaluate } from '../.fleet/gate.mjs';
// The CLI's own copy of the shape rule, pinned against the gate's below.
import { dispatchShape as cliDispatchShape } from '../src/cli/dispatch.ts';
import { validateManifest } from '../src/validate.mjs';

const gateScript = fileURLToPath(new URL('../.fleet/gate.mjs', import.meta.url));

/**
 * Run the real gate script against a throwaway workspace carrying `order`.
 * Ambient FLEET_* vars are stripped: this test process may itself be a fleet
 * job, and an inherited target would decide the assertion instead of the
 * fixture.
 */
function runGate(
  order: Record<string, unknown> | undefined,
  opts: { args?: string[]; env?: Record<string, string> } = {},
): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-gate-mode-'));
  mkdirSync(join(dir, '.fleet'), { recursive: true });
  if (order) writeFileSync(join(dir, '.fleet', 'order.json'), JSON.stringify(order));
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('FLEET_') && !(opts.env && key in opts.env)) delete env[key];
  }
  const result = spawnSync(process.execPath, [gateScript, ...(opts.args ?? [])], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const ready = {
  issue: '7',
  state: 'OPEN',
  labels: ['phase-1', 'ready'],
  body: '## Problem\nx\n\n## Acceptance\n- works\n',
  branches: [],
};

test('ready issue passes', () => {
  assert.deepStrictEqual(evaluate(ready), { ready: true, findings: [] });
});

test('missing ready label fails with a naming finding', () => {
  const { ready: ok, findings } = evaluate({ ...ready, labels: ['phase-1'] });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /"ready" label/);
});

test('missing Acceptance section fails', () => {
  const { ready: ok, findings } = evaluate({ ...ready, body: '## Problem\nonly prose' });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /## Acceptance/);
});

test('acceptance heading must be a heading, not inline text', () => {
  const { ready: ok } = evaluate({ ...ready, body: 'we discuss ## Acceptance inline' });
  assert.equal(ok, false);
});

test('claimed branch fails and names the branch', () => {
  const { ready: ok, findings } = evaluate({ ...ready, branches: ['fleet/7-do-thing', 'main'] });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /fleet\/7-do-thing/);
});

test('branch for a different issue does not block', () => {
  assert.equal(evaluate({ ...ready, branches: ['fleet/70-other', 'fleet/17-x'] }).ready, true);
});

test("the job's own branch never counts as a claim (creation-push and re-entry)", () => {
  const own = { ...ready, jobId: 'job-9', branches: ['fleet/7-job-9'] };
  assert.equal(evaluate(own).ready, true, 'own branch tripped the collision guard');
  const foreign = { ...own, branches: ['fleet/7-job-9', 'fleet/7-job-OTHER'] };
  const { ready: ok, findings } = evaluate(foreign);
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /fleet\/7-job-OTHER/);
  assert.ok(!findings.join('\n').includes('fleet/7-job-9,'), 'own branch must not be named a claimant');
});

test('a released -attemptN branch is not a claim; a live rival still blocks (#30)', () => {
  // fleet/7-job-1-attempt1 starts with the fleet/7- prefix, so before #30 it
  // read as a rival claim and blocked every re-dispatch after a failed attempt.
  const released = { ...ready, jobId: 'job-2', branches: ['fleet/7-job-1-attempt1', 'fleet/7-job-1-attempt2'] };
  assert.deepStrictEqual(evaluate(released), { ready: true, findings: [] });
  // The exemption is exactly the suffix: an unreleased rival next to a
  // released one still blocks, and the finding names only the rival.
  const mixed = { ...ready, jobId: 'job-2', branches: ['fleet/7-job-1-attempt1', 'fleet/7-job-3'] };
  const { ready: ok, findings } = evaluate(mixed);
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /fleet\/7-job-3/);
  assert.ok(!findings.join('\n').includes('attempt1'), 'the released branch must not be named a claimant');
});

test('closed issue fails', () => {
  const { ready: ok, findings } = evaluate({ ...ready, state: 'CLOSED' });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /not open/);
});

test('multiple defects produce one finding each', () => {
  const { findings } = evaluate({ issue: '9', state: 'CLOSED', labels: [], body: '', branches: ['fleet/9-x'] });
  assert.equal(findings.length, 4);
});

// --- Shape-keying (#36): the gate spends strictness on what the dispatch is. ---

test('dispatchShape: continues wins, then a numeric target, else prose', () => {
  // continues first, and not merely as a tie-break: a PR dispatch's target is
  // rewritten to its linked issue, so an adoption's target usually IS numeric.
  assert.equal(dispatchShape({ continues: { pr: 41, branch: 'b' }, target: '42' }), 'adoption');
  assert.equal(dispatchShape({ continues: { pr: 41, branch: 'b' }, target: 'pr/41' }), 'adoption');
  assert.equal(dispatchShape({ target: '42' }), 'issue');
  assert.equal(dispatchShape({ target: '#42' }), 'issue', 'a leading # is the same issue dispatch');
  assert.equal(dispatchShape({ target: 'why do queued jobs sit' }), 'prose');
  assert.equal(dispatchShape({ target: 'pr/41' }), 'prose', 'a PR reference without continues is not an adoption');
  assert.equal(dispatchShape({ target: '42x' }), 'prose');
  assert.equal(dispatchShape({}), 'prose', 'no target at all is not an issue dispatch');
});

test('the CLI and the gate classify a target identically', () => {
  // Two independent copies of the rule by design — a repo's gate must stand
  // alone and cannot import the CLI. This is the checkpoint that they agree: a
  // drift here would mean a dispatch whose defaults and whose strictness
  // disagree about what it is (the pre-#36 `#42` split, exactly — the gate
  // stripped the hash, the CLI did not, so `#42` was an issue to one side and
  // prose to the other).
  const targets = ['42', '#42', '0042', 'pr/41', '42x', 'why does the daemon wedge', 'APP-123', '#not a number', ''];
  for (const target of targets) {
    assert.equal(dispatchShape({ target }), cliDispatchShape(target, undefined), `disagreed on "${target}"`);
  }
  // Including the malformed `continues` values a staged order file can carry.
  // The two copies test it differently (`if (order.continues)` vs a parameter),
  // so these are exactly where a pin that only tried `undefined` and one good
  // object would miss a divergence.
  for (const continues of [{ pr: 1, branch: 'b' }, {}, null, false, 0, '']) {
    for (const target of targets) {
      assert.equal(
        dispatchShape({ target, continues }),
        cliDispatchShape(target, continues),
        `disagreed on target "${target}" with continues ${JSON.stringify(continues)}`,
      );
    }
  }
});

test('an issue dispatch keeps the full issue-readiness check', () => {
  const { ready: ok, findings } = evaluate({ ...ready, labels: [], body: 'prose' });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /"ready" label/);
  assert.match(findings.join('\n'), /## Acceptance/);
});

test('a prose dispatch passes with a note naming the target', () => {
  const verdict = evaluate({ issue: 'deep research on retry storms' });
  assert.deepStrictEqual(verdict.findings, []);
  assert.equal(verdict.ready, true);
  assert.match(verdict.note ?? '', /^prose dispatch/);
  assert.match(verdict.note ?? '', /deep research on retry storms/);
});

test('a numeric target is strict however read-only the intent — the recorded inversion (D17)', () => {
  // Pre-#36 this passed with a note under --mode assess. Strictness keys on
  // shape now: assessing an unready issue is phrased as prose, and the bug this
  // catches is a legacy mode field talking the gate out of the check.
  const hostile = {
    issue: '7', state: 'CLOSED', labels: [], body: '',
    branches: ['fleet/7-someone-else'],
  };
  assert.equal(evaluate(hostile).findings.length, 4, 'every readiness check must still fire');
  assert.equal(evaluate({ ...hostile, mode: 'assess' }).ready, false, 'a stale mode field must not relax the gate');
  assert.equal(evaluate({ ...hostile, mode: 'investigate' }).ready, false);
});

test('a prose dispatch ignores issue facts entirely, not merely tolerates them', () => {
  // Every readiness check would fail here; a prose target must still pass,
  // because none of these facts bear on a report-artifact deliverable.
  const verdict = evaluate({
    issue: 'why do queued jobs sit behind the capacity cap',
    state: 'CLOSED', labels: [], body: '', branches: ['fleet/7-someone-else'],
  });
  assert.equal(verdict.ready, true);
  assert.deepStrictEqual(verdict.findings, []);
});

test('an issue dispatch with absent facts fails closed instead of throwing', () => {
  // A spend gate that crashes reports nothing an operator can act on.
  const { ready: ok, findings } = evaluate({ issue: '7' });
  assert.equal(ok, false);
  assert.equal(findings.length, 2, findings.join('; '));
});

// --- Adoption (#80): the gate checks the PR, not the issue. ---

const adoption = {
  issue: '7',
  jobId: 'job-new',
  continues: { pr: 41, branch: 'fleet/7-job-old' },
  prState: 'OPEN',
  prHead: 'fleet/7-job-old',
  branches: ['fleet/7-job-old'],
};

test('an adoption checks the PR instead of issue readiness', () => {
  // Every issue-readiness fact is hostile (closed, unlabelled, no acceptance);
  // the continuation must pass anyway — the deliverable is the PR, and the
  // issue behind a delivered PR is routinely closed.
  const verdict = evaluate({ ...adoption, state: 'CLOSED', labels: [], body: '' });
  assert.deepStrictEqual(verdict.findings, []);
  assert.equal(verdict.ready, true);
});

test('an adoption fails closed on a non-open or unknown PR', () => {
  const merged = evaluate({ ...adoption, prState: 'MERGED' });
  assert.equal(merged.ready, false);
  assert.match(merged.findings.join('\n'), /PR #41 is MERGED, not open/);
  // Absent PR facts (gh unreachable, PR deleted) must fail, never pass silently.
  const unknown = evaluate({ ...adoption, prState: undefined, prHead: undefined });
  assert.equal(unknown.ready, false);
  assert.match(unknown.findings.join('\n'), /unknown/);
});

test('an adoption fails when the PR head is not the adopted branch', () => {
  // The bug this catches: the operator continues PR A while the order names
  // branch B — the job would push A's fixes onto the wrong branch.
  const { ready: ok, findings } = evaluate({ ...adoption, prHead: 'fleet/7-job-other' });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /head is fleet\/7-job-other, not the adopted branch fleet\/7-job-old/);
});

test('the adopted branch is excluded from the claim guard; a rival branch still blocks', () => {
  assert.equal(evaluate(adoption).ready, true, 'adopted branch tripped the collision guard');
  const rival = evaluate({ ...adoption, branches: ['fleet/7-job-old', 'fleet/7-job-rival'] });
  assert.equal(rival.ready, false);
  assert.match(rival.findings.join('\n'), /fleet\/7-job-rival/);
  assert.ok(!rival.findings.join('\n').includes('fleet/7-job-old,'), 'the adopted branch must not be named a claimant');
});

test('a rival dispatch on the same issue is still blocked by the adopted branch', () => {
  // Adoption is declared, never inferred: only an order carrying continues may
  // walk past the claim. A plain issue dispatch never adopts — and a legacy
  // mode field saying "followthrough" does not make it one.
  const { ready: ok, findings } = evaluate({ ...ready, branches: ['fleet/7-job-old'] });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /fleet\/7-job-old/);
  assert.equal(
    evaluate({ ...ready, mode: 'followthrough', branches: ['fleet/7-job-old'] }).ready,
    false,
    'a stale mode field must not grant adoption',
  );
});

/** A bin dir whose `gh` prints the given JSON; prepended to PATH for script runs. */
function fakeGhBin(stdout: string, exitCode = 0): string {
  const bin = mkdtempSync(join(tmpdir(), 'fleet-fake-gh-'));
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return bin;
}

test('script: an adoption gates on the PR via gh, no issue lookup', () => {
  const bin = fakeGhBin('{"state":"OPEN","headRefName":"fleet/7-job-old"}');
  const order = {
    // No mode field at all: `continues` is the adoption declaration since #36.
    target: 'pr/41', // non-numeric target: a PR-only continuation must not demand an issue number
    continues: { pr: 41, branch: 'fleet/7-job-old' },
  };
  const { status, out } = runGate(order, { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(status, 0, out);
  assert.match(out, /PR #41 is open on fleet\/7-job-old/);
});

test('script: an adoption exits 1 when the PR has closed since dispatch', () => {
  const bin = fakeGhBin('{"state":"CLOSED","headRefName":"fleet/7-job-old"}');
  const order = { target: 'pr/41', continues: { pr: 41, branch: 'fleet/7-job-old' } };
  const { status, out } = runGate(order, { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(status, 1, out);
  assert.match(out, /PR #41 is CLOSED, not open/);
});

test('script: an adoption exits 2 when gh cannot answer', () => {
  const bin = fakeGhBin('', 1);
  const order = { target: 'pr/41', continues: { pr: 41, branch: 'fleet/7-job-old' } };
  const { status, out } = runGate(order, { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(status, 2, out);
  assert.match(out, /cannot evaluate PR #41/);
});

test('script: a bare prose dispatch passes with no gh or network', () => {
  // No mode, no flags — the shape #36 exists to make dispatchable.
  const { status, out } = runGate({ target: 'deep research on stall backstops', finish: 'inspected' });
  assert.equal(status, 0, out);
  assert.match(out, /prose dispatch/);
  assert.match(out, /deep research on stall backstops/);
});

test('script: a legacy implement-mode prose order passes too — shape decides, not mode', () => {
  // The pre-migration order this repo's own gate used to kill. A parked job
  // re-entering with an old order must not die on a field nothing reads.
  const { status, out } = runGate({ mode: 'implement', target: 'deep research on stall backstops' });
  assert.equal(status, 0, out);
  assert.match(out, /prose dispatch/);
});

test('script: a missing target still exits 2, whatever the shape would have been', () => {
  const { status, out } = runGate({ finish: 'inspected' });
  assert.equal(status, 2, out);
  assert.match(out, /no target/);
});

test('script: $FLEET_TARGET overrides the staged order for a hand-run gate', () => {
  // Nothing in Fleet sets it; it exists so an operator can run the gate by hand
  // against a checkout whose order.json belongs to an earlier dispatch.
  const order = { mode: 'implement', target: '42', finish: 'merge-ready' };
  const { status, out } = runGate(order, { env: { FLEET_TARGET: 'why does the daemon wedge' } });
  assert.equal(status, 0, out);
  assert.match(out, /prose dispatch — no issue readiness to check for target "why does the daemon wedge"/);
});

test('script: no order file at all reads the shape off the argv target', () => {
  const { status, out } = runGate(undefined, { args: ['open-ended question'] });
  assert.equal(status, 0, out);
  assert.match(out, /prose dispatch/);
  // ... and an issue-shaped argv target still pays the check, so a missing
  // order file is not a way to walk past readiness.
  const numeric = runGate(undefined, { args: ['999999999'] });
  assert.notEqual(numeric.status, 0, numeric.out);
});

test("this repo's own manifest validates", () => {
  const manifest = JSON.parse(readFileSync(new URL('../.fleet/manifest.json', import.meta.url), 'utf8'));
  const { ok, errors } = validateManifest(manifest);
  assert.ok(ok, JSON.stringify(errors, null, 2));
});
