/**
 * Stall detection (issue #39): the runner cancels on silence, not just on the
 * wall-clock budget.
 *
 * 1. A harness that goes silent past limits.idle is killed at the threshold:
 *    partial work still reaches the branch, the settle report carries the idle
 *    duration, and the job cancels with reason "stall".
 * 2. The kill is what ends the run: a harness that ignores SIGTERM and leaves a
 *    child holding stdout is still terminated and still settled.
 * 3. A chatty harness is never mistaken for a stalled one — output resets the
 *    window, so total runtime far past the threshold is fine.
 * 4. A harness blocked on a decision is exempt: waiting on a human is not a
 *    stall, even when total elapsed exceeds the threshold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockDaemon, type PostedEvent } from './runner-mock-daemon.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
const stallHarness = fileURLToPath(new URL('../fixtures/stall-harness.mjs', import.meta.url));
const stubbornHarness = fileURLToPath(new URL('../fixtures/stubborn-harness.mjs', import.meta.url));

const IDENTITY = ['-c', 'user.name=Operator One', '-c', 'user.email=op@example.com'];

/** A bare remote seeded with main — the job branch and the partial push land here. */
function makeRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-stall-git-'));
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
function writeWorkspace(limits: Record<string, string>, target = '39'): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-stall-'));
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

