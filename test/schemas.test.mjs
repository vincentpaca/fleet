import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateManifest,
  validateWorkOrder,
  manifestSchema,
  jobStates,
} from '../src/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('full example manifest validates', () => {
  const { ok, errors } = validateManifest(read('examples/full.manifest.json'));
  assert.ok(ok, JSON.stringify(errors, null, 2));
});


test('greenfield example manifest validates and is minimal', () => {
  const m = read('examples/greenfield.manifest.json');
  const { ok, errors } = validateManifest(m);
  assert.ok(ok, JSON.stringify(errors, null, 2));
  // Minimality: what `fleet init` scaffolds is exactly the schema's required
  // surface — removing any top-level key must invalidate the manifest.
  for (const key of Object.keys(m)) {
    const clone = structuredClone(m);
    delete clone[key];
    assert.equal(validateManifest(clone).ok, false, `"${key}" should be required`);
  }
});

test('manifest rejects missing pickup gate', () => {
  const m = read('examples/full.manifest.json');
  delete m.gates.pickup;
  assert.equal(validateManifest(m).ok, false, 'gateless dispatch must fail lint');
});

test('manifest rejects critic-less command', () => {
  const m = read('examples/full.manifest.json');
  delete m.harness.commands[0].critic;
  assert.equal(validateManifest(m).ok, false, 'a run with no critic is invalid');
});

test('manifest rejects devcontainer+image both set', () => {
  const m = read('examples/full.manifest.json');
  m.setup.image = 'node:22';
  assert.equal(validateManifest(m).ok, false, 'setup forms are mutually exclusive');
});

test('work order title: accepts non-empty string; rejects empty string', () => {
  const base = { mode: 'implement', target: 'APP-123', finish: 'merge-ready' };
  assert.equal(validateWorkOrder({ ...base, title: 'Fix the login bug' }).ok, true, 'non-empty title is valid');
  assert.equal(validateWorkOrder({ ...base, title: '' }).ok, false, 'empty string title must fail minLength: 1');
});

test('work order rejects merge/deploy grants (v1 hard limit)', () => {
  const base = { mode: 'implement', target: 'APP-123', finish: 'merge-ready' };
  assert.equal(validateWorkOrder({ ...base, authority: { merge: true } }).ok, false);
  assert.equal(validateWorkOrder({ ...base, authority: { deploy: true } }).ok, false);
  assert.equal(validateWorkOrder({ ...base, authority: { merge: false, deploy: false } }).ok, true);
});

test('work order rejects non-targetable finish rungs', () => {
  const base = { mode: 'implement', target: 'APP-123' };
  for (const rung of ['merged', 'deployed', 'runtime-accepted', 'mergeable']) {
    assert.equal(validateWorkOrder({ ...base, finish: rung }).ok, false, `${rung} must not be targetable in v1`);
  }
  assert.equal(validateWorkOrder({ ...base, finish: 'merge-ready' }).ok, true);
});

test('work order continues (#80): additive, mode-independent, both fields required', () => {
  const base = { target: '80', finish: 'merge-ready' };
  const c = { pr: 77, branch: 'fleet/77-job-abc' };
  assert.equal(validateWorkOrder(base).ok, true, 'orders without continues must stay valid — the field is additive');
  assert.equal(validateWorkOrder({ ...base, continues: c }).ok, true, 'continues needs no companion field');
  // #36 retired the followthrough-const rule: continues IS the adoption
  // declaration, so it must validate with any mode value or none. The guard
  // that rule provided (an adoption walking past the claim guard by accident)
  // is the pickup gate's now — test/gate.test.ts owns it.
  for (const mode of [undefined, 'followthrough', 'implement', 'assess']) {
    const order = mode === undefined ? { ...base, continues: c } : { ...base, mode, continues: c };
    assert.equal(validateWorkOrder(order).ok, true, `continues must validate with mode=${mode}`);
  }
  assert.equal(validateWorkOrder({ ...base, continues: { pr: 77 } }).ok, false, 'branch is required');
  assert.equal(validateWorkOrder({ ...base, continues: { branch: 'x' } }).ok, false, 'pr is required');
  assert.equal(validateWorkOrder({ ...base, continues: { pr: 0, branch: 'x' } }).ok, false, 'pr must be >= 1');
  assert.equal(validateWorkOrder({ ...base, continues: { pr: '77', branch: 'x' } }).ok, false, 'pr must be a number, not a string');
  assert.equal(validateWorkOrder({ ...base, continues: { pr: 77, branch: '' } }).ok, false, 'branch must be non-empty');
  assert.equal(validateWorkOrder({ ...base, continues: { ...c, extra: true } }).ok, false, 'unknown continues fields are rejected');
});

