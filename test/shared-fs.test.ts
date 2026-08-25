// createIfAbsent replaces `if (!existsSync(p)) writeFileSync(p, ...)` across the
// scaffolding paths. Two things are worth pinning: the return value, because
// callers report "wrote" against "kept existing" from it, and the atomicity,
// because that is the whole reason the helper exists and it is invisible from a
// single process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIfAbsent } from '../src/shared/fs.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-fs-'));
}

test('createIfAbsent creates, and reports that it created', () => {
  const target = join(tempDir(), 'new.txt');
  assert.equal(createIfAbsent(target, 'fresh'), true);
  assert.equal(readFileSync(target, 'utf8'), 'fresh');
});

test('createIfAbsent leaves an existing file untouched, byte for byte', () => {
  const target = join(tempDir(), 'existing.txt');
  writeFileSync(target, 'the operator wrote this');
  assert.equal(createIfAbsent(target, 'clobbered'), false);
  assert.equal(readFileSync(target, 'utf8'), 'the operator wrote this');
});

test('createIfAbsent applies mode on create', () => {
  const target = join(tempDir(), 'script.sh');
  createIfAbsent(target, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(statSync(target).mode & 0o777, 0o755);
});

test('createIfAbsent surfaces errors that are not EEXIST', () => {
  // A path under a file rather than a directory: ENOTDIR, not EEXIST. Swallowing
  // every error would turn a broken target into a silent no-op.
  const base = join(tempDir(), 'a-file');
  writeFileSync(base, '');
  assert.throws(() => createIfAbsent(join(base, 'child.txt'), 'x'), /ENOTDIR|ENOENT/);
});

// The discriminating test, and the attack the scanner was describing.
//
// A dangling symlink at the target path is "absent" as far as existsSync is
// concerned — it reports on the link's target, which does not exist. So
// check-then-write proceeds, writeFileSync follows the link, and the bytes land
// wherever the link points, which can be anywhere the process can write.
//
// `wx` is O_CREAT|O_EXCL, and POSIX has open fail on a symlink in that mode
// regardless of whether the target exists. No timing, no probability: run this
// against a check-then-write implementation and it fails every time.
test('createIfAbsent refuses to write through a dangling symlink', () => {
  const dir = tempDir();
  const outside = join(dir, 'somewhere-else');
  const target = join(dir, 'setup.sh');
  symlinkSync(outside, target);

  assert.equal(createIfAbsent(target, 'payload'), false);
  assert.equal(existsSync(outside), false, 'wrote through the symlink to outside the target path');
});
