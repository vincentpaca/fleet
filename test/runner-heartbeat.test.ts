/**
 * Liveness coalescing (#50). Dropping the harness's own `tool_progress`
 * heartbeats fixed the log flood and broke something else: the daemon's stall
 * backstop measures silence on the EVENT stream, and terminating from that
 * path cannot push the partial work first (`src/daemon/server.ts` #idleSweep).
 * A job inside one long tool call emits nothing but heartbeats, so without
 * coalescing it looks dead to the daemon and gets its container killed with
 * the work unpushed.
 *
 * Two checkpoints: the interval leaves the backstop real slack, and the runner
 * actually emits one bounded line per window — far fewer than one per input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDaemon } from './runner-mock-daemon.ts';
import { heartbeatMs, idleLimitMs, DEFAULT_IDLE_MS } from '../src/shared/time.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));

/** The daemon's backstop margin default (`idleBackstopMarginMs`). */
const BACKSTOP_MARGIN_MS = 90_000;

test('the heartbeat window leaves the daemon backstop two windows of slack', () => {
  for (const idle of ['1m', '5m', '20m', '2h', undefined]) {
    const idleMs = idleLimitMs(idle === undefined ? {} : { idle });
    const window = heartbeatMs(idleMs);
    // Two consecutive windows must still land inside the backstop threshold,
    // so one delayed or lost heartbeat cannot cost a job its container.
    assert.ok(
      window * 2 < idleMs + BACKSTOP_MARGIN_MS,
      `idle=${idle ?? 'default'}: window ${window}ms × 2 does not fit in ${idleMs + BACKSTOP_MARGIN_MS}ms`,
    );
    // And it must never be so small that a healthy job spams the log.
    assert.ok(window >= 30_000, `idle=${idle ?? 'default'}: window ${window}ms is too chatty`);
  }
  assert.equal(heartbeatMs(DEFAULT_IDLE_MS), 400_000);
});

// Fake harness: emits only lines the translator drops, spread over time, then
// writes its report. Before #50 these were events; now they must coalesce.
const HEARTBEAT_ONLY_CMD =
  `node -e "` +
  `const fs=require('node:fs');` +
  `let n=0;` +
  `const t=setInterval(()=>{` +
  `process.stdout.write(JSON.stringify({type:'system',subtype:'tool_progress',tool_use_id:'t1',elapsed_ms:n*30,partial_output:'x'.repeat(400)})+'\\n');` +
  `if(++n>=24){clearInterval(t);fs.writeFileSync('.fleet/out/report.json',process.env.TEST_REPORT);}` +
  `},30)"`;

function writeWorkspace(): string {
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

  assert.deepEqual(daemon.rejected, [], 'every heartbeat must pass schema validation at intake');
  const beats = daemon.events.filter(
    (e) => e.type === 'log' && typeof e.text === 'string' && e.text.startsWith('harness working'),
  );
  assert.ok(beats.length >= 2, `expected coalesced heartbeats, got ${beats.length}`);
  // 24 dropped input lines over ~720ms with a 90ms window: coalescing is the
  // whole point, so this must be far below one event per input line.
  assert.ok(beats.length < 12, `heartbeats did not coalesce: ${beats.length} for 24 dropped lines`);
  for (const beat of beats) {
    const text = beat.text as string;
    assert.ok(text.length < 120, `heartbeat line was ${text.length} chars`);
    assert.ok(!text.includes('partial_output') && !text.includes('xxxx'), `heartbeat leaked payload: ${text}`);
  }
});
