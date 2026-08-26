/**
 * Liveness coalescing (#50), timer-driven (#197). Dropping the harness's own
 * `tool_progress` heartbeats fixed the log flood and broke something else: the
 * daemon's stall backstop measures silence on the EVENT stream, and
 * terminating from that path cannot push the partial work first
 * (`src/daemon/server.ts` #idleSweep). A job inside one long tool call emits
 * nothing but heartbeats, so without coalescing it looks dead to the daemon
 * and gets its container killed with the work unpushed. #197 then moved the
 * beat onto a timer: coupling it to a dropped line ARRIVING meant a harness
 * that went fully silent — alive, waiting on a backgrounded command — emitted
 * nothing, and the backstop killed job-mt9y7vel while it was finishing.
 *
 * Two checkpoints: the timer-driven worst-case event gap leaves the backstop
 * real slack, and the runner emits at most one bounded line per window — far
 * fewer than one per input line, however the lines arrive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDaemon } from './runner-mock-daemon.ts';
import { heartbeatMs, idleLimitMs, DEFAULT_BACKSTOP_MARGIN_MS } from '../src/shared/time.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
test('the timer-driven keepalive worst case still fits inside the daemon backstop', () => {
  for (const idle of ['1m', '5m', '20m', '2h', undefined]) {
    const idleMs = idleLimitMs(idle === undefined ? {} : { idle });
    const window = heartbeatMs(idleMs);
    // Worst case (#197): an event lands just before a tick, so the next beat
    // is almost two windows after it. The beat is timer-driven, so no stdout
    // pattern — bursts, drips, or total silence — can widen the gap further.
    assert.ok(
      2 * window < idleMs + DEFAULT_BACKSTOP_MARGIN_MS,
      `idle=${idle ?? 'default'}: 2×${window}ms does not fit in ${idleMs + DEFAULT_BACKSTOP_MARGIN_MS}ms`,
    );
    // And it must never be so small that a healthy job spams the log.
    assert.ok(window >= 30_000, `idle=${idle ?? 'default'}: window ${window}ms is too chatty`);
  }
});

// Fake harness: emits only lines the translator drops, in BURSTS. Bursts, not
// an even drip, so the upper bound below holds under scheduler slip — a loaded
// runner that turns every line into its own tick must not read as a flood.
const BURSTS = 4;
const LINES_PER_BURST = 6;
const HEARTBEAT_ONLY_CMD =
  `node -e "` +
  `const fs=require('node:fs');` +
  `let b=0;` +
  `const t=setInterval(()=>{` +
  `for(let i=0;i<${LINES_PER_BURST};i++)` +
  `process.stdout.write(JSON.stringify({type:'system',subtype:'tool_progress',tool_use_id:'t1',elapsed_ms:b*150,partial_output:'x'.repeat(400)})+'\\n');` +
  `if(++b>=${BURSTS}){clearInterval(t);fs.writeFileSync('.fleet/out/report.json',process.env.TEST_REPORT);}` +
  `},150)"`;

function writeWorkspace(limits?: Record<string, string>): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-heartbeat-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  writeFileSync(
    join(workspace, '.fleet', 'manifest.json'),
    JSON.stringify({
      version: 1,
      setup: { image: 'node:22', script: '.fleet/setup.sh' },
      workspace: { repo: 'git@github.com:generic/example.git', strategy: 'branch-per-job' },
      harness: {
        cli: 'claude-code',
        commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
      },
      gates: { pickup: `node -e "process.exit(0)"` },
      ...(limits !== undefined ? { limits } : {}),
    }),
  );
  return workspace;
}

test('an event-silent stretch still reaches the daemon, coalesced', async (t) => {
  const token = 'test-token-heartbeat';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace();
  t.after(async () => {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  });
  const { FLEET_GIT_URL: _u, FLEET_GIT_NAME: _n, FLEET_GIT_EMAIL: _e, ...parentEnv } = process.env;

  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [runnerMain], {
    env: {
      ...parentEnv,
      FLEET_JOB_ID: 'job-heartbeat-1',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: HEARTBEAT_ONLY_CMD,
      // Same test-knob convention as FLEET_WALL_CLOCK_GRACE_MS: a real window
      // is minutes long, which no test should wait for.
      FLEET_HEARTBEAT_MS: '90',
      TEST_REPORT: JSON.stringify({
        status: 'PARTIAL',
        next_action: 'rerun the job',
        verification: ['heartbeat replay completed'],
        not_done: ['everything'],
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));
  assert.equal(await exited.promise, 0);
  const elapsedMs = Date.now() - spawnedAt;

  assert.deepEqual(daemon.rejected, [], 'every heartbeat must pass schema validation at intake');
  const beats = daemon.events.filter(
    (e) => e.type === 'log' && typeof e.text === 'string' && e.text.startsWith('harness working'),
  );
  assert.ok(beats.length >= 2, `expected coalesced heartbeats, got ${beats.length}`);
  // Coalescing is the whole point: at most one beat per window, however the
  // dropped lines arrive — the beat is timer-driven (#197), so line count
  // cannot inflate it. One beat per input line — the pre-#50 behaviour —
  // would be BURSTS * LINES_PER_BURST regardless of runtime.
  const windowCap = Math.ceil(elapsedMs / 90) + 1;
  assert.ok(
    beats.length <= Math.min(windowCap, BURSTS * LINES_PER_BURST - 1),
    `heartbeats did not coalesce: ${beats.length} beats over ${elapsedMs}ms ` +
    `(${BURSTS * LINES_PER_BURST} dropped lines, cap ${windowCap})`,
  );
  for (const beat of beats) {
    const text = beat.text as string;
    assert.ok(text.length < 120, `heartbeat line was ${text.length} chars`);
    assert.ok(!text.includes('partial_output') && !text.includes('xxxx'), `heartbeat leaked payload: ${text}`);
    // Attributable like every other runner-emitted log: this is the line most
    // likely to be on the board's `now:` row when an operator looks.
    assert.equal(beat.who, 'runner');
  }
});

// --- #197 acceptance: total silence with a live process is not a stall -------
//
// The incident this pins: a harness that had committed its work went quiet
// waiting on a backgrounded command. The old keepalive fired only when a
// dropped stdout line ARRIVED, so total silence emitted nothing, the daemon's
// idle sweep read the event gap as a dead runner, and the job was cancelled
// while actively finishing. On pre-#197 code this test fails: the runner's own
// stall path kills the harness at limits.idle and the job cancels.

test('a harness that is silent past the idle limit while its process lives keeps beating and completes', async (t) => {
  const token = 'test-token-keepalive';
  const daemon = await startMockDaemon({ token });
  // Idle 2s; the harness is fully silent for 5s. The keepalive window (300ms)
  // sits under the idle limit in the same proportion production keeps
  // (heartbeatMs = idle/3), so the beats are what carry the job across.
  const workspace = writeWorkspace({ idle: '2s' });
  t.after(async () => {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  });
  const quietHarness = fileURLToPath(new URL('../fixtures/quiet-harness.mjs', import.meta.url));
  const { FLEET_GIT_URL: _u2, FLEET_GIT_NAME: _n2, FLEET_GIT_EMAIL: _e2, ...parentEnv2 } = process.env;

  const child = spawn(process.execPath, [runnerMain], {
    env: {
      ...parentEnv2,
      FLEET_JOB_ID: 'job-keepalive-1',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: `node ${quietHarness}`,
      FLEET_HEARTBEAT_MS: '300',
      TEST_QUIET_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));

  assert.equal(await exited.promise, 0, 'a silent-but-alive harness must be allowed to finish');
  assert.deepEqual(daemon.rejected, [], 'every event must pass schema validation at intake');

  const last = daemon.events.at(-1);
  assert.ok(last);
  assert.equal(last.type, 'state');
  assert.equal(last.state, 'done', 'the job must reach done, not cancelled(stall)');
  assert.ok(
    !daemon.events.some((e) => e.type === 'log' && String(e.text).startsWith('stalled:')),
    'no stall log may be emitted for a live process',
  );

  // The keepalives are what fed the daemon's idle sweep through the silence:
  // at a 300ms window a 5s quiet stretch must produce a steady stream of them.
  const beats = daemon.events.filter(
    (e) => e.type === 'log' && typeof e.text === 'string' && e.text.startsWith('harness working'),
  );
  assert.ok(beats.length >= 5, `expected keepalives throughout the silence, got ${beats.length}`);
});
