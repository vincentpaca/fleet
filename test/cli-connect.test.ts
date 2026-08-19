// `fleet connect` (#57): deployment resolution, local-port choice, tunnel
// supervision, and the tunnel state `fleet doctor` reports.
//
// The supervisor is exercised through injected fakes with a virtual clock, so
// every reconnect path (session death, endpoint change, backoff growth and
// reset, a resolution that fails outright) is a real assertion rather than a
// timing-dependent hope. The end-to-end test at the bottom drives the actual
// CLI against a fake `aws` on PATH and a real listener on the local port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TunnelEndpoint } from '../src/providers/provider.ts';
import {
  RECONNECT_BACKOFF_MS,
  HEALTHY_SESSION_MS,
  chooseLocalPort,
  resolveDeployment,
  superviseTunnel,
  tunnelReport,
  writeTunnelRecord,
  readTunnelRecord,
  pidAlive,
  listTunnelRecords,
  clearTunnelRecord,
  HEALTH_INTERVAL_MS,
  type ForwardExit,
  type ForwardHandle,
  type SuperviseDeps,
} from '../src/cli/connect.ts';
import { tunnelOpenerFor } from '../src/cli/tunnel-openers.ts';
import {
  CLI,
  closedPort,
  fakeAwsBin,
  makeTempDir,
  projectWithConfig as projectWith,
  runCli,
  startMockDaemon,
  until,
  waitForLine,
} from './cli-helpers.ts';

// ---------- fixtures ----------

const FULL_CONFIG = {
  provider: 'ecs',
  cluster: 'fleet',
  daemon_service: 'fleet-daemon',
  daemon_container_name: 'fleet-daemon',
  daemon_port: 9000,
  runner_task_definition: 'fleet-runner',
  runner_container_name: 'fleet-runner',
  ssm_config_path: '/fleet/fleet-config',
};

// ---------- deployment resolution ----------

test('resolveDeployment reads the captured fleet-config.json and keeps its daemon_url', async () => {
  const cwd = projectWith({ ...FULL_CONFIG, daemon_url: 'http://127.0.0.1:19000' });
  const deployment = await resolveDeployment(cwd, async () => {
    throw new Error('SSM must not be consulted when the file is complete');
  });
  assert.match(deployment.source, /fleet-config\.json$/);
  assert.equal(deployment.daemonUrl, 'http://127.0.0.1:19000');
  assert.equal(deployment.config.daemon_container_name, 'fleet-daemon');
});

test('resolveDeployment falls back to the SSM parameter when the captured file predates daemon access', async () => {
  // A file captured before the unit described its daemon access is the common
  // case on an existing deployment: re-reading the parameter it already names
  // beats making the operator re-run terraform output.
  const stale = {
    provider: 'ecs',
    cluster: 'fleet',
    runner_task_definition: 'fleet-runner',
    runner_container_name: 'fleet-runner',
    ssm_config_path: '/fleet/fleet-config',
    daemon_url: 'http://127.0.0.1:19000',
  };
  const cwd = projectWith(stale);
  const asked: string[][] = [];
  const deployment = await resolveDeployment(cwd, async (args) => {
    asked.push(args);
    return JSON.stringify({ Parameter: { Value: JSON.stringify(FULL_CONFIG) } });
  });
  assert.deepEqual(asked, [['ssm', 'get-parameter', '--name', '/fleet/fleet-config', '--output', 'json']]);
  assert.match(deployment.source, /SSM parameter \/fleet\/fleet-config/);
  assert.equal(deployment.config.daemon_container_name, 'fleet-daemon');
  // daemon_url lives only in the local file — the SSM read must not drop it.
  assert.equal(deployment.daemonUrl, 'http://127.0.0.1:19000');
});

test('resolveDeployment says how to capture a deployment when there is none', async () => {
  const cwd = makeTempDir('fleet-connect-empty-');
  await assert.rejects(
    () => resolveDeployment(cwd, async () => ''),
    /no deployment found[\s\S]*terraform .*output -json fleet_config/,
  );
});

test('resolveDeployment refuses a config that describes neither daemon access nor a live source', async () => {
  const cwd = projectWith({ provider: 'ecs', cluster: 'fleet' });
  await assert.rejects(
    () => resolveDeployment(cwd, async () => ''),
    /describes no daemon access.*no live source to re-read it from.*re-capture/s,
  );
});

