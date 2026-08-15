import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { validateWorkOrder } from '../src/validate.mjs';
import { runCli, makeTempDir, startMockDaemon, sendJson, type MockRequest } from './cli-helpers.ts';

const MANIFEST = {
  version: 1,
  setup: { image: 'node:22', script: '.fleet/setup.sh' },
  workspace: {
    repo: 'git@github.com:acme/example-app.git',
    strategy: 'branch-per-job',
    sync: ['.env.fleet'],
  },
  env: { vars: ['ACME_API_TOKEN'] },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'node .fleet/check-ready.js', default_finish: 'merge-ready' },
};

function scaffold(manifest: unknown = MANIFEST): string {
  const cwd = makeTempDir('fleet-cli-delegate-');
  fs.mkdirSync(path.join(cwd, '.fleet'));
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(cwd, '.env.fleet'), 'ACME_SETTING=example.com\n');
  return cwd;
}

function jobsRoute() {
  return {
    'POST /jobs': (_req: MockRequest, res: ServerResponse) => {
      sendJson(res, 201, { job: { id: 'job-1', state: 'queued' } });
    },
  };
}
test('delegate builds a valid implement work order from presets and posts it', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /job-1 queued/);

  assert.equal(daemon.requests.length, 1);
  const body = JSON.parse(daemon.requests[0].body);

  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(body.workOrder.mode, 'implement');
  assert.equal(body.workOrder.target, 'APP-123');
  assert.equal(body.workOrder.finish, 'merge-ready');
  assert.equal(body.workOrder.report, 'status-first');
  assert.equal(body.workOrder.authority.edit, true);
  assert.equal(body.workOrder.authority.merge, false, 'merge never grantable');
  assert.equal(body.workOrder.authority.deploy, false, 'deploy never grantable');

  assert.deepEqual(body.manifest, MANIFEST, 'manifest travels with the dispatch');
  assert.equal(body.env.ACME_API_TOKEN, 'token-value', 'env value read from the dispatching shell');
  assert.equal(
    Buffer.from(body.sync['.env.fleet'], 'base64').toString('utf8'),
    'ACME_SETTING=example.com\n',
    'sync file content shipped base64-encoded',
  );
});

test('delegate --mode and --finish override the preset', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123', '--mode', 'assess', '--finish', 'inspected'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.mode, 'assess');
  assert.equal(body.workOrder.finish, 'inspected');
  assert.equal(body.workOrder.authority.edit, false, 'assess is read-only');
  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.equal(ok, true, JSON.stringify(errors));
});

test('delegate fails loudly on a missing env var, before any POST', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: undefined },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /missing env var: ACME_API_TOKEN/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate fails loudly on a missing sync file, before any POST', async (t) => {
  const cwd = scaffold();
  fs.rmSync(path.join(cwd, '.env.fleet'));
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /missing sync file: \.env\.fleet/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate rejects an unknown mode and an invalid manifest locally', async () => {
  const cwd = scaffold();
  const badMode = await runCli(['delegate', 'APP-123', '--mode', 'conquer'], {
    cwd,
    env: { ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(badMode.code, 1);
  assert.match(badMode.stderr, /unknown mode "conquer"/);
  assert.match(badMode.stderr, /implement/, 'lists available modes');

  const badCwd = scaffold({ version: 1 });
  const badManifest = await runCli(['delegate', 'APP-123'], { cwd: badCwd });
  assert.equal(badManifest.code, 1);
  assert.match(badManifest.stderr, /must have required property/);
});

test('delegate surfaces daemon 422 errors readably', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'POST /jobs': (req, res) => {
      sendJson(res, 422, { errors: [{ instancePath: '/workOrder/finish', message: 'is not targetable' }] });
    },
  });
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /\/workOrder\/finish is not targetable/);
});

test('delegate requires a target argument (usage error)', async () => {
  const cwd = scaffold();
  const res = await runCli(['delegate'], { cwd });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage error/);
});
