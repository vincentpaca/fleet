/**
 * Cancel teardown (issue #111): the runner's signal handler does a real
 * teardown instead of killTree(SIGTERM) + process.exit(1).
 *
 * 1. SIGTERM during an active run: the harness process tree is verifiably
 *    dead (including a SIGTERM-trapping child), and when commits exist a WIP
 *    push was attempted — all inside a bounded deadline.
 * 2. A harness that fails to start (exit 127) produces a settle/log, not a
 *    crash — proving the synthetic exit-code path the 'error' handler uses.
 * 3. watcher.stop() returns promptly with a long-poll in flight.
 * 4. watcher.stop() aborts a long-poll even when the daemon holds the connection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockDaemon, type PostedEvent } from './runner-mock-daemon.ts';
import { EventSink } from '../src/runner/events.ts';
import { DecisionWatcher } from '../src/runner/decisions.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
const cancelHarness = fileURLToPath(new URL('../fixtures/cancel-harness.mjs', import.meta.url));

const IDENTITY = ['-c', 'user.name=Operator One', '-c', 'user.email=op@example.com'];

async function waitFor(done: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(25);
  }
}

function heartbeat(workspace: string, who: 'harness' | 'child'): string {
  try {
    return readFileSync(join(workspace, '.fleet', 'out', `heartbeat-${who}`), 'utf8');
  } catch {
    return '';
  }
}

/** A bare remote seeded with main — the job branch and the WIP push land here. */
function makeRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cancel-git-'));
  const bare = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  execFileSync('git', [...IDENTITY, 'add', '-A'], { cwd: seed });
  execFileSync('git', [...IDENTITY, 'commit', '-q', '-m', 'seed'], { cwd: seed });
  execFileSync('git', [...IDENTITY, 'push', '-q', bare, 'main'], { cwd: seed });
  return bare;
}

function writeWorkspace(limits: Record<string, string>, target = '111'): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-cancel-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  writeFileSync(
    join(workspace, '.fleet', 'manifest.json'),
    JSON.stringify({
      version: 1,
      setup: { image: 'node:22' },
      workspace: { repo: 'origin', strategy: 'branch-per-job' },
      harness: {
        cli: 'claude-code',
        commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
      },
      gates: { pickup: 'node -e "process.exit(0)"' },
      limits,
    }),
  );
  writeFileSync(join(workspace, '.fleet', 'order.json'), JSON.stringify({ target }));
  return workspace;
}

