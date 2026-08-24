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
 *
 * Bounded teardown pushes (#152): the WIP push shells out to git, which hangs
 * without bound on a black-holed remote — and, being execFileSync, blocks the
 * event loop, so even the cancel deadline timer never fires. Tests 7 and 8
 * prove a hung push is cut at its own bound and the teardown finishes: the
 * settle outranks the push on cancel, and a park still parks.
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

/**
 * 45s, not 15s. These cases spawn a real runner that clones a bare remote,
 * runs the pickup gate, and boots two cold node processes before anything
 * heartbeats — and they run alongside the whole suite, on a machine whose cores
 * are already committed. At 15s the setup raced the deadline and the failure
 * read "the harness never beat", which says nothing about the teardown the test
 * exists to check (the same trap #130 documented for the stall sweeps). The
 * threshold is irrelevant to the path under test; the headroom is not — every
 * assertion about what the teardown did stays bounded on its own.
 */
async function waitFor(done: () => boolean, what: string, timeoutMs = 45_000): Promise<void> {
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

function writeWorkspace(
  limits: Record<string, string>,
  target = '111',
  pickup = 'node -e "process.exit(0)"',
): string {
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
      gates: { pickup },
      limits,
    }),
  );
  writeFileSync(join(workspace, '.fleet', 'order.json'), JSON.stringify({ target }));
  return workspace;
}

/**
 * A `git` shim for the hung-push tests (#152): delegates every call to the
 * real git until the marker file exists — from then on any `push` ignores
 * SIGTERM and hangs forever, like a push over a black-holed connection. The
 * hang execs `sleep` in place (no grandchildren): the ignored-signal
 * disposition survives exec, and the SIGKILL the timeout sends must land on
 * the process that holds the stdio pipes or execFileSync stays blocked.
 * Prepend the returned directory to PATH; create the marker once setup's own
 * pushes are done.
 */
