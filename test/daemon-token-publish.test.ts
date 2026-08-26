// #188: a fresh cloud deployment mints its operator token on a volume the
// operator cannot read without `ecs execute-command` by hand. The daemon must
// therefore publish the token at boot as a SecureString SSM parameter under
// the same prefix it reads its config from (/fleet/fleet-config →
// /fleet/operator-token) so the CLI can fetch it with the operator's own AWS
// credentials. This spawns the real entrypoint (like daemon-boot-log.test.ts)
// against the fake `aws` fixture: the publish only counts if src/daemon/main.ts
// actually performs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { TestContext } from 'node:test';
import { fakeAwsBin, until } from './cli-helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const daemonMain = join(here, '..', 'src', 'daemon', 'main.ts');

const CONFIG_PATH = '/fleet/fleet-config';
const TOKEN_PATH = '/fleet/operator-token';

/** Temp dir removed when the test ends — tests own their state, on disk too. */
function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Spawn the real daemon entrypoint with an explicit env; collect stdout/stderr. */
function spawnDaemon(t: TestContext, env: Record<string, string>): { child: ChildProcess; out: () => string; err: () => string } {
  const child = spawn(process.execPath, [daemonMain], {
    cwd: tempDir(t, 'fleet-token-cwd-'),
    env: { HOME: tempDir(t, 'fleet-token-hm-'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => { out += chunk; });
  child.stderr!.on('data', (chunk: string) => { err += chunk; });
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
  t.after(async () => {
    child.kill('SIGTERM');
    await exited;
  });
  return { child, out: () => out, err: () => err };
}

test('an ecs daemon publishes its operator token to SSM at boot (#188)', async (t) => {
  const state = join(tempDir(t, 'fleet-token-state-'), 'aws');
  const bin = fakeAwsBin(state);
  // The parameter store an apply would have left behind: the config the daemon
  // reads at boot, and no operator-token yet — this is the fresh deployment.
  writeFileSync(join(state, 'params.json'), JSON.stringify({
    [CONFIG_PATH]: {
      Type: 'SecureString',
      Value: JSON.stringify({
        cluster: 'fleet-test-cluster',
        runner_task_definition: 'fleet-test-runner:1',
        runner_container_name: 'runner',
      }),
    },
  }));
  const home = tempDir(t, 'fleet-token-home-');
  const daemon = spawnDaemon(t, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_AWS_DIR: state,
    FLEET_HOME: home,
    FLEET_PORT: '0',
    FLEET_PROVIDER: 'ecs',
    FLEET_ECS_CONFIG_SSM_PATH: CONFIG_PATH,
  });

  // The boot log must say where the token went — the name, never the value.
  await until(
    () => daemon.out().includes(`fleet daemon: published operator token to ssm:${TOKEN_PATH}`),
    `the publish line\nstdout:\n${daemon.out()}\nstderr:\n${daemon.err()}`,
    20_000,
  );

  const token = readFileSync(join(home, 'operator-token'), 'utf8').trim();
  assert.notEqual(token, '', 'the daemon minted a token at boot');
  const params = JSON.parse(readFileSync(join(state, 'params.json'), 'utf8')) as
    Record<string, { Value?: string; Type?: string }>;
  const published = params[TOKEN_PATH];
  assert.ok(published, `the token parameter was written under the config prefix; store: ${JSON.stringify(params, null, 2)}`);
  assert.equal(published.Value, token, 'the published value is the token the daemon enforces');
  assert.equal(published.Type, 'SecureString', 'the token must not land as a plaintext String parameter');
  // Overwrite must be set: a redeployed daemon replaces the previous token.
  assert.match(readFileSync(join(state, 'puts.log'), 'utf8'), /overwrite/);
  // Boot evidence is safe to ship to a log group: the value never appears.
  assert.ok(!daemon.out().includes(token) && !daemon.err().includes(token), 'boot output leaked the token');
});

test('a publish failure is an error line, not a dead daemon (#188)', async (t) => {
  const state = join(tempDir(t, 'fleet-token-fail-state-'), 'aws');
  const bin = fakeAwsBin(state);
  // The config read succeeds; the put is denied (fake-aws's deny-put flag —
  // the shape of a live IAM denial on ssm:PutParameter).
  writeFileSync(join(state, 'params.json'), JSON.stringify({
    [CONFIG_PATH]: {
      Type: 'SecureString',
      Value: JSON.stringify({
        cluster: 'fleet-test-cluster',
        runner_task_definition: 'fleet-test-runner:1',
        runner_container_name: 'runner',
      }),
    },
  }));
  writeFileSync(join(state, 'deny-put'), '1');
  const home = tempDir(t, 'fleet-token-fail-home-');
  const daemon = spawnDaemon(t, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_AWS_DIR: state,
    FLEET_HOME: home,
    FLEET_PORT: '0',
    FLEET_PROVIDER: 'ecs',
    FLEET_ECS_CONFIG_SSM_PATH: CONFIG_PATH,
  });

  // The daemon still comes up: publishing is best-effort, serving is the job.
  await until(() => daemon.out().includes('fleet daemon: listening on'), `the listen line\n${daemon.out()}\n${daemon.err()}`, 20_000);
  await until(() => daemon.err().includes('operator token publish failed'), `the failure line\n${daemon.err()}`, 20_000);
  assert.ok(existsSync(join(home, 'operator-token')), 'the local token still exists for ecs execute-command recovery');
});
