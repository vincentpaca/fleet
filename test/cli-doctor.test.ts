import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('doctor: a missing auth credential names the acquisition path, never a bare var (#205)', async () => {
  const manifest = { ...BASE_MANIFEST, env: { vars: ['CLAUDE_CODE_OAUTH_TOKEN'] } };
  const cwd = setupDir(manifest, 'process.exit(0);\n');
  const res = await runDoctor(['doctor'], { cwd, env: { CLAUDE_CODE_OAUTH_TOKEN: undefined } });
  assert.equal(res.code, 1, res.stderr);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `expected exactly one finding, got:\n${res.stderr}`);
  assert.match(lines[0], /unset env var: CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(lines[0], /claude setup-token/, 'the finding teaches the recovery command');
  assert.match(lines[0], /fleet setup repo/, 'and the Fleet side of it');
});

test('doctor: a missing ANTHROPIC_API_KEY names the seat alternative too (#205)', async () => {
  const manifest = { ...BASE_MANIFEST, env: { vars: ['ANTHROPIC_API_KEY'] } };
  const cwd = setupDir(manifest, 'process.exit(0);\n');
  const res = await runDoctor(['doctor'], { cwd, env: { ANTHROPIC_API_KEY: undefined } });
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /unset env var: ANTHROPIC_API_KEY/);
  assert.match(res.stderr, /claude setup-token/, 'a seat user learns their path, not just "set the key"');
});

test('doctor: a present auth credential is an honest presence-only note, and doctor stays clean (#205)', async () => {
  const manifest = { ...BASE_MANIFEST, env: { vars: ['CLAUDE_CODE_OAUTH_TOKEN'] } };
  const cwd = setupDir(manifest, 'process.exit(0);\n');
  fs.writeFileSync(path.join(cwd, '.fleet', '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-here\n');
  const res = await runDoctor(['doctor'], { cwd, env: { CLAUDE_CODE_OAUTH_TOKEN: undefined } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /auth: CLAUDE_CODE_OAUTH_TOKEN present in \.fleet\/\.env/);
  assert.match(res.stdout, /presence only/, 'doctor never claims liveness it cannot inspect');
  assert.match(res.stdout, /doctor: clean/);
  assert.equal(res.stderr.trim(), '', 'presence is a note, not a finding');
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

// ── Orphaned cloud tasks (#147) ──────────────────────────────────────────────
// doctor triggers the daemon's reconcile sweep on demand and lists what it
// found: a task billing behind a terminal job is spend nothing else surfaces
// until the runner's own wall-clock cap fires.

test('doctor: lists the orphaned tasks the daemon reconcile sweep reports (#147)', async (t) => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const daemon = await startMockDaemon({
    'GET /health': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    'POST /reconcile': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        orphans: [
          { job: 'job-orphan-1', handle: 'arn:aws:ecs:ap-southeast-1:111122223333:task/fleet-cluster/0001', stopped: true },
          { job: 'job-orphan-2', handle: 'arn:aws:ecs:ap-southeast-1:111122223333:task/fleet-cluster/0002', stopped: false },
        ],
      }));
    },
  });
  t.after(() => daemon.close());

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 1, `orphans are findings: ${res.stdout}`);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 2, `one finding per orphan:\n${res.stderr}`);
  // The stopped orphan: was billing, the sweep ended it — say so, name both ids.
  assert.match(lines[0], /orphaned task stopped/);
  assert.match(lines[0], /task\/fleet-cluster\/0001/);
  assert.match(lines[0], /job-orphan-1/);
  // The unstopped one is still spending; the finding must not read as resolved.
  assert.match(lines[1], /orphaned task still running/);
  assert.match(lines[1], /task\/fleet-cluster\/0002/);
  assert.match(lines[1], /job-orphan-2/);
});

test('doctor: a daemon that predates the reconcile endpoint stays clean (#147)', async (t) => {
  // startMockDaemon answers unknown routes with 404 — exactly what an older
  // daemon does. Not knowing is not a defect; doctor must not invent one.
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
  assert.match(res.stdout, /doctor: clean/);
});

// ── Deployment skew (#207) ───────────────────────────────────────────────────
// The #197 incident: a runner image predating an already-merged fix cost a job
// its work, and nothing named the gap. doctor compares the applied unit ref
// (deployment-local .fleet/infra/<provider>/main.tf) and the daemon image's
// build stamp (/health `build`, baked by images/build.sh) against this CLI's
// own checkout — git SHAs until #183 mints release versions.

// The suite runs from a checkout, so HEAD is the CLI's own identity — the same
// value doctor resolves, read the same way.
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
// A well-formed sha that no repository resolves: the "stale deployment" stand-in.
const STALE_SHA = 'deadbeef'.repeat(5);

/** A deployment root module beside the project, pinned at `ref`. */
function writeDeployment(cwd: string, ref: string): void {
  const dir = path.join(cwd, '.fleet', 'infra', 'aws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'main.tf'),
    `module "fleet" {\n  source = "git::https://github.com/fleet-test/fleet.git//infra/aws?ref=${ref}"\n\n  aws_region = "us-west-2"\n}\n`,
  );
}

/** A mock deployment daemon whose /health carries `build` (omit for unstamped). */
function healthDaemon(build?: string): ReturnType<typeof startMockDaemon> {
  return startMockDaemon({
    'GET /health': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(build === undefined ? { ok: true } : { ok: true, build }));
    },
  });
}

