// The pickup gate's readiness decision, fixture-tested (issue #1 acceptance).
// The pure `evaluate` core takes facts; the script wrapper owns gh/git I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Executable-but-importable: the gate's main() only runs when invoked as argv[1].
import { evaluate } from '../.fleet/gate.mjs';
import { validateManifest } from '../src/validate.mjs';

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

test('closed issue fails', () => {
  const { ready: ok, findings } = evaluate({ ...ready, state: 'CLOSED' });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /not open/);
});

test('multiple defects produce one finding each', () => {
  const { findings } = evaluate({ issue: '9', state: 'CLOSED', labels: [], body: '', branches: ['fleet/9-x'] });
  assert.equal(findings.length, 4);
});

test("this repo's own manifest validates", () => {
  const manifest = JSON.parse(readFileSync(new URL('../.fleet/manifest.json', import.meta.url), 'utf8'));
  const { ok, errors } = validateManifest(manifest);
  assert.ok(ok, JSON.stringify(errors, null, 2));
});
