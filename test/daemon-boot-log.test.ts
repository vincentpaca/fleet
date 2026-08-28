// The daemon's boot evidence (#53): four terse lines on stdout — FLEET_HOME,
// provider, config source, listen address — and nothing per-request.
// #9's bring-up could not tell "listening" from "stuck before bind" because a
// running task logged nothing, so these lines only count if the real entrypoint
// emits them: this suite spawns src/daemon/main.ts rather than a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { TestContext } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const daemonMain = join(here, '..', 'src', 'daemon', 'main.ts');

const BOOT_TIMEOUT_MS = 20_000;

type Daemon = {
  /** stdout lines emitted so far, in order. */
  lines: () => string[];
  stderr: () => string;
  /** Resolve with the first stdout line matching `re` (waits for it to arrive). */
  waitFor: (re: RegExp) => Promise<string>;
  exited: Promise<number>;
};

/** Temp dir removed when the test ends — tests own their state, on disk too. */
function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Spawn the daemon entrypoint with an explicit env — never the test runner's,
 * so a FLEET_* or AWS_* var on the host machine cannot change what boots.
 */
function spawnDaemon(t: TestContext, env: Record<string, string>): Daemon {
  const child: ChildProcess = spawn(process.execPath, [daemonMain], {
    cwd: tempDir(t, 'fleet-boot-cwd-'),
    env: { PATH: process.env.PATH ?? '', HOME: tempDir(t, 'fleet-boot-hm-'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const waiters: Array<{ re: RegExp; resolve: (line: string) => void }> = [];
  const lines = (): string[] => out.split('\n').filter((line) => line.length > 0);
  const settle = (): void => {
    for (const waiter of [...waiters]) {
      const hit = lines().find((line) => waiter.re.test(line));
      if (hit !== undefined) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(hit);
      }
    }
  };
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    out += chunk;
    settle();
  });
  child.stderr!.on('data', (chunk: string) => {
    err += chunk;
  });
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
  t.after(async () => {
    child.kill('SIGTERM');
    await exited;
  });

  return {
    lines,
    stderr: () => err,
    exited,
    waitFor: (re) => {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      waiters.push({ re, resolve });
      settle();
      // A boot line that never arrives is the failure this suite exists to
      // catch, so time out loudly with everything the daemon did say.
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${re}\nstdout:\n${out}\nstderr:\n${err}`));
      }, BOOT_TIMEOUT_MS);
      return promise.finally(() => clearTimeout(timer));
    },
  };
}

test('boot log states home, provider, config source and the bound TCP address', async (t) => {
  const home = tempDir(t, 'fleet-boot-home-');
  // Cheap regression guard: today the daemon never reads either at boot, so this
  // pair cannot fail — the load-bearing no-secrets check is the ecs test below,
  // where the values are in memory when the lines are written.
  const webhook = 'https://hooks.invalid/services/T000/B000/s3cret-token';
  const awsSecret = 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY';
  const daemon = spawnDaemon(t, {
    FLEET_HOME: home,
    FLEET_PORT: '0', // ephemeral port: the bound port is only knowable from the log
    FLEET_PROVIDER: 'process',
    FLEET_NOTIFY_WEBHOOK: webhook,
    AWS_SECRET_ACCESS_KEY: awsSecret,
  });

  const listening = await daemon.waitFor(/listening on/);
  const lines = daemon.lines();

  assert.deepEqual(lines.slice(0, 3), [
    `fleet daemon: home ${home}`,
    'fleet daemon: provider process',
    'fleet daemon: config source none',
  ], `boot lines missing or reordered:\n${lines.join('\n')}`);

  // The listen line must name the socket path and the real bound address, and
  // the provider must already be known by then (acceptance: before the first
  // request). Proven by using the logged port as the only way to reach it.
  assert.ok(
    listening.startsWith(`fleet daemon: listening on ${join(home, 'daemon.sock')} and 127.0.0.1:`),
    `listen line names the wrong socket or bind host: ${listening}`,
  );
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(listening)![1]);
  assert.ok(port > 0, 'listen line carries no bound port');
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  await health.json();

  // Boot evidence only: serving a request adds no lines.
  assert.deepEqual(daemon.lines(), lines, 'daemon logged per-request output');

  for (const secret of [webhook, awsSecret]) {
    assert.ok(!daemon.lines().join('\n').includes(secret), 'boot log leaked a secret');
    assert.ok(!daemon.stderr().includes(secret), 'daemon stderr leaked a secret');
  }
});

test('boot log names the SSM parameter as config source, never its contents', async (t) => {
  const home = tempDir(t, 'fleet-boot-ssm-home-');
  const ssmPath = '/fleet/test/config';
  const cluster = 'fleet-test-cluster';
  // Fake `aws` so the ecs branch resolves without a cloud account. Its output is
  // the config the daemon holds at boot — none of it belongs in the log.
  const binDir = tempDir(t, 'fleet-boot-bin-');
  const fleetConfig = JSON.stringify({
    cluster,
    runner_task_definition: 'fleet-test-runner:1',
    runner_container_name: 'runner',
    subnets: ['subnet-0123456789abcdef0'],
    security_groups: ['sg-0123456789abcdef0'],
  });
  writeFileSync(
    join(binDir, 'aws'),
    `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ Parameter: { Value: fleetConfig } })}\nEOF\n`,
    { mode: 0o755 },
  );
  const daemon = spawnDaemon(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FLEET_HOME: home,
    FLEET_PORT: '0',
    FLEET_PROVIDER: 'ecs',
    FLEET_ECS_CONFIG_SSM_PATH: ssmPath,
  });

  await daemon.waitFor(/listening on/);
  const log = daemon.lines().join('\n');
  assert.deepEqual(daemon.lines().slice(0, 3), [
    `fleet daemon: home ${home}`,
    'fleet daemon: provider ecs',
    `fleet daemon: config source ssm:${ssmPath}`,
  ], `boot lines missing or reordered:\n${log}`);
  for (const value of [cluster, 'subnet-0123456789abcdef0', 'sg-0123456789abcdef0']) {
    assert.ok(!log.includes(value), `boot log leaked fleet_config value ${value}`);
  }
});

test('boot log precedes creating FLEET_HOME, which is a network mount in ECS', async (t) => {
  // FLEET_HOME is an EFS mount on the daemon task: mkdir there can hang (NFS) or
  // fail, both before any bind. The home line has to be out before that syscall
  // or the operator is back to guessing. Unusable home stands in for the hang.
  const dir = tempDir(t, 'fleet-boot-nothome-');
  writeFileSync(join(dir, 'not-a-dir'), 'occupied\n');
  const home = join(dir, 'not-a-dir', 'fleet');
  const daemon = spawnDaemon(t, { FLEET_HOME: home, FLEET_PORT: '0', FLEET_PROVIDER: 'process' });

  const code = await daemon.exited;
  assert.notEqual(code, 0, 'daemon should fail when FLEET_HOME cannot be created');
  assert.deepEqual(daemon.lines(), [
    `fleet daemon: home ${home}`,
    'fleet daemon: provider process',
    'fleet daemon: config source none',
  ], `boot lines lost when FLEET_HOME is unusable:\n${daemon.lines().join('\n')}\nstderr:\n${daemon.stderr()}`);
});

test('boot log precedes a failing provider build, so a stuck boot is diagnosable', async (t) => {
  // The #9 failure mode: the provider cannot be built (here: no `aws` on PATH)
  // and the daemon never binds. The three boot lines must still be on stdout —
  // that is what distinguishes "stuck before bind" from a silent crash-loop.
  const home = tempDir(t, 'fleet-boot-fail-home-');
  const binDir = tempDir(t, 'fleet-boot-emptybin-');
  const daemon = spawnDaemon(t, {
    PATH: binDir, // deliberately empty: `aws` is unreachable
    FLEET_HOME: home,
    FLEET_PORT: '0',
    FLEET_PROVIDER: 'ecs',
    FLEET_ECS_CONFIG_SSM_PATH: '/fleet/test/config',
  });

  const code = await daemon.exited;
  assert.notEqual(code, 0, 'daemon should fail when its provider config is unreadable');
  assert.deepEqual(daemon.lines(), [
    `fleet daemon: home ${home}`,
    'fleet daemon: provider ecs',
    'fleet daemon: config source ssm:/fleet/test/config',
  ], `boot lines lost on a failing boot:\n${daemon.lines().join('\n')}\nstderr:\n${daemon.stderr()}`);
});

test('an explicit FLEET_DAEMON_HOST widens the bind past loopback (#185)', async (t) => {
  // The one real behavior change GCP support makes to the composition root:
  // the unit's env file sets FLEET_DAEMON_HOST to the reserved internal
  // address, and a daemon that advertises it while binding 127.0.0.1 is
  // unreachable by every job and by the IAP tunnel alike. Before #185 only
  // the ECS-metadata branch widened the bind — this test fails on that code.
  const home = tempDir(t, 'fleet-boot-widen-home-');
  const daemon = spawnDaemon(t, {
    FLEET_HOME: home,
    FLEET_PORT: '0',
    FLEET_PROVIDER: 'process',
    FLEET_DAEMON_HOST: '10.128.0.5',
  });

  const listening = await daemon.waitFor(/listening on/);
  assert.match(
    listening,
    / and 0\.0\.0\.0:\d+ \(advertising 10\.128\.0\.5\)$/,
    `an explicit non-loopback FLEET_DAEMON_HOST must bind 0.0.0.0: ${listening}`,
  );
  // 0.0.0.0 includes loopback, so the logged port is still reachable locally —
  // the same proof-by-use the default-bind test above makes.
  const port = Number(/0\.0\.0\.0:(\d+)/.exec(listening)![1]);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  await health.json();
});

test('a loopback FLEET_DAEMON_HOST does not widen the bind (#185)', async (t) => {
  // Advertising 127.0.0.1 wants no wider listener: widening on any explicit
  // value would turn every local override into an all-interfaces bind.
  const home = tempDir(t, 'fleet-boot-loop-home-');
  const daemon = spawnDaemon(t, {
    FLEET_HOME: home,
    FLEET_PORT: '0',
    FLEET_PROVIDER: 'process',
    FLEET_DAEMON_HOST: '127.0.0.1',
  });

  const listening = await daemon.waitFor(/listening on/);
  assert.match(
    listening,
    / and 127\.0\.0\.1:\d+ \(advertising 127\.0\.0\.1\)$/,
    `a loopback FLEET_DAEMON_HOST must keep the loopback bind: ${listening}`,
  );
});

test('a gcp daemon boots from env config, serves, and survives a failed token publish (#185)', async (t) => {
  // The GCP unit's daemon.env in miniature: provider gcp, config entirely from
  // FLEET_GCP_* env (config source "env" — there is no SSM-fetch analog), the
  // widened bind, and a best-effort Secret Manager publish. The fake gcloud
  // refuses the publish: a daemon that serves but could not publish is
  // strictly better than one that is down, so the failure is one stderr line
  // pointing at the IAP fallback, never an exit.
  const home = tempDir(t, 'fleet-boot-gcp-home-');
  const binDir = tempDir(t, 'fleet-boot-gcp-bin-');
  writeFileSync(
    join(binDir, 'gcloud'),
    '#!/bin/sh\necho "ERROR: (gcloud.secrets.versions.add) PERMISSION_DENIED" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  const daemon = spawnDaemon(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FLEET_HOME: home,
    FLEET_PORT: '0',
    FLEET_PROVIDER: 'gcp',
    FLEET_DAEMON_HOST: '10.128.0.5',
    FLEET_GCP_PROJECT: 'mock-project',
    FLEET_GCP_REGION: 'us-central1',
    FLEET_GCP_JOB: 'fleet-runner',
    FLEET_GCP_TOKEN_SECRET: 'fleet-operator-token',
  });

  const listening = await daemon.waitFor(/listening on/);
  assert.deepEqual(daemon.lines().slice(0, 3), [
    `fleet daemon: home ${home}`,
    'fleet daemon: provider gcp',
    'fleet daemon: config source env',
  ], `boot lines missing or reordered:\n${daemon.lines().join('\n')}`);
  assert.match(listening, / and 0\.0\.0\.0:\d+ \(advertising 10\.128\.0\.5\)$/);

  // The publish failed, the daemon did not: /health answers, stderr names the
  // fallback path, and no token value leaked to either stream.
  await daemon.waitFor(/listening on/);
  const port = Number(/0\.0\.0\.0:(\d+)/.exec(listening)![1]);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  await health.json();
  // The publish is best-effort but not silent — wait for its stderr line.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (!daemon.stderr().includes('operator token publish failed') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(daemon.stderr(), /operator token publish failed/, daemon.stderr());
  assert.match(daemon.stderr(), /IAP SSH/, 'the failure must name the by-hand fallback');
  const token = readFileSync(join(home, 'operator-token'), 'utf8').trim();
  assert.ok(token.length > 0, 'the daemon minted its token locally regardless');
  assert.ok(!daemon.lines().join('\n').includes(token), 'boot log must not leak the token');
  assert.ok(!daemon.stderr().includes(token), 'stderr must not leak the token');
});
