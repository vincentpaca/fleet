// The retained-workspace bookkeeping (#38): the runner's request file and the
// host-side registry that `fleet doctor` and `fleet resume-push` read. Every
// case here exists because getting it wrong deletes the only copy of a job's
// work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRetainedRecord,
  hasRetainRequest,
  listRetainedRecords,
  readRetainRequest,
  readRetainedRecord,
  retainRequestPath,
  writeRetainRequest,
  writeRetainedRecord,
} from '../src/shared/retained.ts';

const request = (jobId: string) => ({
  jobId,
  target: 'APP-123',
  branch: `fleet/APP-123-${jobId}`,
  base: 'main',
  ok: true,
  reason: 'fatal: could not read from remote repository',
  at: '2026-08-17T10:00:00.000Z',
});

test('the retain request round-trips through the out/ channel', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-retained-'));
  try {
    mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
    assert.equal(hasRetainRequest(workspace), false);
    writeRetainRequest(workspace, request('job-r1'));
    assert.equal(hasRetainRequest(workspace), true);
    assert.deepEqual(readRetainRequest(workspace), request('job-r1'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the retain request is written even when out/ has been removed', () => {
  // out/ is git-excluded and harness-owned: a harness that tidies it, or a
  // `git clean -xfd`, must not turn a failed push into a deleted workspace.
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-retained-'));
  try {
    writeRetainRequest(workspace, request('job-r2'));
    assert.ok(existsSync(retainRequestPath(workspace)), 'the request must exist regardless of out/');
    assert.equal(readRetainRequest(workspace)?.jobId, 'job-r2');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a torn request file still counts as a request, but parses to nothing', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-retained-'));
  try {
    mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
    writeFileSync(retainRequestPath(workspace), '{"jobId":"job-');
    assert.equal(hasRetainRequest(workspace), true, 'existence is the keep decision');
    assert.equal(readRetainRequest(workspace), undefined, 'and it is never half-believed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('records are listed oldest failure first, and dropped one job at a time', () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-retained-home-'));
  try {
    assert.deepEqual(listRetainedRecords(home), [], 'no registry directory = nothing retained');
    writeRetainedRecord(home, { ...request('job-r4'), at: '2026-08-17T12:00:00.000Z', workspace: '/tmp/ws-4' });
    writeRetainedRecord(home, { ...request('job-r3'), at: '2026-08-17T09:00:00.000Z', workspace: '/tmp/ws-3' });
    assert.deepEqual(listRetainedRecords(home).map((r) => r.jobId), ['job-r3', 'job-r4']);
    assert.equal(readRetainedRecord(home, 'job-r3')?.workspace, '/tmp/ws-3');

    clearRetainedRecord(home, 'job-r3');
    assert.equal(readRetainedRecord(home, 'job-r3'), undefined);
    assert.deepEqual(listRetainedRecords(home).map((r) => r.jobId), ['job-r4']);
    // Clearing an absent record is not an error — recovery must be re-runnable.
    clearRetainedRecord(home, 'job-r3');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a malformed or workspace-less record is skipped, never returned half-formed', () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-retained-home-'));
  try {
    mkdirSync(join(home, 'retained'), { recursive: true });
    writeFileSync(join(home, 'retained', 'job-bad-1.json'), 'not json');
    // A record without a workspace path cannot address anything.
    writeFileSync(join(home, 'retained', 'job-bad-2.json'), JSON.stringify(request('job-bad-2')));
    writeFileSync(join(home, 'retained', 'notes.txt'), 'ignored');
    writeRetainedRecord(home, { ...request('job-good'), workspace: '/tmp/ws-good' });

    assert.deepEqual(listRetainedRecords(home).map((r) => r.jobId), ['job-good']);
    assert.equal(readRetainedRecord(home, 'job-bad-1'), undefined);
    assert.equal(readRetainedRecord(home, 'job-bad-2'), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