function spawnRunner(env: Record<string, string>): {
  child: ReturnType<typeof spawn>;
  exitCode: Promise<number>;
} {
  const { FLEET_GIT_URL: _u, FLEET_GIT_NAME: _n, FLEET_GIT_EMAIL: _e, ...parentEnv } = process.env;
  const child = spawn(process.execPath, [runnerMain], {
    env: { ...parentEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));
  return { child, exitCode: exited.promise };
}

const logTexts = (events: PostedEvent[]): string[] =>
  events.filter((e) => e.type === 'log').map((e) => String(e.text));

const VALID_DECISION = {
  question: 'Should we proceed?',
  options: [
    { id: 'yes', label: 'Yes', recommended: true },
    { id: 'no', label: 'No' },
  ],
};

// --- 1: SIGTERM during an active run — tree dead, WIP pushed, bounded -------

test('cancel: SIGTERM during an active run kills the SIGTERM-trapping tree, pushes WIP, and settles within a deadline', async () => {
  const token = 'cancel-token-1';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const workspace = writeWorkspace({ idle: '60s' });
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-cancel-1',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_GIT_URL: remote,
    FLEET_GIT_NAME: 'Operator One',
    FLEET_GIT_EMAIL: 'op@example.com',
    FLEET_HARNESS_CMD: `node ${cancelHarness}`,
    FLEET_WALL_CLOCK_GRACE_MS: '500',
    // Tight cancel deadline so the test is bounded; the teardown must
    // complete (kill + WIP push + settle) inside this window.
    FLEET_CANCEL_DEADLINE_MS: '3000',
  });
  try {
    // Prove the tree is up and beating BEFORE the cancel.
    await waitFor(
      () => heartbeat(workspace, 'harness') !== '' && heartbeat(workspace, 'child') !== '',
      'the harness and its child to beat at least once',
    );

    // Send SIGTERM — the provider's terminate signal.
    assert.ok(child.pid !== undefined);
    process.kill(child.pid, 'SIGTERM');

    // The runner must exit within a bounded time — not hang forever.
    const outcome = await Promise.race([
      exitCode.then((code) => `exit ${code}`),
      sleep(15_000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'exit 1', 'the cancel path must terminate the runner within a deadline');

    // The whole tree is dead: a SIGTERM-trapping harness is killed by the
    // SIGKILL escalation. Heartbeats must stop advancing.
    const before = { harness: heartbeat(workspace, 'harness'), child: heartbeat(workspace, 'child') };
    assert.notEqual(before.harness, '', 'fixture must have beaten at least once');
    assert.notEqual(before.child, '', 'the child must have beaten at least once');
    // Integration test: real child processes with real heartbeat files —
    // a fixed sleep is the only way to prove the heartbeats stopped.
    await sleep(1_000);
    assert.equal(heartbeat(workspace, 'harness'), before.harness, 'harness kept running after cancel');
    assert.equal(heartbeat(workspace, 'child'), before.child, 'child kept running after cancel');

    // A settle was emitted — the cancel path does not skip it.
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'a settle event must be emitted on cancel');

    // The state is cancelled.
    const last = daemon.events.at(-1);
    assert.ok(last);
    assert.equal(last.type, 'state');
    assert.equal(last.state, 'cancelled');

    // WIP was pushed — the harness produced partial-work.txt before the cancel.
    assert.ok(
      logTexts(daemon.events).some((text) => text.startsWith('wip pushed to')),
      `expected a wip push log; got ${JSON.stringify(logTexts(daemon.events))}`,
    );
    const branch = 'fleet/111-job-cancel-1';
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
      cwd: remote,
      encoding: 'utf8',
    });
    assert.match(files, /partial-work\.txt/, 'the WIP commit must be on the remote');
  } finally {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(workspace, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- 2: a failed harness start produces a settle/log, not a crash -----------
//
// The 'error' event (EMFILE/EAGAIN at exec time) resolves the exit promise
// with code 127 — the same code the shell returns for "command not found."
// Both paths feed the same teardown: settle PARTIAL + state cancelled. A
// non-existent command exercises that code path end to end.

test('cancel: a failed harness start produces a settle/log, not an uncaught crash', async () => {
  const token = 'cancel-token-2';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace({ idle: '60s' });
  try {
    const code = await spawnRunner({
      FLEET_JOB_ID: 'job-cancel-spawn',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: 'this-command-does-not-exist-anywhere-12345',
      FLEET_WALL_CLOCK_GRACE_MS: '500',
    }).exitCode;

    assert.equal(code, 1, 'runner exits 1 on a failed harness, not a crash');

    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'a settle event must be emitted even when the harness fails');

    const last = daemon.events.at(-1);
    assert.ok(last);
    assert.equal(last.type, 'state');
    assert.equal(last.state, 'cancelled');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- 3: watcher.stop() returns promptly with a long-poll in flight ---------

test('cancel: watcher.stop() returns promptly with a long-poll in flight', async () => {
  const token = 'cancel-token-3';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-cancel-watcher-'));
  const outDir = join(workspace, '.fleet', 'out');
  mkdirSync(outDir, { recursive: true });

  const sink = new EventSink({ jobId: 'job-watcher-stop', daemonUrl: daemon.url, token });
  const watcher = new DecisionWatcher({ workspace, sink, intervalMs: 25 });
  watcher.start();
  try {
    writeFileSync(join(outDir, 'decision.json'), JSON.stringify(VALID_DECISION));

    // Wait for the decision event — proves the watcher is in the long-poll.
    await waitFor(
      () => daemon.events.some((e) => e.type === 'decision'),
      'the decision event to be raised',
    );

    // stop() while the long-poll is in flight. The AbortController cancels
    // the fetch immediately instead of waiting for the daemon's poll cycle.
    const stopTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('watcher.stop() hung')), 2_000),
    );
    await Promise.race([watcher.stop(), stopTimeout]);

    assert.equal(watcher.count, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- 4: watcher.stop() aborts a long-poll on a dead daemon ------------------

test('cancel: watcher.stop() aborts a long-poll even when the daemon holds the connection', async () => {
  // A daemon that holds the answer endpoint open indefinitely — the case
  // where stop() would wait ~300s without the AbortController.
  const token = 'cancel-token-4';
  const heldRequests: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST') {
      res.writeHead(200).end('{}');
      return;
    }
    if (req.method === 'GET' && url.pathname.endsWith('/answer')) {
      heldRequests.push(res);
      return;
    }
    res.writeHead(404).end();
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const addr = server.address();
  if (addr === null || typeof addr !== 'object') throw new Error('server failed to bind');
  const daemonUrl = `http://127.0.0.1:${addr.port}`;

  const workspace = mkdtempSync(join(tmpdir(), 'fleet-cancel-slow-'));
  const outDir = join(workspace, '.fleet', 'out');
  mkdirSync(outDir, { recursive: true });

  const sink = new EventSink({ jobId: 'job-slow-daemon', daemonUrl, token });
  const watcher = new DecisionWatcher({ workspace, sink, intervalMs: 25 });
  watcher.start();
  try {
    writeFileSync(join(outDir, 'decision.json'), JSON.stringify(VALID_DECISION));

    // Wait for the watcher to enter the long-poll (request held by the daemon).
    await waitFor(
      () => heldRequests.length > 0,
      'the watcher to start the long-poll fetch',
    );

    // stop() while the fetch is held open — the AbortController must cancel it.
    const stopTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('watcher.stop() hung on a slow daemon')), 2_000),
    );
    await Promise.race([watcher.stop(), stopTimeout]);

    assert.equal(watcher.count, 1);
  } finally {
    for (const res of heldRequests) {
      try { res.destroy(); } catch { /* already gone */ }
    }
    rmSync(workspace, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});