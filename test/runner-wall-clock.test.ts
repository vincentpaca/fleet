/**
 * Wall-clock limit enforcement (issue #7).
 *
 * Three acceptance criteria exercised here:
 *  1. Long-running fake harness is terminated when limit is reached.
 *  2. Settle carries partial outcome + next_action naming the reason.
 *  3. Job state is cancelled with reason "wall-clock".
 *  4. Blocked time is provably excluded from the meter (harness completes
 *     despite total elapsed >> wall_clock, because blocked time is subtracted).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockDaemon } from './runner-mock-daemon.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));

/** Write a workspace with the given wall_clock limit in the manifest. */
function writeWorkspace(wallClock: string): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-wc-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  writeFileSync(
    join(workspace, '.fleet', 'manifest.json'),
    JSON.stringify({
      version: 1,
      setup: { image: 'node:22' },
      workspace: { repo: 'git@github.com:acme/example.git', strategy: 'branch-per-job' },
      harness: {
        cli: 'claude-code',
        commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
      },
      gates: { pickup: 'node -e "process.exit(0)"' },
      limits: { wall_clock: wallClock },
    }),
  );
  return workspace;
}

function runRunner(env: Record<string, string>): { child: ReturnType<typeof spawn>; exitCode: Promise<number> } {
  const { FLEET_GIT_URL: _u, FLEET_GIT_NAME: _n, FLEET_GIT_EMAIL: _e, ...parentEnv } = process.env;
  const child = spawn(process.execPath, [runnerMain], {
    env: { ...parentEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));
  return { child, exitCode: exited.promise };
}

// --- Test 1: wall-clock expiry kills harness, emits PARTIAL settle + wall-clock cancel ---

test('wall-clock: long harness is killed, settle PARTIAL, cancelled reason wall-clock', async () => {
  const token = 'wc-token-1';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace('2s'); // 2 second limit
  try {
    // Harness that sleeps 60s — will never finish within 2s.
    const { exitCode } = runRunner({
      FLEET_JOB_ID: 'job-wc-1',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: 'node -e "setTimeout(()=>{},60000)"',
      FLEET_WALL_CLOCK_GRACE_MS: '300', // short grace for test speed
    });

    const code = await exitCode;
    assert.equal(code, 1, 'runner should exit 1 on wall-clock cancellation');

    assert.deepEqual(daemon.rejected, [], 'no events should be rejected');
    assert.equal(daemon.badTokenCount, 0);

    const types = daemon.events.map((e) => e.type);
    // state(running) + log(wall-clock reached) + settle + state(cancelled)
    assert.ok(types[0] === 'state' && (daemon.events[0] as Record<string, unknown>).state === 'running');
    assert.ok(types.includes('settle'), 'must include settle event');
    const lastEvent = daemon.events.at(-1);
    assert.ok(lastEvent);
    assert.equal(lastEvent.type, 'state');
    assert.equal(lastEvent.state, 'cancelled');
    assert.equal(lastEvent.reason, 'wall-clock');

    // Settle must carry a PARTIAL report with next_action.
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle);
    const report = settle.report as Record<string, unknown>;
    assert.ok(report, 'settle must include report');
    assert.equal(report.status, 'PARTIAL');
    assert.ok(typeof report.next_action === 'string' && report.next_action.length > 0);
    assert.ok(String(report.next_action).includes('wall-clock'));

    // Outcome is present.
    const outcome = settle.outcome as Record<string, unknown>;
    assert.ok(outcome);
    assert.deepEqual(outcome.produced, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- Test 2: blocked time excluded — job survives despite elapsed >> wall_clock ---

test('wall-clock: blocked time excluded; job completes when active time is under limit', async () => {
  const token = 'wc-token-2';
  const daemon = await startMockDaemon({ token });
  // 2s active limit. The harness blocks for ≈2.3s (> the 2s limit in wall
  // time), but active time is only ≈0.7s. Without blocked-time exclusion the
  // job would be cancelled; with it the job completes normally.
  const workspace = writeWorkspace('2s');
  try {
    // Write the harness script to a file — embedding JSON with double quotes
    // inside a shell -e "..." argument breaks when the shell processes \\.
    // A script file avoids all quoting issues.
    const decision = JSON.stringify({
      question: 'Continue?',
      options: [
        { id: 'yes', label: 'Yes', recommended: true },
        { id: 'no', label: 'No' },
      ],
    });
    // resolve() so the absolute path has no shell-special characters.
    const scriptPath = resolve(workspace, 'harness.js');
    writeFileSync(
      scriptPath,
      [
        `const fs = require('node:fs');`,
        `const path = require('node:path');`,
        `const out = path.join(process.cwd(), '.fleet', 'out');`,
        // decision.json must have ≥2 options; exactly one recommended.
        `fs.writeFileSync(path.join(out, 'decision.json'), ${JSON.stringify(decision)});`,
        // Poll for answer-d1.json (written by the decision watcher).
        `const ap = path.join(out, 'answer-d1.json');`,
        `function poll() {`,
        `  if (fs.existsSync(ap)) { process.exit(0); }`,
        `  setTimeout(poll, 100);`,
        `}`,
        `setTimeout(poll, 100);`,
      ].join('\n'),
    );

    const { exitCode } = runRunner({
      FLEET_JOB_ID: 'job-wc-2',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: `node ${scriptPath}`,
      // Short grace — just needs to be long enough to let the harness exit
      // cleanly if the wall-clock incorrectly fires.
      FLEET_WALL_CLOCK_GRACE_MS: '300',
    });

    // Stage the answer after 2.5s. Total elapsed >> 2s limit.
    // Without blocked-time exclusion the job would be cancelled at t≈2s;
    // with proper exclusion active time stays under 1s and the job completes.
    await sleep(2500);
    daemon.answer('d1', { option: 'yes' });

    const code = await exitCode;
    assert.equal(code, 0, 'job should complete normally when blocked time is excluded');

    assert.deepEqual(daemon.rejected, [], 'no events should be rejected');
    const lastEvent = daemon.events.at(-1);
    assert.ok(lastEvent);
    assert.equal(lastEvent.type, 'state');
    assert.equal(lastEvent.state, 'done', 'job should reach done, not cancelled');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});