test('resolveDeployment picks the same capture daemonTarget resolves daemon_url from', async () => {
  // Two captured deployments: connect must not tunnel for one while every other
  // command talks to the other's daemon_url.
  const cwd = projectWith({ provider: 'ecs', cluster: 'other', daemon_service: 's', daemon_container_name: 'c', daemon_port: 9000 }, 'aardvark');
  const dir = path.join(cwd, '.fleet', 'infra', 'aws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'fleet-config.json'),
    JSON.stringify({ ...FULL_CONFIG, daemon_url: 'http://127.0.0.1:19000' }),
  );
  const deployment = await resolveDeployment(cwd, async () => '');
  assert.equal(deployment.config.cluster, 'fleet', 'chose the capture carrying daemon_url');
  assert.equal(deployment.daemonUrl, 'http://127.0.0.1:19000');
});

test('resolveDeployment skips a provider directory whose config is malformed', async () => {
  const cwd = projectWith(FULL_CONFIG, 'aws');
  const other = path.join(cwd, '.fleet', 'infra', 'aardvark');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'fleet-config.json'), '{ not json');
  // 'aardvark' sorts first: a malformed capture must not hide a good one.
  const deployment = await resolveDeployment(cwd, async () => '');
  assert.equal(deployment.config.cluster, 'fleet');
});

test('tunnelOpenerFor names the provider it cannot tunnel into', () => {
  assert.throws(
    () =>
      tunnelOpenerFor({
        source: 'somewhere.json',
        config: { provider: 'kubernetes', cluster: 'c', runner_task_definition: 'r', runner_container_name: 'r' },
      }),
    /no tunnel implementation for provider "kubernetes"[\s\S]*connect_hint/,
  );
});

// ---------- local port choice ----------

test('chooseLocalPort follows daemon_url so connect and delegate agree', () => {
  assert.equal(chooseLocalPort(undefined, 'http://127.0.0.1:19000', 9000), 19000);
  // The flag wins over the captured URL.
  assert.equal(chooseLocalPort(15000, 'http://127.0.0.1:19000', 9000), 15000);
  // No daemon_url: fall back to connect_hint's 1<remote> convention.
  assert.equal(chooseLocalPort(undefined, undefined, 9000), 19000);
  assert.equal(chooseLocalPort(undefined, undefined, 8080), 18080);
  // A daemon_url without an explicit port names port 80, not a tunnel.
  assert.equal(chooseLocalPort(undefined, 'http://daemon.internal/', 9000), 19000);
  assert.equal(chooseLocalPort(undefined, 'not a url', 9000), 19000);
});

// ---------- supervision ----------

type FakeSession = {
  /** How long the session lasts, in virtual ms, before its forward exits. */
  lastsMs: number;
  /** Does /health answer during it? */
  healthy: boolean;
  /** The forward command could not be started at all (no aws on PATH). */
  startFailed?: boolean;
};

type Harness = {
  deps: SuperviseDeps;
  /** One entry per resolved endpoint. */
  opened: string[];
  /** argv of each spawned forward. */
  spawned: string[][];
  /** Every backoff/poll wait, in order. */
  slept: number[];
  log: string[];
};

/**
 * Supervisor harness on a virtual clock. `open` hands back a new endpoint id
 * each call (a deployment replaces the daemon task, so a correct supervisor
 * must use the newest one); each forward exits on the next macrotask, having
 * advanced the clock by its session length.
 */
