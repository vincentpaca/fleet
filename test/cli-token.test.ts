// #188: the CLI resolves the operator token — local file first, else fetched
// from the SSM parameter the deployment's daemon published at boot, cached to
// $FLEET_HOME/operator-token at 0600. A stale local token that draws a 401 is
// refetched once and retried; when even that is refused, the failure names the
// token and the fix, never a bare 401. Everything runs the real CLI against a
// mock daemon and the fake `aws` fixture — the acceptance shape of a fresh
// cloud deployment, without a cloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeAwsBin, makeTempDir, runCli, sendJson, startMockDaemon, type MockDaemon } from './cli-helpers.ts';

const TOKEN = 'live-operator-token-188';
const TOKEN_PARAM = '/fleet/operator-token';

/** A mock daemon that enforces the operator token on GET /jobs, like the real one (#133). */
function startEnforcingDaemon(): Promise<MockDaemon> {
  return startMockDaemon({
    'GET /jobs': (req, res) => {
      if (req.headers['x-fleet-operator-token'] === TOKEN) sendJson(res, 200, { jobs: [] });
      else sendJson(res, 401, { error: 'unauthorized' });
    },
    'GET /health': (_req, res) => sendJson(res, 200, { ok: true }),
  });
}

/** A checkout that captured an ECS deployment: fleet-config.json names the SSM prefix and the daemon. */
function ecsProject(daemonUrl: string): string {
  const cwd = makeTempDir('fleet-token-proj-');
  const dir = path.join(cwd, '.fleet', 'infra', 'aws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleet-config.json'), JSON.stringify({
    provider: 'ecs',
    cluster: 'fleet',
    region: 'us-east-1',
    ssm_config_path: '/fleet/fleet-config',
    daemon_url: daemonUrl,
  }, null, 2));
  return cwd;
}

/** The fake `aws` on PATH plus a parameter store holding the published token. */
function awsWithPublishedToken(value: string = TOKEN): { bin: string; state: string } {
  const state = path.join(makeTempDir('fleet-token-state-'), 'aws');
  const bin = fakeAwsBin(state);
  fs.writeFileSync(path.join(state, 'params.json'), JSON.stringify({
    [TOKEN_PARAM]: { Type: 'SecureString', Value: value },
  }));
  return { bin, state };
}

function envFor(home: string, aws: { bin: string; state: string }): Record<string, string> {
  return {
    FLEET_HOME: home,
    PATH: `${aws.bin}:${process.env.PATH ?? ''}`,
    FAKE_AWS_DIR: aws.state,
  };
}

test('a CLI with no local token fetches it from SSM, caches it 0600, and authenticates (#188)', async (t) => {
  const daemon = await startEnforcingDaemon();
  t.after(() => daemon.close());
  const aws = awsWithPublishedToken();
  const home = makeTempDir('fleet-token-home-');
  const cwd = ecsProject(daemon.url);

  const res = await runCli(['status'], { cwd, env: envFor(home, aws) });
  assert.equal(res.code, 0, `status failed:\n${res.stderr}`);
  assert.match(res.stdout, /no jobs/);

  const tokenFile = path.join(home, 'operator-token');
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), TOKEN, 'the fetched token is cached locally');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, 'the cache is 0600, like the daemon\'s own copy');
  // Fetched before the first request, not repaired after it: one call, one 200.
  assert.equal(daemon.requests.filter((r) => r.url.startsWith('/jobs')).length, 1);
});

test('a stale local token draws a 401, is refetched once, and the command succeeds (#188)', async (t) => {
  const daemon = await startEnforcingDaemon();
  t.after(() => daemon.close());
  const aws = awsWithPublishedToken();
  const home = makeTempDir('fleet-token-home-');
  fs.writeFileSync(path.join(home, 'operator-token'), 'stale-token-from-before-the-apply\n', { mode: 0o600 });
  const cwd = ecsProject(daemon.url);

  const res = await runCli(['status'], { cwd, env: envFor(home, aws) });
  assert.equal(res.code, 0, `status failed:\n${res.stderr}`);
  assert.match(res.stdout, /no jobs/);
  assert.equal(fs.readFileSync(path.join(home, 'operator-token'), 'utf8').trim(), TOKEN, 'the stale cache was replaced');
  // Exactly one retry: the 401 with the stale token, then the 200 with the fresh one.
  assert.equal(daemon.requests.filter((r) => r.url.startsWith('/jobs')).length, 2);
});

