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
import { heartbeatMs, idleLimitMs, DEFAULT_BACKSTOP_MARGIN_MS } from '../src/shared/time.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
/**
 * The harness's own heartbeat cadence: `tool_progress` arrives every 30s of
 * every long tool call. The runner's heartbeat is *line-driven*, so worst-case
 * event silence is one window plus one line gap — not two windows. A harness
 * emitting nothing at all is a different case with a different owner: the
 * runner's own IdleTimer fires on stdout silence and pushes the WIP first.
 */
const HARNESS_HEARTBEAT_MS = 30_000;

test('the heartbeat window plus a line gap still fits inside the daemon backstop', () => {
  for (const idle of ['1m', '5m', '20m', '2h', undefined]) {
    const idleMs = idleLimitMs(idle === undefined ? {} : { idle });
    const window = heartbeatMs(idleMs);
    assert.ok(
      window + HARNESS_HEARTBEAT_MS < idleMs + DEFAULT_BACKSTOP_MARGIN_MS,
      `idle=${idle ?? 'default'}: ${window}+${HARNESS_HEARTBEAT_MS}ms does not fit in ${idleMs + DEFAULT_BACKSTOP_MARGIN_MS}ms`,
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
  // Coalescing is the whole point: at most one beat per burst, however slowly
  // the burst's lines are actually delivered. One beat per input line — the
  // pre-#50 behaviour — would be ${BURSTS * LINES_PER_BURST}.
  assert.ok(
    beats.length <= BURSTS,
    `heartbeats did not coalesce: ${beats.length} beats for ${BURSTS * LINES_PER_BURST} dropped lines`,
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