function harness(sessions: FakeSession[], opts: { openFailures?: number } = {}): Harness {
  let clock = 0;
  let started = 0;
  let completed = 0;
  let openCalls = 0;
  const opened: string[] = [];
  const spawned: string[][] = [];
  const slept: number[] = [];
  const log: string[] = [];

  const deps: SuperviseDeps = {
    open: async (localPort): Promise<TunnelEndpoint> => {
      openCalls += 1;
      if (openCalls <= (opts.openFailures ?? 0)) throw new Error('daemon service is not up');
      const id = `ecs:fleet_task-${openCalls}_rt-${openCalls}`;
      opened.push(id);
      return { argv: ['aws', 'ssm', 'start-session', '--target', id, String(localPort)], id };
    },
    spawnForward: (argv): ForwardHandle => {
      spawned.push(argv);
      const session = sessions[started] ?? { lastsMs: 0, healthy: false };
      started += 1;
      const startedAt = clock;
      const exited = new Promise<ForwardExit>((resolve) => {
        setTimeout(() => {
          clock = Math.max(clock, startedAt + session.lastsMs);
          completed += 1;
          resolve(session.startFailed ? { how: 'could not start aws: spawn aws ENOENT', startFailed: true } : { how: 'exit 255' });
        }, 0);
      });
      return { exited, stop: () => {} };
    },
    probeHealth: async () => (sessions[Math.max(0, started - 1)]?.healthy ?? false),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: (line) => log.push(line),
    stopped: () => completed >= sessions.length,
  };
  return { deps, opened, spawned, slept, log };
}

/** Waits the supervisor took between sessions (health polling uses a fixed small interval). */
function backoffs(slept: number[]): number[] {
  return slept.filter((ms) => ms !== HEALTH_INTERVAL_MS);
}

test('the health poll interval is not a backoff value', () => {
  // backoffs() separates the two kinds of wait by value. If they ever collide,
  // every backoff assertion below silently starts counting health polls.
  assert.ok(!RECONNECT_BACKOFF_MS.includes(HEALTH_INTERVAL_MS));
});

test('a dead forward is reopened against a freshly resolved endpoint', async () => {
  // The acceptance case: kill the session-manager-plugin and the tunnel comes
  // back — pointed at whatever task the service is running *now*, because a
  // deployment replaces the task id.
  const h = harness([
    { lastsMs: 100, healthy: true },
    { lastsMs: 100, healthy: true },
    { lastsMs: 100, healthy: true },
  ]);
  await superviseTunnel(19000, h.deps);

  assert.equal(h.spawned.length, 3, 'each death reopened the tunnel');
  assert.deepEqual(h.opened, [
    'ecs:fleet_task-1_rt-1',
    'ecs:fleet_task-2_rt-2',
    'ecs:fleet_task-3_rt-3',
  ]);
  // The forward command must carry the newly resolved target, not the first one.
  assert.equal(h.spawned[1][4], 'ecs:fleet_task-2_rt-2');
  assert.equal(h.spawned[2][4], 'ecs:fleet_task-3_rt-3');
  assert.ok(
    h.log.some((line) => line.includes('daemon /health ok on http://127.0.0.1:19000')),
    `health confirmed per session: ${h.log.join(' | ')}`,
  );
});

test('a stop during endpoint resolution spawns nothing and records nothing', async () => {
  // Resolving costs seconds of cloud calls, and an owner can quit inside them:
  // the cockpit closing, or `fleet connect` taking a SIGINT. Spawning anyway
  // leaves a detached forward holding the local port with nobody left to kill
  // it, over a session record the stop had already cleared — and the supervisor
  // then blocks forever on that handle, so its owner never exits either.
  let stopped = false;
  const spawned: string[][] = [];
  const sessions: string[] = [];
  await superviseTunnel(19000, {
    open: async (localPort) => {
      stopped = true; // the operator quit while we were resolving
      return { argv: ['aws', 'ssm', 'start-session', String(localPort)], id: 'ecs:fleet_task-1_rt-1' };
    },
    spawnForward: (argv) => {
      spawned.push(argv);
      // Resolves, so a regression fails on the assertions below instead of
      // hanging the suite the way the real forward hangs the real supervisor.
      return { exited: Promise.resolve({ how: 'exit 0' }), stop: () => {} };
    },
    probeHealth: async () => true,
    sleep: async () => {},
    now: () => 0,
    log: () => {},
    stopped: () => stopped,
    onSession: (endpoint) => sessions.push(endpoint.id),
  });
  assert.deepEqual(spawned, [], 'nothing was forwarded after the stop');
  assert.deepEqual(sessions, [], 'and nothing claimed to be a live session');
});

test('backoff grows across consecutive short sessions', async () => {
  const h = harness([
    { lastsMs: 10, healthy: false },
    { lastsMs: 10, healthy: false },
    { lastsMs: 10, healthy: false },
  ]);
  await superviseTunnel(19000, h.deps);
  assert.deepEqual(backoffs(h.slept).slice(0, 2), [RECONNECT_BACKOFF_MS[0], RECONNECT_BACKOFF_MS[1]]);
});

