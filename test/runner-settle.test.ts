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
      workPushed: true,
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
      workPushed: true,
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
      workPushed: true,
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
      workPushed: true,
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

test('a retained workspace rides out as a settle note carrying the path and the recovery command', () => {
  // #38: after a failed push the directory is the only address the work has.
  // The note is what the caller turns into a log event, so this is also what
  // puts the path in the persisted transcript.
  const workspace = makeWorkspace();
  try {
    const { body, notes } = composeSettle({
      jobId: 'job-s7',
      workPushed: true,
      startedAt: Date.now(),
      decisions: 0,
      workspace,
      retainedWorkspace: workspace,
    });
    assert.equal(notes.length, 1, `expected exactly the retention note, got: ${JSON.stringify(notes)}`);
    assert.match(notes[0], /retained/);
    assert.ok(notes[0].includes(workspace), 'the note must carry the retained path verbatim');
    assert.match(notes[0], /fleet resume-push job-s7/);
    // The settle event itself stays inside the schema — no new field.
    const { ok } = validateEvent({ job: 'job-s7', seq: 0, ...body });
    assert.ok(ok, 'settle with a retention note validates');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ── Empty-handed settle (issue #81) ──────────────────────────────────────────
// The delivery guarantee, made loud: no pushed work + no PR + zero artifacts
// means whatever the job concluded lives only in the transcript. The note must
// fire exactly then — and never when any deliverable exists, or every honest
// delivery would carry a false alarm.

test('empty-handed settle: note fires when nothing pushed, no PR, no artifacts', () => {
  const workspace = makeWorkspace();
  try {
    const { body, notes } = composeSettle({
      jobId: 'job-e1',
      startedAt: Date.now(),
      decisions: 0,
      workspace,
      workPushed: false,
    });
    assert.equal(notes.length, 1, `expected exactly the empty-handed note, got: ${JSON.stringify(notes)}`);
    assert.match(notes[0], /no deliverable landed/);
    assert.match(notes[0], /exists only in the transcript/);
    assert.match(notes[0], /fleet logs job-e1/, 'the note names the retrieval command for this job');
    const { ok } = validateEvent({ job: 'job-e1', seq: 0, ...body });
    assert.ok(ok, 'empty-handed settle still validates');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('empty-handed settle: the note also lands in the report not_done, schema-valid', () => {
  const workspace = makeWorkspace();
  try {
    writeFileSync(
      join(workspace, '.fleet', 'out', 'report.json'),
      JSON.stringify({ status: 'READY', next_action: 'read the transcript', not_done: ['docs'] }),
    );
    const { body, notes } = composeSettle({
      jobId: 'job-e2',
      startedAt: Date.now(),
      decisions: 0,
      workspace,
      workPushed: false,
    });
    assert.equal(notes.length, 1);
    const report = body.report as Record<string, unknown>;
    const notDone = report.not_done as string[];
    // Appended, never replacing what the harness already declared undone.
    assert.deepEqual(notDone.slice(0, 1), ['docs']);
    assert.match(notDone.at(-1) ?? '', /no deliverable landed/);
    const { ok } = validateEvent({ job: 'job-e2', seq: 0, ...body });
    assert.ok(ok, 'report with the appended note still validates');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('any deliverable silences the empty-handed note: artifacts, pushed work, or a PR', () => {
  const workspace = makeWorkspace();
  try {
    const base = { startedAt: Date.now(), decisions: 0, workspace };
    // One artifact delivered → not empty-handed.
    const withArtifact = composeSettle({
      jobId: 'job-e3', ...base, workPushed: false,
      produced: [{ id: 'answer.md', type: 'file', title: 'answer.md', path: 'answer.md', sha256: 'a'.repeat(64), bytes: 5 }],
    });
    assert.deepEqual(withArtifact.notes, [], 'an artifact is a deliverable');
    // Work commits on the branch → not empty-handed.
    const withPush = composeSettle({ jobId: 'job-e4', ...base, workPushed: true });
    assert.deepEqual(withPush.notes, [], 'pushed work is a deliverable');
    // A PR → not empty-handed.
    const withPr = composeSettle({
      jobId: 'job-e5', ...base, workPushed: false, rung: 'pr-open',
      prUrl: 'https://github.com/owner/repo/pull/9',
    });
    assert.deepEqual(withPr.notes, [], 'a PR is a deliverable');
    const r = withPr.body.report as Record<string, unknown>;
    assert.equal(r.not_done, undefined, 'no note smuggled into the PR report either');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('no retained workspace, no note', () => {
  const workspace = makeWorkspace();
  try {
    const { notes } = composeSettle({ jobId: 'job-s8', startedAt: Date.now(), decisions: 0, workspace, workPushed: true });
    assert.deepEqual(notes, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
