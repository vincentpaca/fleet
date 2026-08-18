import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, makeTempDir } from './cli-helpers.ts';

// Minimal valid-for-doctor manifest; sync/env.vars empty so no base findings.
const BASE_MANIFEST = {
  version: 1,
  setup: { image: 'node:22' },
  workspace: { repo: 'git@github.com:acme/example-app.git', strategy: 'branch-per-job', sync: [] },
  env: { vars: [] },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'node .fleet/gate.mjs' },
};

/**
 * Write a temp project dir with a .fleet/manifest.json.
 * gateContent: body of .fleet/gate.mjs (omit to leave the file absent).
 */
function setupDir(manifest: unknown, gateContent?: string): string {
  const cwd = makeTempDir('fleet-doctor-');
  fs.mkdirSync(path.join(cwd, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (gateContent !== undefined) {
    fs.writeFileSync(path.join(cwd, '.fleet', 'gate.mjs'), gateContent);
  }
  return cwd;
}

/** Lines of stderr output (trimmed, non-empty). */
function stderrLines(stderr: string): string[] {
  return stderr.trim().split('\n').filter(Boolean);
}

test('doctor: clean on minimal manifest with passing gate', async () => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const res = await runCli(['doctor'], { cwd });
  assert.equal(res.code, 0, `expected 0 but got stderr: ${res.stderr}`);
  assert.match(res.stdout, /doctor: clean/);
  assert.equal(res.stderr.trim(), '', 'no findings on stderr');
});

test('doctor: gate exit 2 (cannot-evaluate) is not a finding', async () => {
  // exit 2 = "no target" — expected when doctor runs without a dispatch target.
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(2);\n');
  const res = await runCli(['doctor'], { cwd });
  assert.equal(res.code, 0, `expected 0 but got stderr: ${res.stderr}`);
  assert.match(res.stdout, /doctor: clean/);
});

test('doctor: reports exactly one finding for an unset env var', async () => {
  const manifest = { ...BASE_MANIFEST, env: { vars: ['FLEET_TEST_ABSENT_VAR_XYZ'] } };
  const cwd = setupDir(manifest, 'process.exit(0);\n');
  // Explicitly unset the var in the child environment.
  const res = await runCli(['doctor'], { cwd, env: { FLEET_TEST_ABSENT_VAR_XYZ: undefined } });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /unset env var/);
  assert.match(lines[0], /FLEET_TEST_ABSENT_VAR_XYZ/);
});

test('doctor: reports exactly one finding for an absent sync file', async () => {
  const manifest = {
    ...BASE_MANIFEST,
    workspace: { ...BASE_MANIFEST.workspace, sync: ['secrets/config.json'] },
  };
  const cwd = setupDir(manifest, 'process.exit(0);\n');
  // secrets/config.json does not exist in the temp dir.
  const res = await runCli(['doctor'], { cwd });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /missing sync file/);
  assert.match(lines[0], /secrets\/config\.json/);
});

test('doctor: reports exactly one finding for a broken gate (exit 1)', async () => {
  // A gate that unconditionally fails — models a broken pickup script.
  const cwd = setupDir(BASE_MANIFEST, "process.stderr.write('gate: not ready\\n'); process.exit(1);\n");
  const res = await runCli(['doctor'], { cwd });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /gate script failed/);
  assert.match(lines[0], /exit 1/);
});

test('doctor: reports exactly one finding for a missing gate script', async () => {
  // No gate file written — simulates a manifest pointing to a non-existent script.
  const cwd = setupDir(BASE_MANIFEST);
  const res = await runCli(['doctor'], { cwd });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /gate script missing/);
  assert.match(lines[0], /gate\.mjs/);
});

test('doctor: fails readably when manifest is missing', async () => {
  const cwd = makeTempDir('fleet-doctor-nomf-');
  const res = await runCli(['doctor'], { cwd });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /manifest not found/);
});

test('doctor: reports harness CLI version mismatch when cli_version is pinned', async () => {
  // Create a fake 'claude' binary that reports a known version, then give the
  // manifest a different expected version so the mismatch branch is exercised.
  const binDir = makeTempDir('fleet-doctor-bin-');
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });
  const manifest = {
    ...BASE_MANIFEST,
    harness: { ...BASE_MANIFEST.harness, cli_version: '99.0.0' },
  };
  const cwd = setupDir(manifest, 'process.exit(0);\n');
  const res = await runCli(['doctor'], {
    cwd,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /harness CLI version mismatch/);
  assert.match(lines[0], /99\.0\.0/);
  assert.match(lines[0], /1\.0\.0/);
});

test('doctor: reports harness CLI not found when cli_version is set but binary is absent', async () => {
  // Create an empty bin dir (no 'claude' binary) prepended to PATH so the
  // not-found branch fires even if claude is installed system-wide.
  const binDir = makeTempDir('fleet-doctor-bin-');
  // Fake git and gh so the tool-check findings don't muddy the count.
  for (const tool of ['git', 'gh']) {
    fs.writeFileSync(
      path.join(binDir, tool),
      '#!/bin/sh\necho "fake"\n',
      { mode: 0o755 },
    );
  }
  // Also expose node itself so the gate can run.
  fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
  const manifest = {
    ...BASE_MANIFEST,
    harness: { ...BASE_MANIFEST.harness, cli_version: '1.0.0' },
  };
  const cwd = setupDir(manifest, 'process.exit(0);\n');
  const res = await runCli(['doctor'], {
    cwd,
    // PATH is ONLY binDir — no system 'claude' binary reachable.
    env: { PATH: binDir },
  });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /harness CLI not found/);
  assert.match(lines[0], /claude/);
});

test('doctor: var in .fleet/.env satisfies the env check (no finding)', async () => {
  const manifest = { ...BASE_MANIFEST, env: { vars: ['FLEET_TEST_DOTENV_VAR_XYZ'] } };
  const cwd = setupDir(manifest, 'process.exit(0);\n');
  // Write the var to .fleet/.env; leave it absent from the shell env.
  fs.writeFileSync(path.join(cwd, '.fleet', '.env'), 'FLEET_TEST_DOTENV_VAR_XYZ=from-dotenv\n');
  const res = await runCli(['doctor'], { cwd, env: { FLEET_TEST_DOTENV_VAR_XYZ: undefined } });
  assert.equal(res.code, 0, `expected clean but got stderr: ${res.stderr}`);
  assert.match(res.stdout, /doctor: clean/);
});

test('doctor: --manifest flag points at an explicit path', async () => {
  const cwd = makeTempDir('fleet-doctor-mflag-');
  fs.mkdirSync(path.join(cwd, '.fleet'), { recursive: true });
  const gateFile = path.join(cwd, '.fleet', 'gate.mjs');
  fs.writeFileSync(gateFile, 'process.exit(0);\n');
  // Manifest lives outside .fleet/ at an explicit path.
  const mpath = path.join(cwd, 'custom-manifest.json');
  const manifest = { ...BASE_MANIFEST, gates: { pickup: `node ${gateFile}` } };
  fs.writeFileSync(mpath, JSON.stringify(manifest));
  const res = await runCli(['doctor', '--manifest', mpath], { cwd });
  assert.equal(res.code, 0, `expected clean but got stderr: ${res.stderr}`);
  assert.match(res.stdout, /doctor: clean/);
});