test('a session that stayed up resets the backoff', async () => {
  // Otherwise a tunnel that ran for hours and then hit an SSM timeout is
  // reopened at the 30s ceiling, and the operator waits for no reason.
  const h = harness([
    { lastsMs: 10, healthy: true },
    { lastsMs: 10, healthy: true },
    { lastsMs: HEALTHY_SESSION_MS + 1_000, healthy: true },
    { lastsMs: 10, healthy: true },
    { lastsMs: 10, healthy: true },
  ]);
  await superviseTunnel(19000, h.deps);
  // The supervisor stops after the last session, so the final wait is not taken.
  assert.deepEqual(
    backoffs(h.slept),
    [RECONNECT_BACKOFF_MS[0], RECONNECT_BACKOFF_MS[1], RECONNECT_BACKOFF_MS[0], RECONNECT_BACKOFF_MS[0]],
    'escalates while sessions die young, and starts over after one that held',
  );
});

test('a resolution failure is retried with backoff, not fatal', async () => {
  // force-new-deployment leaves the service with no running task for a while.
  // Exiting there would put the operator back to hand-run aws commands.
  const h = harness([{ lastsMs: 10, healthy: true }], { openFailures: 2 });
  await superviseTunnel(19000, h.deps);
  assert.equal(h.spawned.length, 1, 'the tunnel opened once resolution succeeded');
  assert.equal(h.opened[0], 'ecs:fleet_task-3_rt-3', 'it used the endpoint from the successful attempt');
  assert.ok(
    h.log.some((line) => line.includes('cannot resolve the daemon endpoint: daemon service is not up')),
    `resolution failures are reported: ${h.log.join(' | ')}`,
  );
  assert.deepEqual(backoffs(h.slept).slice(0, 2), [RECONNECT_BACKOFF_MS[0], RECONNECT_BACKOFF_MS[1]]);
});

test('a forward that cannot start at all stops the supervisor instead of looping', async () => {
  // No aws on PATH, or no session-manager-plugin: reopening every 30s forever
  // would read as a flaky tunnel. It is a missing tool, and waiting cannot fix it.
  const h = harness([{ lastsMs: 0, healthy: false, startFailed: true }, { lastsMs: 10, healthy: true }]);
  await assert.rejects(() => superviseTunnel(19000, h.deps), /could not start aws/);
  assert.equal(h.spawned.length, 1, 'it did not try again');
});

test('a forward that never serves /health is reported but still supervised', async () => {
  const h = harness([{ lastsMs: 10, healthy: false }]);
  await superviseTunnel(19000, h.deps);
  assert.ok(
    h.log.some((line) => line.includes('/health did not answer')),
    `a silent tunnel is named: ${h.log.join(' | ')}`,
  );
});

// ---------- doctor: tunnel state ----------

test('tunnelReport says the tunnel is fine when /health answers', async (t) => {
  const daemon = await startMockDaemon({
    'GET /health': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  t.after(() => daemon.close());
  const port = Number(new URL(daemon.url).port);
  const report = await tunnelReport({ host: '127.0.0.1', port, url: daemon.url, home: makeTempDir('fleet-tun-') });
  assert.deepEqual(report.findings, []);
  assert.ok(report.notes.some((n) => n.includes('/health ok')), report.notes.join(' | '));
});

test('tunnelReport distinguishes a closed port from a forward onto a dead task', async (t) => {
  const port = await closedPort();
  const closed = await tunnelReport({
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    home: makeTempDir('fleet-tun-'),
  });
  assert.equal(closed.findings.length, 1);
  assert.match(closed.findings[0], /nothing is listening.*fleet connect/);

  // Something answers TCP but is not a serving daemon: exactly what a forward
  // left open onto a replaced task looks like. Reporting it as "no tunnel"
  // would send the operator to reopen a tunnel that is already there.
  const stale = await startMockDaemon({});
  t.after(() => stale.close());
  const stalePort = Number(new URL(stale.url).port);
  const report = await tunnelReport({
    host: '127.0.0.1',
    port: stalePort,
    url: stale.url,
    home: makeTempDir('fleet-tun-'),
  });
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0], /accepts connections but the daemon did not answer \/health/);
});

