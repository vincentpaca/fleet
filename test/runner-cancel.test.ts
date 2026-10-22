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
import { dirname, join } from 'node:path';
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

// --- 1b: a committed-but-unpushed commit and on-disk artifacts survive (#197) --
//
// job-mt9y7vel: the harness had COMMITTED its work (clean tree, unpushed
// commit) and written two artifact files before the daemon's stall backstop
// cancelled it — and the teardown delivered neither. The WIP push must move
// commits, not just uncommitted changes, and the cancel settle must collect
// what already exists in .fleet/out/artifacts. On pre-#197 code the artifact
// half fails: the cancel settle composed produced:[] without collecting.

test('cancel: an unpushed commit lands on the branch and on-disk artifacts ride the cancel settle', async () => {
  const token = 'cancel-token-9';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const workspace = writeWorkspace({ idle: '60s' });
  const committingHarness = fileURLToPath(new URL('../fixtures/committing-harness.mjs', import.meta.url));
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-cancel-committed',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_GIT_URL: remote,
    FLEET_GIT_NAME: 'Operator One',
    FLEET_GIT_EMAIL: 'op@example.com',
    FLEET_HARNESS_CMD: `node ${committingHarness}`,
  });
  try {
    // The fixture marks when the commit and the artifacts are all on disk.
    await waitFor(
      () => heartbeat(workspace, 'harness') !== '' ||
        readFileSyncSafe(join(workspace, '.fleet', 'out', 'work-staged')) !== '',
      'the harness to stage its commit and artifacts',
    );

    assert.ok(child.pid !== undefined);
    process.kill(child.pid, 'SIGTERM');

    const outcome = await Promise.race([
      exitCode.then((code) => `exit ${code}`),
      sleep(40_000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'exit 1', 'the cancel path must terminate the runner within a deadline');

    // The commit the harness made — never pushed by it — is on the remote.
    assert.ok(
      logTexts(daemon.events).some((text) => text.startsWith('wip pushed to')),
      `expected a wip push log; got ${JSON.stringify(logTexts(daemon.events))}`,
    );
    const branch = 'fleet/111-job-cancel-committed';
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
      cwd: remote,
      encoding: 'utf8',
    });
    assert.match(files, /committed-work\.txt/, 'the committed-but-unpushed work must land on the remote');

    // The artifacts already on disk were uploaded, and produced[] names them.
    const uploaded = daemon.artifacts.map((a) => a.path).sort();
    assert.deepEqual(uploaded, ['answer.md', 'readme-audit.md'],
      'the cancel settle must upload what already exists in .fleet/out/artifacts');
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'a settle event must be emitted on cancel');
    const produced = (settle.outcome as { produced: { path: string }[] }).produced;
    assert.deepEqual(
      produced.map((p) => p.path).sort(),
      ['answer.md', 'readme-audit.md'],
      'produced[] must list the collected artifacts, not read []',
    );
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

/** Read a marker file, '' when absent — same tolerance as heartbeat(). */
function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// --- #291: runner pushes go to the job branch, not the agent's branch -------
//
// Every runner push (checkpoint, park, cancel, settle) ran a bare `git push`,
// so it followed whatever branch the agent had checked out and its upstream.

/** A branch's tip on the bare remote, '' when it does not exist. */
function remoteTip(remote: string, branch: string): string {
  return execFileSync('git', ['ls-remote', '--heads', remote, branch], { encoding: 'utf8' }).split('\t')[0];
}

