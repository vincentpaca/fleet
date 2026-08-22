// The pickup gate's readiness decision, fixture-tested (issue #1 acceptance).
// The pure `evaluate` core takes facts; the script wrapper owns gh/git I/O.
// Mode-awareness (#56) is tested on both halves: evaluate() per mode, and the
// script end to end in a temp workspace — the strict/report-only fork lives in
// main(), so a unit test of evaluate() alone would not prove the dispatch path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// Executable-but-importable: the gate's main() only runs when invoked as argv[1].
import { evaluate, REPORT_ONLY_MODES } from '../.fleet/gate.mjs';
import { validateManifest } from '../src/validate.mjs';

const gateScript = fileURLToPath(new URL('../.fleet/gate.mjs', import.meta.url));

/**
 * Run the real gate script against a throwaway workspace carrying `order`.
 * Ambient FLEET_* vars are stripped: this test process may itself be a fleet
 * job, and an inherited target/mode would decide the assertion instead of the
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

test('closed issue fails', () => {
  const { ready: ok, findings } = evaluate({ ...ready, state: 'CLOSED' });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /not open/);
});

test('multiple defects produce one finding each', () => {
  const { findings } = evaluate({ issue: '9', state: 'CLOSED', labels: [], body: '', branches: ['fleet/9-x'] });
  assert.equal(findings.length, 4);
});

// --- Mode-awareness (#56): the gate spends strictness where authority is. ---

test('implement mode keeps the full issue-readiness check', () => {
  const { ready: ok, findings } = evaluate({ ...ready, mode: 'implement', labels: [], body: 'prose' });
  assert.equal(ok, false);
  assert.match(findings.join('\n'), /"ready" label/);
  assert.match(findings.join('\n'), /## Acceptance/);
});

test('followthrough mode is strict too — it also carries edit authority', () => {
  assert.equal(evaluate({ ...ready, mode: 'followthrough', labels: [] }).ready, false);
});

test('report-only modes pass with a note naming the mode and target', () => {
  for (const mode of ['assess', 'investigate', 'review', 'compare']) {
    const verdict = evaluate({ mode, issue: 'deep research on retry storms' });
    assert.deepStrictEqual(verdict.findings, [], `${mode} produced findings`);
    assert.equal(verdict.ready, true, `${mode} did not pass`);
    assert.match(verdict.note ?? '', new RegExp(`^${mode} mode is report-only`));
    assert.match(verdict.note ?? '', /deep research on retry storms/);
  }
});

test('report-only modes ignore issue facts entirely, not merely tolerate them', () => {
  // Every strict check fails here; investigate must still pass, because none of
  // these facts bear on a report-artifact deliverable.
  const hostile = {
    mode: 'investigate',
    issue: '7',
    state: 'CLOSED',
    labels: [],
    body: '',
    branches: ['fleet/7-someone-else'],
  };
  assert.equal(evaluate({ ...hostile, mode: 'implement' }).findings.length, 4, 'fixture must fail every strict check');
  const verdict = evaluate(hostile);
  assert.equal(verdict.ready, true);
  assert.deepStrictEqual(verdict.findings, []);
});

test('absent or unrecognized mode falls back to strict — never relax on a guess', () => {
  const broken = { ...ready, labels: [] };
  assert.equal(evaluate(broken).ready, false, 'no mode should mean strict');
  assert.equal(evaluate({ ...broken, mode: 'INVESTIGATE' }).ready, false, 'case variant is not a known mode');
  assert.equal(evaluate({ ...broken, mode: 'explore' }).ready, false, 'unknown mode should mean strict');
});

test('strict mode with absent facts fails closed instead of throwing', () => {
  // A spend gate that crashes reports nothing an operator can act on.
  const { ready: ok, findings } = evaluate({ mode: 'implement', issue: '7' });
  assert.equal(ok, false);
  assert.equal(findings.length, 2, findings.join('; '));
});

test('the exempt modes are exactly the presets granting neither edit nor publish', () => {
  // The gate's exemption list restates a fact owned by presets/modes.json. This
  // is the checkpoint: a preset that gains edit authority while staying exempt
  // would otherwise skip the readiness check silently.
  const presets = JSON.parse(
    readFileSync(new URL('../presets/modes.json', import.meta.url), 'utf8'),
  ) as { modes: Record<string, { authority: { edit: boolean; publish: boolean } }> };
  const readOnly = Object.entries(presets.modes)
    .filter(([, preset]) => !preset.authority.edit && !preset.authority.publish)
    .map(([name]) => name);
  assert.deepStrictEqual([...REPORT_ONLY_MODES].sort(), readOnly.sort());
});

test('script: investigate mode passes on a prose target with no gh or network', () => {
  const { status, out } = runGate({ mode: 'investigate', target: 'deep research on stall backstops' });
  assert.equal(status, 0, out);
  assert.match(out, /report-only/);
  assert.match(out, /deep research on stall backstops/);
});

test('script: implement mode dies on a prose target with the issue-readiness message', () => {
  const { status, out } = runGate({ mode: 'implement', target: 'deep research on stall backstops' });
  assert.equal(status, 2, out);
  assert.match(out, /implement mode requires a ready GitHub issue/);
});

test('script: a missing target still exits 2 in a report-only mode', () => {
  const { status, out } = runGate({ mode: 'investigate' });
  assert.equal(status, 2, out);
  assert.match(out, /no target/);
});

test('script: $FLEET_MODE overrides the staged order for a hand-run gate', () => {
  const order = { mode: 'implement', target: 'why does the daemon wedge' };
  const { status, out } = runGate(order, { env: { FLEET_MODE: 'assess' } });
  assert.equal(status, 0, out);
  assert.match(out, /assess mode is report-only/);
});

test('script: no order file at all is treated as implement — strict by default', () => {
  const { status, out } = runGate(undefined, { args: ['open-ended question'] });
  assert.equal(status, 2, out);
  assert.match(out, /implement mode requires a ready GitHub issue/);
});

test("this repo's own manifest validates", () => {
  const manifest = JSON.parse(readFileSync(new URL('../.fleet/manifest.json', import.meta.url), 'utf8'));
  const { ok, errors } = validateManifest(manifest);
  assert.ok(ok, JSON.stringify(errors, null, 2));
});