test('doctor: a fully-stamped matching deployment gets a version note (#207)', async (t) => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  writeDeployment(cwd, HEAD_SHA);
  const daemon = await healthDaemon(HEAD_SHA);
  t.after(() => daemon.close());

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, `expected clean but got: ${res.stderr}`);
  const short = HEAD_SHA.slice(0, 12);
  assert.match(res.stdout, new RegExp(`skew: deployment matches this CLI at ${short} \\(unit ref ${short}, daemon image ${short}\\)`));
  assert.match(res.stdout, /doctor: clean/);
});

test('doctor: a daemon image behind the CLI is a finding naming both SHAs and the fix (#207)', async (t) => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  writeDeployment(cwd, HEAD_SHA);
  const daemon = await healthDaemon(STALE_SHA);
  t.after(() => daemon.close());

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 1, `expected a finding but got: ${res.stdout}`);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `exactly one finding:\n${res.stderr}`);
  assert.match(lines[0], /deployment skew: daemon image was built at/);
  assert.ok(lines[0].includes(STALE_SHA.slice(0, 12)), 'names the image sha');
  assert.ok(lines[0].includes(HEAD_SHA.slice(0, 12)), 'names the CLI sha');
  assert.match(lines[0], /images\/build\.sh --redeploy-daemon/, 'the fix that exists today');
  assert.match(lines[0], /fleet upgrade will own this once it exists \(#207\)/);
});

test('doctor: an applied unit ref behind the CLI is a finding naming both and the fix (#207)', async (t) => {
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  writeDeployment(cwd, STALE_SHA);
  const daemon = await healthDaemon(HEAD_SHA);
  t.after(() => daemon.close());

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 1, `expected a finding but got: ${res.stdout}`);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `exactly one finding:\n${res.stderr}`);
  assert.match(lines[0], /deployment skew: aws unit is applied at ref/);
  assert.ok(lines[0].includes(STALE_SHA.slice(0, 12)), 'names the applied ref');
  assert.ok(lines[0].includes(HEAD_SHA.slice(0, 12)), 'names the CLI sha');
  assert.match(lines[0], /re-apply the unit at the current ref/);
});

test('doctor: an unstamped daemon image is the honest finding, not a crash (#207)', async (t) => {
  // Images built before this stamp existed answer /health without `build`.
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  writeDeployment(cwd, HEAD_SHA);
  const daemon = await healthDaemon();
  t.after(() => daemon.close());

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 1, `expected a finding but got: ${res.stdout}`);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 1, `exactly one finding:\n${res.stderr}`);
  assert.match(lines[0], /daemon image is unstamped/);
  assert.match(lines[0], /predates skew detection/);
  assert.match(lines[0], /rebuild/);
});

test('doctor: a git::file dogfood pin with ?ref= is compared, not shrugged at (#207)', async (t) => {
  // pinnedSource only matches clonable https sources (the CodeBuild constraint);
  // skew must still compare a local-clone pin — the dogfood deployment's shape.
  // The bug this catches: doctor said "no pinned ref to compare" about a source
  // whose ref was sitting right in the string (2026-08-27, live).
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const dir = path.join(cwd, '.fleet', 'infra', 'aws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'main.tf'),
    `module "fleet" {\n  source = "git::file:///somewhere/fleet//infra/aws?ref=${HEAD_SHA}"\n\n  aws_region = "us-west-2"\n}\n`,
  );
  const daemon = await healthDaemon(HEAD_SHA);
  t.after(() => daemon.close());

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, `expected clean but got: ${res.stderr}`);
  assert.ok(!res.stdout.includes('no pinned ref to compare'), `file:// pin must be compared: ${res.stdout}`);
  const short = HEAD_SHA.slice(0, 12);
  assert.match(res.stdout, new RegExp(`skew: deployment matches this CLI at ${short}`));
});

test('doctor: no deployment root module means no skew section, even with a daemon up (#207)', async (t) => {
  // Without .fleet/infra/<provider>/main.tf there is nothing the CLI could be
  // skewed against — a match note here would be invented.
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  const daemon = await healthDaemon(STALE_SHA);
  t.after(() => daemon.close());

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, `expected clean but got: ${res.stderr}`);
  assert.ok(!res.stdout.includes('skew'), `no skew section: ${res.stdout}`);
  assert.ok(!res.stderr.includes('skew'), `no skew finding: ${res.stderr}`);
});

test('doctor: skew keeps working with no daemon reachable — the unit ref is still compared (#207)', async () => {
  // Daemon reachability is the tunnel section's story; the image simply goes
  // uncompared rather than producing a second finding about the same outage.
  const cwd = setupDir(BASE_MANIFEST, 'process.exit(0);\n');
  writeDeployment(cwd, STALE_SHA);
  const probe = await startMockDaemon({});
  const port = Number(new URL(probe.url).port);
  await probe.close();

  const res = await runDoctor(['doctor'], { cwd, env: { FLEET_DAEMON_URL: `http://127.0.0.1:${port}` } });
  assert.equal(res.code, 1, res.stdout);
  const lines = stderrLines(res.stderr);
  assert.equal(lines.length, 2, `the dead tunnel and the stale ref, nothing else:\n${res.stderr}`);
  assert.match(res.stderr, /nothing is listening/);
  assert.match(res.stderr, /deployment skew: aws unit is applied at ref/);
  assert.ok(!res.stderr.includes('daemon image'), 'the unreachable image is not a second finding');
});
