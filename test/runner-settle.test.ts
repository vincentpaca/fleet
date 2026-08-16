import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSettle } from '../src/runner/settle.ts';
// @ts-ignore -- plain-JS module, no type declarations
import { validateEvent } from '../src/validate.mjs';

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-settle-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  return workspace;
}

test('minimal settle without report.json', () => {
  const workspace = makeWorkspace();
  try {
    const { body, notes } = composeSettle({
      jobId: 'job-s1',
      startedAt: Date.now() - 90_000, // 1.5 minutes ago
      decisions: 2,
      workspace,
      rung: 'implemented',
    });
    assert.deepEqual(notes, []);
    assert.equal(body.type, 'settle');
    assert.equal(body.rung, 'implemented');
    assert.equal(body.report, undefined);
    assert.deepEqual(body.outcome, { produced: [], findings: 0, decisions: 2 });
    const minutes = body.minutes;
    assert.ok(typeof minutes === 'number' && minutes >= 1.4 && minutes <= 1.7);

    const { ok } = validateEvent({ job: 'job-s1', seq: 0, ...body });
    assert.ok(ok, 'settle body validates as an event');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('valid report.json is included in the settle', () => {
  const workspace = makeWorkspace();
  try {
    const report = {
      status: 'READY',
      next_action: 'open the pull request',
      implemented: ['feature toggle'],
      verification: ['unit tests pass'],
    };
    writeFileSync(join(workspace, '.fleet', 'out', 'report.json'), JSON.stringify(report));
    const { body, notes } = composeSettle({
      jobId: 'job-s2',
      startedAt: Date.now(),
      decisions: 0,
      workspace,
      rung: 'implemented',
    });
    assert.deepEqual(notes, []);
    assert.deepEqual(body.report, report);
    const { ok } = validateEvent({ job: 'job-s2', seq: 0, ...body });
    assert.ok(ok);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('schema-invalid report.json is omitted with a note, settle stays valid', () => {
  const workspace = makeWorkspace();
  try {
    // "status" outside the enum and next_action missing → invalid report block.
    writeFileSync(
      join(workspace, '.fleet', 'out', 'report.json'),
      JSON.stringify({ status: 'AMAZING', notes: 'all good' }),
    );
    const { body, notes } = composeSettle({
      jobId: 'job-s3',
      startedAt: Date.now(),
      decisions: 1,
      workspace,
    });
    assert.equal(body.report, undefined);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /report omitted/);
    const { ok } = validateEvent({ job: 'job-s3', seq: 0, ...body });
    assert.ok(ok, 'settle without the bad report still validates');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('unparseable report.json is omitted with a note', () => {
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, '.fleet', 'out', 'report.json'), '{nope');
    const { body, notes } = composeSettle({
      jobId: 'job-s4',
      startedAt: Date.now(),
      decisions: 0,
      workspace,
    });
    assert.equal(body.report, undefined);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /not valid JSON/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('prUrl is merged into an existing report and validated', () => {
  const workspace = makeWorkspace();
  try {
    const report = {
      status: 'READY',
      next_action: 'review the pull request',
      verification: ['tests pass'],
    };
    writeFileSync(join(workspace, '.fleet', 'out', 'report.json'), JSON.stringify(report));
    const { body, notes } = composeSettle({
      jobId: 'job-s5',
      startedAt: Date.now(),
      decisions: 0,
      workspace,
      rung: 'pr-open',
      prUrl: 'https://github.com/owner/repo/pull/42',
    });
    assert.deepEqual(notes, []);
    assert.equal(body.rung, 'pr-open');
    const r = body.report as Record<string, unknown>;
    assert.ok(r, 'report present');
    assert.equal(r.pr, 'https://github.com/owner/repo/pull/42');
    assert.equal(r.status, 'READY');
    const { ok } = validateEvent({ job: 'job-s5', seq: 0, ...body });
    assert.ok(ok, 'settle with pr URL validates');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('prUrl creates a minimal report when no report.json exists', () => {
  const workspace = makeWorkspace();
  try {
    const { body, notes } = composeSettle({
      jobId: 'job-s6',
      startedAt: Date.now(),
      decisions: 0,
      workspace,
      rung: 'pr-open',
      prUrl: 'https://github.com/owner/repo/pull/7',
    });
    assert.deepEqual(notes, []);
    const r = body.report as Record<string, unknown>;
    assert.ok(r, 'report present even without report.json');
    assert.equal(r.pr, 'https://github.com/owner/repo/pull/7');
    assert.equal(r.status, 'READY');
    const { ok } = validateEvent({ job: 'job-s6', seq: 0, ...body });
    assert.ok(ok, 'minimal pr report validates');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