function makeHangingPushGit(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-fake-git-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      `  if [ "$arg" = push ] && [ -e "${marker}" ]; then`,
      "    trap '' TERM",
      '    exec sleep 3600',
      '  fi',
      'done',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return dir;
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
    // Deliberately NOT setting FLEET_WALL_CLOCK_GRACE_MS or
    // FLEET_CANCEL_DEADLINE_MS. endHarness and drainOutput default to the
    // wall-clock grace (30s in production), and a test that shrinks it to 500ms
    // proves the teardown works only in a configuration no deployment runs:
    // with the real grace, killing a SIGTERM-trapping harness consumed the
    // whole cancel budget and the push and settle never happened. Production
    // values, or this checks nothing.
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
      // Above the 20s cancel deadline: what is under test is that the teardown
      // completes and exits, not how close to its own ceiling it runs.
      sleep(40_000).then(() => 'still running'),
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
// --- 5: a hung pickup gate is bounded, and SIGTERM-proof ---------------------

test('cancel: a pickup gate that hangs and ignores SIGTERM is killed and reported, not left to wedge the runner', async () => {
  const token = 'cancel-token-5';
  const daemon = await startMockDaemon({ token });
  // The gate traps SIGTERM and never exits. spawnSync's default killSignal is
  // SIGTERM, so on the timeout it kills nothing and keeps blocking — the event
  // loop stays wedged and only the daemon's stall backstop eventually reaps the
  // job, minutes later, with no runner-side diagnosis at all.
  const workspace = writeWorkspace(
    { idle: '60s' },
    '111',
    `node -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 50)"`,
  );
  try {
    const started = Date.now();
    const code = await spawnRunner({
      FLEET_JOB_ID: 'job-cancel-gate',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_WALL_CLOCK_GRACE_MS: '500',
      FLEET_GATE_TIMEOUT_MS: '1500',
    }).exitCode;
    const elapsed = Date.now() - started;

    assert.equal(code, 1);
    assert.ok(elapsed < 12_000, `the gate must be bounded; the runner took ${elapsed}ms`);

    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'a hung gate must still settle so the operator gets a next action');
    assert.match(
      JSON.stringify(settle.report),
      /pickup gate timed out/,
      `the settle must name the gate as the cause; got ${JSON.stringify(settle.report)}`,
    );
    const last = daemon.events.at(-1);
    assert.equal(last?.state, 'cancelled');
    assert.equal(last?.reason, 'pickup-gate');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- 6: the deadline is real — a teardown that cannot finish still exits -----

test('cancel: when the deadline expires the tree is killed and the runner exits anyway', async () => {
  const token = 'cancel-token-6';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace({ idle: '60s' });
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-cancel-deadline',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_HARNESS_CMD: `node ${cancelHarness}`,
    // Smaller than the SIGTERM grace the harness will sit through, so the
    // teardown cannot possibly finish. The point of the deadline is that this
    // still ends: a cancelled runner that hangs is the zombie #111 is about,
    // and on the process provider nothing else is coming to kill it.
    FLEET_CANCEL_DEADLINE_MS: '600',
  });
  try {
    await waitFor(
      () => heartbeat(workspace, 'harness') !== '' && heartbeat(workspace, 'child') !== '',
      'the harness and its child to beat at least once',
    );
    assert.ok(child.pid !== undefined);
    process.kill(child.pid, 'SIGTERM');

    const outcome = await Promise.race([
      exitCode.then((code) => `exit ${code}`),
      sleep(15_000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'exit 1');

    // And the tree went with it — the deadline branch escalates to SIGKILL.
    const before = { harness: heartbeat(workspace, 'harness'), child: heartbeat(workspace, 'child') };
    await sleep(1_000);
    assert.equal(heartbeat(workspace, 'harness'), before.harness, 'harness survived the deadline kill');
    assert.equal(heartbeat(workspace, 'child'), before.child, 'child survived the deadline kill');
  } finally {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- 7: a hung WIP push cannot cost the settle (#152) ------------------------
//
// Production values throughout, as in test 1: the default cancel deadline and
// the default push slice derived from it. On pre-#152 code this test fails as
// 'still running' — the hung push blocks the event loop, so not even the
// deadline timer fires, and the runner wedges until the provider's outer
// SIGKILL (which in this test never comes).

test('cancel: a WIP push that hangs is cut at its own bound; the settle still lands inside the deadline', async () => {
  const token = 'cancel-token-7';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const workspace = writeWorkspace({ idle: '60s' });
  const shimDir = mkdtempSync(join(tmpdir(), 'fleet-hang-marker-'));
  const marker = join(shimDir, 'hang-now');
  const fakeGitDir = makeHangingPushGit(marker);
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-cancel-hung-push',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_GIT_URL: remote,
    FLEET_GIT_NAME: 'Operator One',
    FLEET_GIT_EMAIL: 'op@example.com',
    FLEET_HARNESS_CMD: `node ${cancelHarness}`,
    PATH: `${fakeGitDir}:${process.env.PATH ?? ''}`,
  });
  try {
    // Setup's own pushes must succeed; the hang arms only once the run is live.
    await waitFor(
      () => heartbeat(workspace, 'harness') !== '',
      'the harness to beat at least once',
    );
    writeFileSync(marker, '');

    assert.ok(child.pid !== undefined);
    process.kill(child.pid, 'SIGTERM');

    const outcome = await Promise.race([
      exitCode.then((code) => `exit ${code}`),
      sleep(40_000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'exit 1', 'a hung push must not wedge the cancel teardown');

    // The settle landed — losing it to save a doomed push is the bug.
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'the settle must survive a hung WIP push');
    const last = daemon.events.at(-1);
    assert.equal(last?.type, 'state');
    assert.equal(last?.state, 'cancelled');

    // And the transcript names the push timeout: "no wip commit" and "the
    // push hung" must be distinguishable.
    assert.ok(
      logTexts(daemon.events).some((text) => /wip push failed \(cancelling anyway\): git push timed out after \d+ms/.test(text)),
      `expected a log naming the push timeout; got ${JSON.stringify(logTexts(daemon.events))}`,
    );
  } finally {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(workspace, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(fakeGitDir, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- 8: a park whose push hangs still parks (#152) ---------------------------
//
// The park path has no outer deadline at all: pre-#152, a hung push here
// wedged the runner until the daemon's stall backstop reaped it — and the
// backstop cannot push, cannot park, and says nothing about why.

test('park: a WIP push that hangs is cut at its own bound; blocked/parked is still emitted', async () => {
  const token = 'cancel-token-8';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const parkHarness = fileURLToPath(new URL('../fixtures/park-harness.mjs', import.meta.url));
  const workspace = writeWorkspace({ idle: '60s', block_hot: '1s' });
  const shimDir = mkdtempSync(join(tmpdir(), 'fleet-hang-marker-'));
  const marker = join(shimDir, 'hang-now');
  const fakeGitDir = makeHangingPushGit(marker);
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-park-hung-push',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_GIT_URL: remote,
    FLEET_GIT_NAME: 'Operator One',
    FLEET_GIT_EMAIL: 'op@example.com',
    FLEET_HARNESS_CMD: `node ${parkHarness}`,
    // The default (2 minutes) is sized for a real slow remote, not a test.
    FLEET_GIT_TIMEOUT_MS: '1500',
    PATH: `${fakeGitDir}:${process.env.PATH ?? ''}`,
  });
  try {
    // Arm the hang only after the decision is raised: setup's pushes are done
    // and the next git push is the park's WIP push.
    await waitFor(
      () => daemon.events.some((e) => e.type === 'decision'),
      'the decision event to be raised',
    );
    writeFileSync(marker, '');

    const outcome = await Promise.race([
      exitCode.then((code) => `exit ${code}`),
      sleep(40_000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'exit 0', 'a hung push must not wedge the park');

    const last = daemon.events.at(-1);
    assert.equal(last?.type, 'state');
    assert.equal(last?.state, 'blocked');
    assert.equal(last?.marker, 'parked');

    assert.ok(
      logTexts(daemon.events).some((text) => /wip push failed \(parking anyway\): git push timed out after 1500ms/.test(text)),
      `expected a log naming the push timeout; got ${JSON.stringify(logTexts(daemon.events))}`,
    );
  } finally {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(workspace, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(fakeGitDir, { recursive: true, force: true });
    await daemon.close();
  }
});