test('cancel: an agent on its own branch off origin/main still lands the WIP on the job branch (#291)', async () => {
  const token = 'cancel-token-291a';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const mainTip = remoteTip(remote, 'main');
  const workspace = writeWorkspace({ idle: '60s' }, '291');
  const committingHarness = fileURLToPath(new URL('../fixtures/committing-harness.mjs', import.meta.url));
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-291a',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_GIT_URL: remote,
    FLEET_GIT_NAME: 'Operator One',
    FLEET_GIT_EMAIL: 'op@example.com',
    FLEET_HARNESS_CMD: `node ${committingHarness}`,
    // The prose prompt said "branch off main": the new branch's upstream is
    // origin/main under another name, so a bare push refused every time.
    TEST_SWITCH: JSON.stringify([['checkout', '-q', '-b', 'other', 'origin/main']]),
    // No artifacts: the settle's "something was delivered" must rest on the push.
    TEST_NO_ARTIFACTS: '1',
  });
  try {
    await waitFor(
      () => readFileSyncSafe(join(workspace, '.fleet', 'out', 'work-staged')) !== '',
      'the harness to switch branches and commit',
    );
    assert.ok(child.pid !== undefined);
    process.kill(child.pid, 'SIGTERM');
    const outcome = await Promise.race([
      exitCode.then((code) => `exit ${code}`),
      sleep(40_000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'exit 1', 'the cancel path must terminate the runner within a deadline');

    const branch = 'fleet/291-job-291a';
    const texts = logTexts(daemon.events);
    assert.ok(texts.includes(`wip pushed to ${branch} (cancelled)`), `expected the WIP on the job branch; got ${JSON.stringify(texts)}`);
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: remote, encoding: 'utf8' });
    assert.match(files, /committed-work\.txt/, 'the agent\'s commit must reach origin/<jobBranch>');
    assert.equal(remoteTip(remote, 'main'), mainTip, 'the runner must never push to the agent\'s upstream');
    assert.equal(remoteTip(remote, 'other'), '', 'nor create the agent\'s branch on the remote');
    assert.ok(
      !texts.some((text) => text.startsWith('no deliverable landed')),
      `the settle must count the WIP as delivered work; got ${JSON.stringify(texts)}`,
    );
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

test('cancel: a branch off main AFTER a checkpoint diverts the work to a side branch, leaving the agent\'s branch alone (#291)', async () => {
  const token = 'cancel-token-291c';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const workspace = writeWorkspace({ idle: '60s', checkpoint: '1s' }, '291');
  const committingHarness = fileURLToPath(new URL('../fixtures/committing-harness.mjs', import.meta.url));
  const branch = 'fleet/291-job-291c';
  const side = 'fleet-diverged/job-291c';
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-291c',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_GIT_URL: remote,
    FLEET_GIT_NAME: 'Operator One',
    FLEET_GIT_EMAIL: 'op@example.com',
    FLEET_HARNESS_CMD: `node ${committingHarness}`,
    // A checkpoint has pushed early work, so origin/<jobBranch> is ahead of
    // main and a branch cut from main no longer builds on it.
    TEST_CHECKPOINT_FIRST: '1',
    TEST_SWITCH: JSON.stringify([['checkout', '-q', '-b', 'x', 'origin/main']]),
    TEST_LEAVE_DIRTY: '1',
    TEST_NO_ARTIFACTS: '1',
  });
  const local = (args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  try {
    await waitFor(
      () => readFileSyncSafe(join(workspace, '.fleet', 'out', 'work-staged')) !== '',
      'the harness to checkpoint, switch branches and commit',
    );
    const agentTip = local(['rev-parse', 'refs/heads/x']);
    const jobTip = remoteTip(remote, branch);
    assert.ok(child.pid !== undefined);
    process.kill(child.pid, 'SIGTERM');
    const outcome = await Promise.race([
      exitCode.then((code) => `exit ${code}`),
      sleep(40_000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'exit 1', 'the cancel path must terminate the runner within a deadline');

    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', side], { cwd: remote, encoding: 'utf8' });
    assert.match(files, /committed-work\.txt/, 'the agent\'s commit must reach the side branch');
    assert.match(files, /uncommitted-work\.txt/, 'and so must its uncommitted edit');
    assert.equal(remoteTip(remote, branch), jobTip, 'the job branch keeps its checkpointed tip');
    assert.equal(remoteTip(remote, 'x'), '', 'the agent\'s branch is never created on the remote');
    // The agent's branch and index are exactly as the agent left them: a
    // runner commit there would ride out with the agent's own next push.
    assert.equal(local(['rev-parse', 'refs/heads/x']), agentTip, 'the agent\'s local branch tip must not move');
    assert.match(local(['status', '--porcelain']), /^\?\? uncommitted-work\.txt$/m, 'the agent\'s index must be untouched');

    const texts = logTexts(daemon.events);
    const diverted = new RegExp(`^(checkpoint: )?wip (pushed to|already on) ${side}, not ${branch}: the agent is on branch x,`);
    assert.ok(texts.some((text) => diverted.test(text)), `expected one line naming all three branches; got ${JSON.stringify(texts)}`);
    assert.ok(
      texts.some((text) => text.startsWith(`wip pushed to ${side}`) || text.startsWith(`wip already on ${side}`)),
      `the cancel push must report the side branch; got ${JSON.stringify(texts)}`,
    );
    assert.ok(
      !texts.some((text) => text.startsWith('no deliverable landed')),
      `work on the side branch is a delivery; got ${JSON.stringify(texts)}`,
    );
  } finally {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dirname(remote), { recursive: true, force: true });
    await daemon.close();
  }
});

/**
 * Stand-ins for the CLIs a derived launch reaches (#291): a `claude` that
 * answers the version probe and records the argv it was launched with, and a
 * `gh` that always fails, so PR grading degrades locally and never reaches
 * GitHub. Prepend the returned directory to PATH.
 */
function fakeCliDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-fake-cli-'));
  writeFileSync(join(dir, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "2.1.220 (Claude Code)"; exit 0; fi',
    'for a in "$@"; do printf "%s\\n" "$a"; done > "$PWD/.fleet/out/argv.txt"',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "gh: not available in this test" >&2\nexit 1\n', { mode: 0o755 });
  return dir;
}

test('re-entry: the runner logs, prompts and reminds about work an earlier run diverted (#291)', async () => {
  const token = 'cancel-token-291e';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const branch = 'fleet/291-job-291e';
  const side = 'fleet-diverged/job-291e';
  // The parked generation: the job branch, and work its park diverted.
  const seed = join(dirname(remote), 'seed');
  const seedGit = (args: string[]) => execFileSync('git', [...IDENTITY, ...args], { cwd: seed });
  seedGit(['checkout', '-q', '-b', branch]);
  writeFileSync(join(seed, 'job.txt'), 'on the job branch\n');
  seedGit(['add', '-A']);
  seedGit(['commit', '-q', '-m', 'job work']);
  seedGit(['push', '-q', remote, branch]);
  seedGit(['checkout', '-q', '-b', 'parked', 'main']);
  writeFileSync(join(seed, 'parked.txt'), 'diverted at park\n');
  seedGit(['add', '-A']);
  seedGit(['commit', '-q', '-m', 'wip(park): diverted']);
  seedGit(['push', '-q', remote, `parked:refs/heads/${side}`]);

  const workspace = writeWorkspace({ idle: '60s' }, '291');
  writeFileSync(join(workspace, '.fleet', 'order.json'), JSON.stringify({ target: '291', prompt: '/dev 291' }));
  const fake = fakeCliDir();
  try {
    const code = await spawnRunner({
      FLEET_JOB_ID: 'job-291e',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_GIT_URL: remote,
      FLEET_GIT_NAME: 'Operator One',
      FLEET_GIT_EMAIL: 'op@example.com',
      FLEET_REENTRY_ANSWER_JSON: Buffer.from(JSON.stringify({ decisionId: 'd1', answer: { option: 'yes' } })).toString('base64'),
      PATH: `${fake}:${process.env.PATH}`,
    }).exitCode;
    assert.notEqual(code, -1, 'the runner must exit on its own');

    const texts = logTexts(daemon.events);
    assert.ok(texts.some((t) => t.startsWith(`RE-ENTRY: an earlier run diverted work to ${side}`)), `expected the re-entry line; got ${JSON.stringify(texts)}`);
    const argv = readFileSyncSafe(join(workspace, '.fleet', 'out', 'argv.txt'));
    assert.match(argv, new RegExp(`left work on branch ${side}`), `the derived launch must carry the clause; argv: ${argv}`);
    assert.match(argv, /git log -p HEAD\.\.FETCH_HEAD/, 'the agent is told to read every commit, not just the tip');
    assert.ok(
      texts.some((t) => t.startsWith(`work diverted earlier is on ${side}, not on ${branch}`)),
      `nobody brought the work over, so the settle must remind; got ${JSON.stringify(texts)}`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dirname(remote), { recursive: true, force: true });
    rmSync(fake, { recursive: true, force: true });
    await daemon.close();
  }
});

test('settle: diverted, but the job branch already carries work — the PR path proceeds (#291)', async () => {
  const token = 'cancel-token-291f';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const workspace = writeWorkspace({ idle: '60s', checkpoint: '1s' }, '291');
  const committingHarness = fileURLToPath(new URL('../fixtures/committing-harness.mjs', import.meta.url));
  const branch = 'fleet/291-job-291f';
  const side = 'fleet-diverged/job-291f';
  const fake = fakeCliDir();
  try {
    const code = await spawnRunner({
      FLEET_JOB_ID: 'job-291f',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_GIT_URL: remote,
      FLEET_GIT_NAME: 'Operator One',
      FLEET_GIT_EMAIL: 'op@example.com',
      FLEET_HARNESS_CMD: `node ${committingHarness}`,
      // Early work reaches the job branch by checkpoint; then the agent
      // branches off main and finishes there.
      TEST_CHECKPOINT_FIRST: '1',
      TEST_SWITCH: JSON.stringify([['checkout', '-q', '-b', 'x', 'origin/main']]),
      TEST_EXIT_AFTER_COMMIT: '1',
      TEST_NO_ARTIFACTS: '1',
      PATH: `${fake}:${process.env.PATH}`,
    }).exitCode;
    assert.notEqual(code, -1, 'the runner must exit on its own');

    const texts = logTexts(daemon.events);
    const note = texts.find((t) => t.startsWith(`work pushed to ${side}, not ${branch}`));
    assert.ok(note, `expected the diversion line; got ${JSON.stringify(texts)}`);
    assert.match(note, /carries earlier work, so its PR proceeds — the newer work is on fleet-diverged\/job-291f/);
    assert.ok(!texts.some((t) => t.startsWith('no PR opened or graded')), 'the job branch has a delivery: its PR is not suppressed');
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle);
    assert.equal(settle.rung, 'pushed', 'graded as a delivered job branch (the fake gh finds no PR), not `implemented`');
    assert.match(execFileSync('git', ['ls-tree', '-r', '--name-only', side], { cwd: remote, encoding: 'utf8' }), /committed-work\.txt/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dirname(remote), { recursive: true, force: true });
    rmSync(fake, { recursive: true, force: true });
    await daemon.close();
  }
});

test('settle: an agent on another PR\'s branch never gets a runner push onto it (#291)', async () => {
  const token = 'cancel-token-291b';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  // Another open PR's branch, cut before main moved on: its history does not
  // contain the job branch, so a push of it to the job branch is not a
  // fast-forward.
  const seed = join(dirname(remote), 'seed');
  const seedGit = (args: string[]) => execFileSync('git', [...IDENTITY, ...args], { cwd: seed });
  seedGit(['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(seed, 'feature.txt'), 'someone else\'s PR\n');
  seedGit(['add', '-A']);
  seedGit(['commit', '-q', '-m', 'feature']);
  seedGit(['push', '-q', remote, 'feature']);
  seedGit(['checkout', '-q', 'main']);
  writeFileSync(join(seed, 'later.txt'), 'main moved on\n');
  seedGit(['add', '-A']);
  seedGit(['commit', '-q', '-m', 'later']);
  seedGit(['push', '-q', remote, 'main']);
  const featureTip = remoteTip(remote, 'feature');
  const workspace = writeWorkspace({ idle: '60s' }, '291');
  const committingHarness = fileURLToPath(new URL('../fixtures/committing-harness.mjs', import.meta.url));
  const branch = 'fleet/291-job-291b';
  try {
    const code = await spawnRunner({
      FLEET_JOB_ID: 'job-291b',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_GIT_URL: remote,
      FLEET_GIT_NAME: 'Operator One',
      FLEET_GIT_EMAIL: 'op@example.com',
      FLEET_HARNESS_CMD: `node ${committingHarness}`,
      // What `gh pr checkout` does: the other PR's branch, tracking its remote.
      TEST_SWITCH: JSON.stringify([
        ['fetch', '-q', 'origin', 'feature'],
        ['checkout', '-q', '-b', 'feature', '--track', 'origin/feature'],
      ]),
      TEST_EXIT_AFTER_COMMIT: '1',
      TEST_LEAVE_DIRTY: '1',
    }).exitCode;
    assert.notEqual(code, -1, 'the runner must exit on its own');

    assert.equal(remoteTip(remote, 'feature'), featureTip, 'no runner push may land on another PR\'s branch');
    assert.equal(remoteTip(remote, branch), remoteTip(remote, 'main'), 'the job branch refuses a HEAD that does not build on it');
    // The work is not dropped: committed and uncommitted alike reach the side branch.
    const side = 'fleet-diverged/job-291b';
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', side], { cwd: remote, encoding: 'utf8' });
    assert.match(files, /committed-work\.txt/);
    assert.match(files, /uncommitted-work\.txt/, 'the runner\'s WIP commit carries the uncommitted edit');
    const texts = logTexts(daemon.events);
    const pushed = texts.find((text) => text.startsWith(`work pushed to ${side}, not ${branch}: the agent is on branch feature`));
    assert.ok(pushed, `expected one line naming all three branches; got ${JSON.stringify(texts)}`);
    assert.ok(!texts.some((text) => text.startsWith('WORK PUSH FAILED')), 'a diverted push is a delivery, not a failure');
    // D6: the job branch holds nothing beyond base, so `pushed` would overstate it.
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'a settle event must be emitted');
    assert.equal(settle.rung, 'implemented', 'a side-branch-only delivery never claims `pushed`');
    assert.ok(texts.some((text) => text.startsWith(`no PR opened or graded: the work is on ${side}`)));
    // Nor may the runner commit onto the foreign branch: the agent's next
    // plain `git push` would publish that commit to the other PR.
    const localLog = execFileSync('git', ['log', '--format=%s', 'feature'], { cwd: workspace, encoding: 'utf8' });
    assert.doesNotMatch(localLog, /fleet job/, 'no runner commit may sit on the agent\'s foreign branch');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dirname(remote), { recursive: true, force: true });
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