function spawnRunner(env: Record<string, string>): { child: ReturnType<typeof spawn>; exitCode: Promise<number> } {
  const { FLEET_GIT_URL: _u, FLEET_GIT_NAME: _n, FLEET_GIT_EMAIL: _e, ...parentEnv } = process.env;
  const child = spawn(process.execPath, [runnerMain], {
    env: { ...parentEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own group so a wedged runner (and its harness tree) can be cleaned up
    // here rather than left behind when a test fails.
    detached: true,
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));
  return { child, exitCode: exited.promise };
}

function runRunner(env: Record<string, string>): Promise<number> {
  return spawnRunner(env).exitCode;
}

const logTexts = (events: PostedEvent[]): string[] =>
  events.filter((e) => e.type === 'log').map((e) => String(e.text));

/**
 * Last heartbeat written by a stubborn-harness process, or '' if it never ran.
 * Heartbeats, not pids: a killed-but-unreaped process still answers signal 0,
 * so `process.kill(pid, 0)` cannot tell dead from zombie. A file that stops
 * advancing can.
 */
function heartbeat(workspace: string, who: 'harness' | 'child'): string {
  try {
    return readFileSync(join(workspace, '.fleet', 'out', `heartbeat-${who}`), 'utf8');
  } catch {
    return '';
  }
}

// --- 1: silence past the threshold cancels with reason stall ------------------

test('stall: silent harness is killed at limits.idle, partial work pushed, idle duration in the settle', async () => {
  const token = 'stall-token-1';
  const daemon = await startMockDaemon({ token });
  const remote = makeRemote();
  const workspace = writeWorkspace({ idle: '2s' });
  try {
    const code = await runRunner({
      FLEET_JOB_ID: 'job-stall-1',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_GIT_URL: remote,
      FLEET_GIT_NAME: 'Operator One',
      FLEET_GIT_EMAIL: 'op@example.com',
      FLEET_HARNESS_CMD: `node ${stallHarness}`,
      FLEET_WALL_CLOCK_GRACE_MS: '300',
    });
    assert.equal(code, 1, 'runner exits 1 on a stall cancellation');
    assert.deepEqual(daemon.rejected, [], 'no events rejected');

    // Cancelled, with the reason that names the failure mode.
    const last = daemon.events.at(-1);
    assert.ok(last);
    assert.equal(last.type, 'state');
    assert.equal(last.state, 'cancelled');
    assert.equal(last.reason, 'stall', 'reason must be stall, not wall-clock or harness-exit');

    // The live log says what happened, with the idle duration and the limit.
    const stallLog = logTexts(daemon.events).find((text) => text.startsWith('stalled:'));
    assert.ok(stallLog, `expected a stall log event; got ${JSON.stringify(logTexts(daemon.events))}`);
    assert.match(stallLog, /no harness output for \d+(\.\d+)?m \(idle limit 2s\)/);

    // The settle carries the duration too — the transcript must diagnose itself.
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'settle event must be emitted');
    const report = settle.report as Record<string, unknown>;
    assert.equal(report.status, 'PARTIAL');
    assert.match(String(report.next_action), /no harness output for \d+(\.\d+)?m \(idle limit 2s\)/);

    // Partial work reached the branch: evidence over tidiness.
    assert.ok(
      logTexts(daemon.events).some((text) => text === 'work pushed to fleet/39-job-stall-1'),
      `expected a work push log; got ${JSON.stringify(logTexts(daemon.events))}`,
    );
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'fleet/39-job-stall-1'], {
      cwd: remote,
      encoding: 'utf8',
    });
    assert.match(files, /half-done\.txt/, 'the work done before the stall must be on the remote');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- 2: the kill has to be what ends the run ---------------------------------

test('stall: a harness that ignores SIGTERM and leaks a stdout holder is still settled', async () => {
  const token = 'stall-token-kill';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace({ idle: '2s' });
  const { child, exitCode } = spawnRunner({
    FLEET_JOB_ID: 'job-stall-kill',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_HARNESS_CMD: `node ${stubbornHarness}`,
    FLEET_WALL_CLOCK_GRACE_MS: '500',
  });
  try {
    // A runner that signals only the shell's pid, or that skips the SIGKILL
    // escalation, waits on this harness forever — so the failure mode under
    // test is "never settles", and the assertion has to be a bounded race.
    const outcome = await Promise.race([
      exitCode.then((code) => `exit ${code}`),
      sleep(20_000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'exit 1', 'the stall path must terminate the harness tree and settle');

    const last = daemon.events.at(-1);
    assert.ok(last);
    assert.equal(last.state, 'cancelled');
    assert.equal(last.reason, 'stall');
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'the job must settle even though the harness refused to die politely');

    // And the whole tree is actually stopped. Settling while the harness runs on
    // would leave it spending tokens with nowhere to report — signalling only
    // the shell's pid leaves exactly that behind, settle or no settle.
    const before = { harness: heartbeat(workspace, 'harness'), child: heartbeat(workspace, 'child') };
    assert.notEqual(before.harness, '', 'fixture must have beaten at least once, or it proves nothing');
    assert.notEqual(before.child, '', 'the stdout-holding child must have beaten at least once');
    await sleep(1_000); // ten heartbeat intervals
    assert.equal(heartbeat(workspace, 'harness'), before.harness, 'harness kept running after the stall kill');
    assert.equal(heartbeat(workspace, 'child'), before.child, 'the harness child kept running after the stall kill');
  } finally {
    // Whatever happened, leave nothing of this job's tree behind.
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- 3: output resets the window ---------------------------------------------

test('stall: a chatty harness runs past the idle threshold and completes', async () => {
  const token = 'stall-token-2';
  const daemon = await startMockDaemon({ token });
  // 2s threshold, ~2.4s of runtime with output every 300ms: only a window that
  // resets on output survives, and a spurious failure now needs a 2s scheduler
  // stall in line delivery rather than a 1s one.
  const workspace = writeWorkspace({ idle: '2s' });
  try {
    const scriptPath = resolve(workspace, 'chatty.js');
    writeFileSync(
      scriptPath,
      [
        `let n = 0;`,
        `const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`,
        `const timer = setInterval(() => {`,
        `  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'step ' + (++n) }] } });`,
        `  if (n === 8) { clearInterval(timer); line({ type: 'result', subtype: 'success' }); }`,
        `}, 300);`,
      ].join('\n'),
    );

    const code = await runRunner({
      FLEET_JOB_ID: 'job-stall-2',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: `node ${scriptPath}`,
      FLEET_WALL_CLOCK_GRACE_MS: '300',
    });

    assert.equal(code, 0, 'a talkative harness must not be cancelled as stalled');
    assert.deepEqual(daemon.rejected, [], 'no events rejected');
    const last = daemon.events.at(-1);
    assert.ok(last);
    assert.equal(last.state, 'done');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- 4: blocked on a decision is exempt --------------------------------------

test('stall: time spent blocked on a decision is excluded from the idle window', async () => {
  const token = 'stall-token-3';
  const daemon = await startMockDaemon({ token });
  // 2s threshold; the answer arrives at 3s, so total elapsed exceeds it while
  // silent-and-unblocked time never does.
  const workspace = writeWorkspace({ idle: '2s' });
  try {
    const decision = JSON.stringify({
      question: 'Continue?',
      options: [
        { id: 'yes', label: 'Yes', recommended: true },
        { id: 'no', label: 'No' },
      ],
    });
    const scriptPath = resolve(workspace, 'asking.js');
    writeFileSync(
      scriptPath,
      [
        `const fs = require('node:fs');`,
        `const path = require('node:path');`,
        `const out = path.join(process.cwd(), '.fleet', 'out');`,
        `fs.writeFileSync(path.join(out, 'decision.json'), ${JSON.stringify(decision)});`,
        `const ap = path.join(out, 'answer-d1.json');`,
        `function poll() {`,
        `  if (fs.existsSync(ap)) { process.exit(0); }`,
        `  setTimeout(poll, 100);`,
        `}`,
        `setTimeout(poll, 100);`,
      ].join('\n'),
    );

    const exited = runRunner({
      FLEET_JOB_ID: 'job-stall-3',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: `node ${scriptPath}`,
      FLEET_WALL_CLOCK_GRACE_MS: '300',
    });

    await sleep(3000);
    daemon.answer('d1', { option: 'yes' });

    const code = await exited;
    assert.equal(code, 0, 'a job waiting on a human must not be cancelled as stalled');
    assert.deepEqual(daemon.rejected, [], 'no events rejected');
    const last = daemon.events.at(-1);
    assert.ok(last);
    assert.equal(last.state, 'done', 'job reaches done, not cancelled');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});