test('work order (#36): mode is optional, and the legacy fields are accepted and ignored', () => {
  // The optionality every later compatibility claim rests on. Without it a
  // window CLI that stops writing `mode` 422s at intake, and every claim about
  // the follow-up release is unfounded.
  assert.equal(validateWorkOrder({ target: '36', finish: 'inspected' }).ok, true, 'an order with NO mode must validate');
  assert.equal(
    validateWorkOrder({ target: '36', finish: 'inspected', authority: { publish: false, merge: false, deploy: false } }).ok,
    true,
    'publish alone is a complete authority block',
  );
  // A full pre-migration order: mode, report, every dead authority subfield,
  // and a followthrough carrying continues against an issue-number target —
  // exactly what a parked job re-enters with.
  const preMigration = {
    mode: 'followthrough',
    target: '80',
    title: 'Post-settle feedback re-entry',
    finish: 'merge-ready',
    report: 'status-first',
    authority: {
      edit: true, publish: true, jira: ['read', 'comment', 'transition'],
      merge: false, deploy: false, runtime_read: false,
    },
    continues: { pr: 77, branch: 'fleet/80-job-old' },
  };
  const { ok, errors } = validateWorkOrder(preMigration);
  assert.equal(ok, true, JSON.stringify(errors));
  // Deprecated does not mean unvalidated: a bad value in a legacy field is
  // still a bad order, so a producer cannot smuggle nonsense through one.
  assert.equal(validateWorkOrder({ ...preMigration, mode: 'conquer' }).ok, false, 'unknown mode value still rejected');
  assert.equal(validateWorkOrder({ ...preMigration, report: 'freeform' }).ok, false, 'unknown report value still rejected');
  assert.equal(validateWorkOrder({ ...preMigration, authority: { runtime_read: 'yes' } }).ok, false, 'runtime_read is still boolean');
});

test('wall_clock forbids zero in both schemas (#134): an instant death sentence is a typo', () => {
  const m = read('examples/full.manifest.json');
  m.limits.wall_clock = '0m';
  assert.equal(validateManifest(m).ok, false, 'manifest wall_clock "0m" must fail');
  m.limits.wall_clock = '0s';
  assert.equal(validateManifest(m).ok, false, 'manifest wall_clock "0s" must fail');
  m.limits.wall_clock = '90m';
  assert.equal(validateManifest(m).ok, true, 'a real budget still validates');

  const base = { mode: 'implement', target: 'APP-123', finish: 'implemented' };
  assert.equal(validateWorkOrder({ ...base, limits: { wall_clock: '0m' } }).ok, false, 'order wall_clock "0m" must fail');
  assert.equal(validateWorkOrder({ ...base, limits: { wall_clock: '1m' } }).ok, true, 'a real override still validates');
});

test('defaults have exactly one source of truth (#134, #36): no "default" annotations in the schema', () => {
  // Ajv is built without useDefaults, so a "default" annotation here is inert —
  // a second, false source of truth beside the code that resolves the value.
  // The descriptions name the defaults and where they live; the annotations must
  // stay deleted. gates.default_finish joined the list with #36, which made its
  // resolution shape- and rung-dependent (src/cli/dispatch.ts) — a flat
  // "merge-ready" in the schema was already wrong for every prose dispatch.
  const props = manifestSchema.properties.limits.properties;
  for (const key of ['wall_clock', 'idle', 'block_hot', 'decision_timeout']) {
    assert.equal('default' in props[key], false, `manifest limits.${key} must carry no inert "default" annotation`);
  }
  assert.equal(
    'default' in manifestSchema.properties.gates.properties.default_finish,
    false,
    'manifest gates.default_finish must carry no inert "default" annotation',
  );
});

test('job state machine transitions are closed over declared states', () => {
  const states = new Set(jobStates.states);
  for (const t of jobStates.transitions) {
    assert.ok(states.has(t.from), t.from);
    assert.ok(states.has(t.to), t.to);
  }
  for (const term of jobStates.terminal) {
    assert.ok(!jobStates.transitions.some((t) => t.from === term), `terminal state ${term} must have no outgoing transitions`);
  }
  for (const m of Object.values(jobStates.markers)) {
    assert.ok(states.has(m.on), 'markers attach to declared states');
  }
});
