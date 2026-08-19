import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, makeTempDir, startMockDaemon } from './cli-helpers.ts';

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

// doctor also lists workspaces retained after a failed push (#38), which live
// under $FLEET_HOME. Pin every run at an empty temp home so the finding counts
// below describe the manifest and nothing about the machine.
const EMPTY_HOME = makeTempDir('fleet-doctor-home-');

function runDoctor(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): ReturnType<typeof runCli> {
  return runCli(args, { ...opts, env: { FLEET_HOME: EMPTY_HOME, ...opts.env } });
}

test('doctor: clean on minimal manifest with passing gate', async () => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const res = await runDoctor(['doctor'], { cwd });
  assert.equal(res.code, 0, `expected 0 but got stderr: ${res.stderr}`);
  assert.match(res.stdout, /doctor: clean/);
  assert.equal(res.stderr.trim(), '', 'no findings on stderr');
});

test('doctor: gate exit 2 (cannot-evaluate) is not a finding', async () => {
  // exit 2 = "no target" — expected when doctor runs without a dispatch target.
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(2);\n');
  const res = await runDoctor(['doctor'], { cwd });
  assert.equal(res.code, 0, `expected 0 but got stderr: ${res.stderr}`);
  assert.match(res.stdout, /doctor: clean/);
});

test('doctor: reports exactly one finding for an unset env var', async () => {
  const manifest = { ...BASE_MANIFEST, env: { vars: ['FLEET_TEST_ABSENT_VAR_XYZ'] } };
  const cwd = setupDir(manifest, 'process.exit(0);\n');
  // Explicitly unset the var in the child environment.
  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_TEST_ABSENT_VAR_XYZ: undefined } });
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
  const res = await runDoctor(['doctor'], { cwd });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /missing sync file/);
  assert.match(lines[0], /secrets\/config\.json/);
});

test('doctor: reports exactly one finding for a broken gate (exit 1)', async () => {
  // A gate that unconditionally fails — models a broken pickup script.
  const cwd = setupDir(BASE_MANIFEST, "process.stderr.write('gate: not ready\\n'); process.exit(1);\n");
  const res = await runDoctor(['doctor'], { cwd });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /gate script failed/);
  assert.match(lines[0], /exit 1/);
});

test('doctor: reports exactly one finding for a missing gate script', async () => {
  // No gate file written — simulates a manifest pointing to a non-existent script.
  const cwd = setupDir(BASE_MANIFEST);
  const res = await runDoctor(['doctor'], { cwd });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /gate script missing/);
  assert.match(lines[0], /gate\.mjs/);
});

test('doctor: fails readably when manifest is missing', async () => {
  const cwd = makeTempDir('fleet-doctor-nomf-');
  const res = await runDoctor(['doctor'], { cwd });
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
  const res = await runDoctor(['doctor'], {
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
  const res = await runDoctor(['doctor'], {
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
  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_TEST_DOTENV_VAR_XYZ: undefined } });
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
  const res = await runDoctor(['doctor', '--manifest', mpath], { cwd });
  assert.equal(res.code, 0, `expected clean but got stderr: ${res.stderr}`);
  assert.match(res.stdout, /doctor: clean/);
});

test('doctor: lists a workspace retained after a failed push, with the recovery command', async () => {
  // #38: the workspace is the only copy of that job's work. Silence here is
  // exactly how it disappears, so it counts as a finding until recovered.
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const home = makeTempDir('fleet-doctor-retained-');
  const workspace = makeTempDir('fleet-doctor-kept-ws-');
  fs.mkdirSync(path.join(home, 'retained'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'retained', 'job-kept-1.json'),
    JSON.stringify({
      jobId: 'job-kept-1',
      target: 'APP-123',
      branch: 'fleet/APP-123-job-kept-1',
      base: 'main',
      ok: true,
      reason: 'fatal: could not read from remote repository',
      at: '2026-08-17T10:00:00.000Z',
      workspace,
    }),
  );

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_HOME: home } });
  assert.equal(res.code, 1, res.stdout);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /retained workspace/);
  assert.ok(lines[0].includes(workspace), 'the finding must name the kept path');
  assert.match(lines[0], /fleet resume-push job-kept-1/);
  assert.doesNotMatch(lines[0], /directory missing/);
});

test('doctor: a retained record whose directory is gone says so', async () => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const home = makeTempDir('fleet-doctor-retained-');
  fs.mkdirSync(path.join(home, 'retained'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'retained', 'job-kept-2.json'),
    JSON.stringify({
      jobId: 'job-kept-2',
      target: 'APP-124',
      branch: 'fleet/APP-124-job-kept-2',
      ok: false,
      reason: 'fatal: unable to access remote',
      at: '2026-08-17T11:00:00.000Z',
      workspace: path.join(home, 'never-existed'),
    }),
  );

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_HOME: home } });
  assert.equal(res.code, 1, res.stdout);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /directory missing/);
});

test('doctor: a malformed retained record is ignored, not a crash', async () => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const home = makeTempDir('fleet-doctor-retained-');
  fs.mkdirSync(path.join(home, 'retained'), { recursive: true });
  fs.writeFileSync(path.join(home, 'retained', 'job-kept-3.json'), 'not json at all');
  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_HOME: home } });
  assert.equal(res.code, 0, `expected clean but got stderr: ${res.stderr}`);
  assert.match(res.stdout, /doctor: clean/);
});

// ── Tunnel state (#57) ───────────────────────────────────────────────────────
// A TCP daemon address means a port-forward carries every command. doctor has
// to say what the tunnel is doing; "cannot reach daemon: ECONNREFUSED" from the
// next delegate does not.

test('doctor: reports a dead tunnel instead of leaving it to the next command', async () => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  // A port the OS just handed back and nothing is on.
  const probe = await startMockDaemon({});
  const port = Number(new URL(probe.url).port);
  await probe.close();

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: `http://127.0.0.1:${port}` } });
  assert.equal(res.code, 1, `expected a finding but got: ${res.stdout}`);
  assert.equal(stderrLines(res.stderr).length, 1, `exactly one finding: ${res.stderr}`);
  assert.match(res.stderr, new RegExp(`nothing is listening on http://127\\.0\\.0\\.1:${port}`));
  assert.match(res.stderr, /fleet connect/);
});

test('doctor: a serving tunnel is a note, not a finding', async (t) => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const daemon = await startMockDaemon({
    'GET /health': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  t.after(() => daemon.close());

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, `expected clean but got: ${res.stderr}`);
  assert.match(res.stdout, /tunnel: daemon \/health ok/);
  assert.match(res.stdout, /doctor: clean/);
});

test('doctor: a unix-socket daemon has no tunnel and gets no tunnel section', async () => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const res = await runDoctor(['doctor'], { cwd });
  assert.equal(res.code, 0, `expected clean but got: ${res.stderr}`);
  assert.ok(!res.stdout.includes('tunnel:'), `no tunnel section: ${res.stdout}`);
});