test('tunnelReport reports a dead connect session and a redeployed daemon task', async (t) => {
  const port = await closedPort();
  const home = makeTempDir('fleet-tun-');
  writeTunnelRecord(home, {
    port,
    pid: 999_999_999, // no such process
    endpointId: 'ecs:fleet_task-old_rt-old',
    source: 'fleet-config.json',
    at: '2026-08-19T00:00:00.000Z',
  });
  const report = await tunnelReport({
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    home,
    resolveEndpoint: async () => 'ecs:fleet_task-new_rt-new',
  });
  assert.ok(
    report.findings.some((f) => /last fleet connect session .*is gone/.test(f)),
    report.findings.join(' | '),
  );
  // The point of the third question: the operator learns the service rolled,
  // instead of guessing why a tunnel that "was working" stopped.
  assert.ok(
    report.findings.some((f) => /task-old.*task-new.*redeployed/s.test(f)),
    report.findings.join(' | '),
  );
});

test('tunnelReport treats an unanswerable currency check as a note, not a finding', async () => {
  const port = await closedPort();
  const home = makeTempDir('fleet-tun-');
  writeTunnelRecord(home, {
    port,
    pid: 999_999_999,
    endpointId: 'ecs:fleet_task-old_rt-old',
    source: 'fleet-config.json',
    at: '2026-08-19T00:00:00.000Z',
  });
  const report = await tunnelReport({
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    home,
    resolveEndpoint: async () => {
      throw new Error('could not connect to the endpoint URL');
    },
  });
  assert.ok(report.notes.some((n) => /could not check whether the daemon task is current/.test(n)));
  assert.ok(!report.findings.some((f) => /could not check/.test(f)), 'not knowing is not a defect');
});

// ---------- end to end: the real CLI, a fake aws, a real local port ----------

