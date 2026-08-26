import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, validateDecisionFile } from '../src/validate.mjs';

const options = (recommendedCount) => [
  { id: 'a', label: 'Option A', ...(recommendedCount >= 1 ? { recommended: true } : {}) },
  { id: 'b', label: 'Option B', ...(recommendedCount >= 2 ? { recommended: true } : {}) },
];

const decisionEvent = (opts) => ({
  job: 'j1', seq: 3, type: 'decision', id: 'd1',
  question: 'Ship behind a flag?', options: opts,
});

test('decision requires exactly one recommended option (schema-enforced)', () => {
  assert.equal(validateEvent(decisionEvent(options(1))).ok, true);
  assert.equal(validateEvent(decisionEvent(options(0))).ok, false, 'zero recommended must fail');
  assert.equal(validateEvent(decisionEvent(options(2))).ok, false, 'two recommended must fail');
  assert.equal(validateEvent(decisionEvent([options(1)[0]])).ok, false, 'a single option is an acknowledgement, not a decision');
});

test('decision file: what a harness command writes to .fleet/out/decision.json', () => {
  const file = {
    question: 'No design link on this UI ticket — which source of truth?',
    options: [
      { id: 'ask-design', label: 'Request a design link', recommended: true },
      { id: 'go-spec', label: 'Build from the spec wireframe section' },
    ],
    who: 'dev-sprint',
    note: 'A policy call, not a data question — the fleet cannot infer it.',
  };
  const { ok, errors } = validateDecisionFile(file);
  assert.ok(ok, JSON.stringify(errors, null, 2));
  assert.equal(validateDecisionFile({ ...file, options: [file.options[1], { id: 'x', label: 'X' }] }).ok, false, 'file with no recommendation must fail');
  assert.equal(validateDecisionFile({ ...file, job: 'j1' }).ok, false, 'runner-owned fields must not appear in the file');
});

test('settle accepts a status-first report and rejects malformed ones', () => {
  const settle = {
    job: 'j1', seq: 9, type: 'settle',
    rung: 'merge-ready', minutes: 42,
    outcome: { produced: [], findings: 0, decisions: 1 },
    report: {
      status: 'READY',
      target_rung: 'merge-ready',
      pr: 'org/repo#12',
      verification: ['focused tests', 'hosted CI green at head'],
      next_action: 'merge the PR',
    },
  };
  assert.equal(validateEvent(settle).ok, true, JSON.stringify(validateEvent(settle).errors));
  assert.equal(validateEvent({ ...settle, report: { ...settle.report, status: 'DONE-ISH' } }).ok, false, 'status vocabulary is closed');
  const { next_action, ...rest } = settle.report;
  assert.equal(validateEvent({ ...settle, report: rest }).ok, false, 'a report without one exact next action is not a report');
});
