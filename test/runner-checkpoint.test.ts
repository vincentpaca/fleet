/**
 * Checkpoint WIP pushes (#190): a cancelled or killed container's uncommitted
 * work has one exit — the bounded teardown push — unless the runner also
 * checkpoints during the run. These drive the real runner end to end:
 *
 * 1. A runner SIGKILLed mid-run (no teardown of any kind) leaves a branch on
 *    origin no staler than the checkpoint interval — fails on pre-#190 code,
 *    where nothing pushes until teardown and the SIGKILL loses everything.
 * 2. A checkpoint push failure logs and the run continues to its own
 *    successful settle — never fatal, never a tight loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockDaemon, type PostedEvent } from './runner-mock-daemon.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
const checkpointHarness = fileURLToPath(new URL('../fixtures/checkpoint-harness.mjs', import.meta.url));
const outageHarness = fileURLToPath(new URL('../fixtures/checkpoint-outage-harness.mjs', import.meta.url));

const IDENTITY = ['-c', 'user.name=Operator One', '-c', 'user.email=op@example.com'];

/** Poll until done() holds; bounded and named, like the other runner suites. */
async function waitFor(done: () => boolean, what: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(50);
  }
}

/** A bare remote seeded with main — the job branch and checkpoints land here. */
function makeRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-checkpoint-git-'));
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

/** Workspace as the provider stages it, with the given limits in the manifest. */
function writeWorkspace(limits: Record<string, string>, target = '190'): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-checkpoint-'));
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

/** Files on the named branch of the bare remote; [] when the ref is absent. */
function branchFiles(remote: string, branch: string): string {
  try {
    return execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
      cwd: remote,
      encoding: 'utf8',
      // Quiet: polling before the branch exists is expected, not noteworthy.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

// --- 1: SIGKILL mid-run — the branch is no staler than the interval ----------

test('checkpoint: a runner SIGKILLed mid-run leaves the work on origin, no teardown required', async () => {
  const token = 'checkpoint-token-1';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const workspace = writeWorkspace({ idle: '60s', checkpoint: '1s' });
  const branch = 'fleet/190-job-checkpoint-1';
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-checkpoint-1',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_GIT_URL: remote,
    FLEET_GIT_NAME: 'Operator One',
    FLEET_GIT_EMAIL: 'op@example.com',
    FLEET_HARNESS_CMD: `node ${checkpointHarness}`,
  });
  try {
    // Within roughly one interval of the edit, the checkpoint must land it on
    // origin — while the harness is still running and long before any settle.
    await waitFor(
      () => branchFiles(remote, branch).includes('long-job-work.txt'),
      'a checkpoint push to land the edit on the remote',
    );

    // The checkpoint is visible in the event log, attributed like every other
    // runner line. Bounded wait: the push is synchronous but the log event's
    // delivery is not.
    await waitFor(
      () => logTexts(daemon.events).some((text) => text === `checkpoint: wip pushed to ${branch}`),
      `a "checkpoint: wip pushed to ${branch}" log event`,
    );

    // SIGKILL the whole tree: no signal handler, no teardown, no final push —
    // the ECS wall-clock cliff, or a host OOM. The work already left.
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    await exitCode;

    assert.match(
      branchFiles(remote, branch),
      /long-job-work\.txt/,
      'the checkpointed work must survive a kill that runs no teardown at all',
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

// --- 2: a checkpoint push failure logs and the run continues -----------------

test('checkpoint: a push failure logs and the run continues to a clean settle', async () => {
  const token = 'checkpoint-token-2';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const workspace = writeWorkspace({ idle: '60s', checkpoint: '1s' }, '190f');
  const branch = 'fleet/190f-job-checkpoint-2';
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-checkpoint-2',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_GIT_URL: remote,
    FLEET_GIT_NAME: 'Operator One',
    FLEET_GIT_EMAIL: 'op@example.com',
    FLEET_HARNESS_CMD: `node ${outageHarness}`,
    TEST_OUTAGE_REMOTE: remote,
    TEST_OUTAGE_BRANCH: branch,
    TEST_OUTAGE_HOLD_MS: '3000',
  });
  try {
    // Generous: the fixture waits for a real checkpoint to land before it
    // even starts the outage, and this file runs alongside the whole suite —
    // see the #130 note in runner-cancel.test.ts.
    const outcome = await Promise.race([
      exitCode.then((code) => `exit ${code}`),
      sleep(90_000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'exit 0', 'checkpoint failures must never fail the run');

    const texts = logTexts(daemon.events);
    assert.ok(
      texts.some((text) => text === `checkpoint: wip pushed to ${branch}`),
      `expected a successful checkpoint before the outage; got ${JSON.stringify(texts)}`,
    );
    assert.ok(
      texts.some((text) => text.startsWith('checkpoint push failed (continuing):')),
      `expected a checkpoint failure log during the outage; got ${JSON.stringify(texts)}`,
    );

    // The run finished on its own terms: done, with the post-outage work
    // delivered by the ordinary settle push.
    const last = daemon.events.at(-1);
    assert.ok(last);
    assert.equal(last.type, 'state');
    assert.equal(last.state, 'done');
    assert.match(branchFiles(remote, branch), /second-edit\.txt/, 'the settle push must deliver the delta');
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