test('fleet connect opens the tunnel, verifies /health, and re-establishes on session death', async (t) => {
  // The two acceptance cases in one run: /health green with zero hand-run aws
  // commands, and — after the forward dies and the service has replaced the
  // task — a reopened session pointed at the new task id, no operator input.
  const daemon = await startMockDaemon({
    'GET /health': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  t.after(() => daemon.close());
  // The daemon stands in for the far end. The local port starts free, and the
  // forward's own grandchild binds it and proxies — so /health goes THROUGH the
  // tunnel, and the port-collision guard sees the same thing it sees in life.
  const localPort = await closedPort();

  const cwd = projectWith({
    provider: 'ecs',
    cluster: 'fleet',
    daemon_service: 'fleet-daemon',
    daemon_container_name: 'fleet-daemon',
    daemon_port: 9000,
    runner_task_definition: 'fleet-runner',
    runner_container_name: 'fleet-runner',
    daemon_url: `http://127.0.0.1:${localPort}`,
  });
  const state = path.join(makeTempDir('fleet-connect-state-'), 'aws');
  const bin = fakeAwsBin(state);
  fs.writeFileSync(path.join(state, 'die-first'), ''); // the first session crashes
  const home = makeTempDir('fleet-connect-home-');

  const child = spawn(process.execPath, [CLI, 'connect'], {
    cwd,
    env: {
      ...process.env,
      FLEET_DAEMON_URL: undefined,
      FLEET_HOME: home,
      FAKE_AWS_DIR: state,
      FAKE_AWS_TARGET_PORT: new URL(daemon.url).port,
      PATH: `${bin}:${process.env.PATH}`,
    } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (output += c));
  child.stderr.on('data', (c: string) => (output += c));
  t.after(() => {
    child.kill('SIGKILL');
  });

  // First session: resolved from the fake deployment, /health green.
  await waitForLine(() => output, child, `daemon /health ok on http://127.0.0.1:${localPort}`, 'the first health check');
  assert.match(output, /forwarding http:\/\/127\.0\.0\.1:\d+ → ecs:fleet_task-1_rt-1/);

  // The session died on its own; the supervisor must come back on the task the
  // service is running now, without anyone typing an aws command.
  const sessionsLog = path.join(state, 'sessions.log');
  const sessions = (): string[][] =>
    fs.readFileSync(sessionsLog, 'utf8').trim().split('\n').map((line) => line.split(' '));
  await waitForLine(() => output, child, 'ecs:fleet_task-2_rt-2', 'the reopened session');
  await until(() => sessions().length === 2, 'a second port-forward to start');
  assert.deepEqual(
    sessions().map(([target]) => target),
    ['ecs:fleet_task-1_rt-1', 'ecs:fleet_task-2_rt-2'],
  );
  // The launcher and the process actually holding the forward, as the real
  // `aws ssm start-session` / session-manager-plugin pair.
  const [, launcherPid, holderPid] = sessions()[1].map(Number);
  t.after(() => {
    for (const pid of [launcherPid, holderPid]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already reaped — the good case
      }
    }
  });

  // A live session is on record, so doctor can explain a later failure.
  const recordPath = path.join(home, 'tunnels', `${localPort}.json`);
  await until(
    () => fs.existsSync(recordPath) && JSON.parse(fs.readFileSync(recordPath, 'utf8')).endpointId === 'ecs:fleet_task-2_rt-2',
    'the tunnel record to name the reopened endpoint',
  );
  assert.equal(JSON.parse(fs.readFileSync(recordPath, 'utf8')).pid, child.pid);

  const closed = Promise.withResolvers<number | null>();
  child.on('close', (code) => closed.resolve(code));
  child.kill('SIGINT');
  assert.equal(await closed.promise, 0, `clean shutdown; output:\n${output}`);
  assert.ok(!fs.existsSync(path.join(home, 'tunnels', `${localPort}.json`)), 'the record is cleared on exit');
  // The launcher is not the process holding the port — session-manager-plugin
  // is, and it is a grandchild. Signalling the launcher alone orphans it, the
  // port stays bound, and the next connect looks like it worked while pointing
  // into a container that is gone. Both have to be gone.
  await until(() => !pidAlive(launcherPid), 'the forward launcher to be gone');
  await until(() => !pidAlive(holderPid), 'the process holding the forward to be gone');
});

test('fleet connect --detach hands the tunnel to a background supervisor', async (t) => {
  const daemon = await startMockDaemon({
    'GET /health': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  t.after(() => daemon.close());
  const localPort = await closedPort();

  const cwd = projectWith({ ...FULL_CONFIG, daemon_url: `http://127.0.0.1:${localPort}` });
  const state = path.join(makeTempDir('fleet-connect-state-'), 'aws');
  const bin = fakeAwsBin(state);
  const home = makeTempDir('fleet-connect-home-');

  const res = await runCli(['connect', '--detach'], {
    cwd,
    env: {
      FLEET_HOME: home,
      FAKE_AWS_DIR: state,
      FAKE_AWS_TARGET_PORT: new URL(daemon.url).port,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  assert.equal(res.code, 0, `detach returned cleanly; stderr:\n${res.stderr}`);
  const pid = Number(/pid (\d+)/.exec(res.stdout)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, `names the background pid: ${res.stdout}`);
  // SIGTERM, not SIGKILL: the supervisor's handler is what group-kills its
  // forward, and the forward is in its own group. SIGKILLing the supervisor
  // here would leak the launcher and the port-holding grandchild every run —
  // the very failure this feature exists to prevent, in its own teardown.
  t.after(async () => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await until(() => !pidAlive(pid), 'the background supervisor to exit', 5_000).catch(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // nothing left
      }
    });
  });

  // The parent exited; the supervisor it left behind must reach a live tunnel
  // on its own, and say so in the log file the parent named.
  const logPath = path.join(home, `connect-${localPort}.log`);
  assert.match(res.stdout, new RegExp(logPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await until(
    () => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('daemon /health ok'),
    `the background supervisor to reach /health (log: ${logPath})`,
  );
  const record = readTunnelRecord(home, localPort);
  assert.equal(record?.pid, pid, 'the record names the background supervisor, not the parent');

  // With a tunnel live on that port, a second connect must refuse rather than
  // probe the first one's port, report itself healthy, and take over the record.
  const second = await runCli(['connect'], {
    cwd,
    env: {
      FLEET_HOME: home,
      FAKE_AWS_DIR: state,
      FAKE_AWS_TARGET_PORT: new URL(daemon.url).port,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  assert.equal(second.code, 1, `refused; stdout:\n${second.stdout}`);
  assert.match(second.stderr, new RegExp(`port ${localPort} is already taken and answers /health`));
  assert.match(second.stderr, new RegExp(`pid ${pid}`), 'names the session that has it');
  assert.equal(readTunnelRecord(home, localPort)?.pid, pid, 'the live session still owns the record');

  // Same port, but nothing on record — a connect_hint tunnel opened by hand, or
  // an orphan a SIGKILLed supervisor left behind. Refusing has to depend on the
  // port, not on our own bookkeeping: probing it would answer from the tunnel
  // that is already there and report a forward that never bound as healthy.
  const noRecordHome = makeTempDir('fleet-connect-home-');
  const third = await runCli(['connect'], {
    cwd,
    env: {
      FLEET_HOME: noRecordHome,
      FAKE_AWS_DIR: state,
      FAKE_AWS_TARGET_PORT: new URL(daemon.url).port,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  assert.equal(third.code, 1, `refused without a record; stdout:\n${third.stdout}`);
  assert.match(third.stderr, /something else — `fleet doctor` reports what is there/);
});

// ---------- tunnel records ----------

test('clearTunnelRecord leaves another session\'s record alone', () => {
  // A second `fleet connect` on a held port must not delete the live session's
  // record on its way out — that record is what doctor explains failures with.
  const home = makeTempDir('fleet-tun-');
  writeTunnelRecord(home, {
    port: 19000,
    pid: 4242,
    endpointId: 'ecs:fleet_task-1_rt-1',
    source: 'fleet-config.json',
    at: '2026-08-19T00:00:00.000Z',
  });
  clearTunnelRecord(home, 19000, 9999);
  assert.equal(readTunnelRecord(home, 19000)?.pid, 4242, 'someone else\'s record survives');
  clearTunnelRecord(home, 19000, 4242);
  assert.equal(readTunnelRecord(home, 19000), undefined, 'our own record is cleared');
});

test('listTunnelRecords reads every session, and nothing when there are none', () => {
  const home = makeTempDir('fleet-tun-');
  assert.deepEqual(listTunnelRecords(home), []);
  for (const port of [19000, 15000]) {
    writeTunnelRecord(home, {
      port,
      pid: process.pid,
      endpointId: `ecs:fleet_task-${port}_rt`,
      source: 'fleet-config.json',
      at: '2026-08-19T00:00:00.000Z',
    });
  }
  fs.writeFileSync(path.join(home, 'tunnels', 'notes.txt'), 'ignored');
  fs.writeFileSync(path.join(home, 'tunnels', '404.json'), '{ not json');
  assert.deepEqual(listTunnelRecords(home).map((r) => r.port), [15000, 19000]);
});

test('tunnelReport points at a live session on a different port', async () => {
  // `fleet connect --port X` while daemon_url names Y: doctor said "nothing is
  // listening, open it with fleet connect" while a supervisor was up.
  const port = await closedPort();
  const home = makeTempDir('fleet-tun-');
  writeTunnelRecord(home, {
    port: port + 1,
    pid: process.pid, // alive
    endpointId: 'ecs:fleet_task-1_rt-1',
    source: 'fleet-config.json',
    at: '2026-08-19T00:00:00.000Z',
  });
  const report = await tunnelReport({ host: '127.0.0.1', port, url: `http://127.0.0.1:${port}`, home });
  assert.ok(
    report.notes.some((n) => n.includes(`running on port ${port + 1}`)),
    report.notes.join(' | '),
  );
});

test('tunnelReport answers the currency question for a hand-opened tunnel too', async () => {
  // connect_hint stays supported, and a forward opened that way writes no
  // record — it is exactly the tunnel that outlives a redeployment silently.
  const port = await closedPort();
  const report = await tunnelReport({
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    home: makeTempDir('fleet-tun-'),
    resolveEndpoint: async () => 'ecs:fleet_task-new_rt-new',
  });
  // Nothing is listening, so it must NOT claim a stale forward exists — that
  // would contradict the finding one line above it.
  assert.ok(
    report.notes.some((n) =>
      n.includes('the daemon task is currently ecs:fleet_task-new_rt-new — open a forward to it with: fleet connect'),
    ),
    report.notes.join(' | '),
  );
});