test('when the refetched token is refused too, the failure names the token — not a bare 401 (#188)', async (t) => {
  const daemon = await startEnforcingDaemon();
  t.after(() => daemon.close());
  // The parameter is stale as well: a daemon replaced without republishing.
  const aws = awsWithPublishedToken('another-wrong-token');
  const home = makeTempDir('fleet-token-home-');
  fs.writeFileSync(path.join(home, 'operator-token'), 'stale-token-from-before-the-apply\n', { mode: 0o600 });
  const cwd = ecsProject(daemon.url);

  const res = await runCli(['status'], { cwd, env: envFor(home, aws) });
  assert.equal(res.code, 1, `expected a failure:\n${res.stdout}`);
  assert.match(res.stderr, /refused both the local operator token and the one refetched/);
  assert.match(res.stderr, /operator-token/);
  assert.doesNotMatch(res.stderr, /status failed: daemon returned 401/, 'the bare 401 is exactly what #188 removes');
  // Refetched once, not in a loop: stale 401 + retried 401, nothing more.
  assert.equal(daemon.requests.filter((r) => r.url.startsWith('/jobs')).length, 2);
});

test('a CLI with no token and no captured deployment keeps today\'s 401 behavior', async (t) => {
  // A checkout with no .fleet/infra offers nowhere to fetch from: the daemon's
  // 401 reaches the caller as it always did — no invented token machinery.
  const daemon = await startEnforcingDaemon();
  t.after(() => daemon.close());
  const res = await runCli(['status'], { env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /status failed/);
});

// ── doctor (#188): token state is a readable line in both directions ────────

// Minimal valid-for-doctor manifest, as in cli-doctor.test.ts.
const BASE_MANIFEST = {
  version: 1,
  setup: { image: 'node:22' },
  workspace: { repo: 'git@github.com:acme/example-app.git', strategy: 'branch-per-job', sync: [] },
  env: { vars: [] },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'node .fleet/gate.mjs' },
};

/** An ecsProject that is also a valid doctor target: manifest + passing gate. */
function doctorProject(daemonUrl: string): string {
  const cwd = ecsProject(daemonUrl);
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), JSON.stringify(BASE_MANIFEST, null, 2));
  fs.writeFileSync(path.join(cwd, '.fleet', 'gate.mjs'), 'process.exit(0);\n');
  return cwd;
}

test('doctor: names a healthy token state (#188)', async (t) => {
  const daemon = await startEnforcingDaemon();
  t.after(() => daemon.close());
  const aws = awsWithPublishedToken();
  const home = makeTempDir('fleet-token-home-');
  fs.writeFileSync(path.join(home, 'operator-token'), `${TOKEN}\n`, { mode: 0o600 });
  const cwd = doctorProject(daemon.url);

  const res = await runCli(['doctor'], { cwd, env: envFor(home, aws) });
  assert.equal(res.code, 0, `expected clean:\n${res.stderr}`);
  assert.match(res.stdout, /operator token: .*operator-token accepted/);
  assert.match(res.stdout, /doctor: clean/);
});

test('doctor: says a stale token was refetched and accepted, still clean (#188)', async (t) => {
  const daemon = await startEnforcingDaemon();
  t.after(() => daemon.close());
  const aws = awsWithPublishedToken();
  const home = makeTempDir('fleet-token-home-');
  fs.writeFileSync(path.join(home, 'operator-token'), 'stale-token-from-before-the-apply\n', { mode: 0o600 });
  const cwd = doctorProject(daemon.url);

  const res = await runCli(['doctor'], { cwd, env: envFor(home, aws) });
  assert.equal(res.code, 0, `healing is a note, not a finding:\n${res.stderr}`);
  assert.match(res.stdout, /operator token: .*was stale — refetched from the deployment and accepted/);
  assert.match(res.stdout, /doctor: clean/);
});

test('doctor: a mismatch with nowhere to refetch from is a finding naming the file, never a bare 401 (#188)', async (t) => {
  const daemon = await startEnforcingDaemon();
  t.after(() => daemon.close());
  const home = makeTempDir('fleet-token-home-');
  fs.writeFileSync(path.join(home, 'operator-token'), 'stale-token-from-before-the-apply\n', { mode: 0o600 });
  // No .fleet/infra capture: the daemon is named by env, so no SSM refetch exists.
  const cwd = makeTempDir('fleet-token-doctor-');
  fs.mkdirSync(path.join(cwd, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), JSON.stringify(BASE_MANIFEST, null, 2));
  fs.writeFileSync(path.join(cwd, '.fleet', 'gate.mjs'), 'process.exit(0);\n');

  const res = await runCli(['doctor'], { cwd, env: { FLEET_HOME: home, FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 1, `a refused token is a finding:\n${res.stdout}`);
  assert.match(res.stderr, /operator token mismatch: the daemon refused/);
  assert.match(res.stderr, /operator-token/);
  assert.doesNotMatch(res.stderr, /daemon returned 401/);
});
