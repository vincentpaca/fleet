/**
 * Runner settle-path hardening (#139): the post-harness window is where
 * failure destroys evidence.
 *
 * - Line cap: an unbounded harness stdout line must be truncated with a
 *   marker, never crash the runner or ride an event at full length.
 * - Settle heartbeat: the stdout-driven liveness line dies with the harness,
 *   exactly when settle work (pushes, artifact upload) starts racing the
 *   daemon's idle backstop — the runner must keep the event stream fed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDaemon } from './runner-mock-daemon.ts';
import type { PostedEvent } from './runner-mock-daemon.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));

function writeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-settle-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  writeFileSync(
    join(workspace, '.fleet', 'manifest.json'),
    JSON.stringify({
      version: 1,
      setup: { image: 'node:22' },
      workspace: { repo: 'origin', strategy: 'branch-per-job' },
      harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }] },
      gates: { pickup: 'node -e "process.exit(0)"' },
      limits: { idle: '60s' },
    }),
  );
  writeFileSync(join(workspace, '.fleet', 'order.json'), JSON.stringify({ target: '139' }));
  return workspace;
}

function runRunner(env: Record<string, string>): { kill: () => void; exitCode: Promise<number> } {
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('FLEET_')),
  );
  const child = spawn(process.execPath, [runnerMain], {
    env: { ...parentEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));
  return {
    kill: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    },
    exitCode: exited.promise,
  };
}

const logTexts = (events: PostedEvent[]): string[] =>
  events.filter((e) => e.type === 'log').map((e) => String(e.text));

// --- Line cap ---------------------------------------------------------------

test('an oversized harness stdout line is truncated with a marker, not crashed on', async () => {
  const token = 'settle-token-1';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace();
  // One line well past the 1 MiB cap, then a normal translatable line, then a
  // clean exit: the runner must survive the giant, mark the truncation once,
  // and still deliver the rest of the run.
  const giantLineCmd =
    `node -e "` +
    `process.stdout.write('{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"' + 'x'.repeat(1200000) + '\\"}]}}\\n');` +
    `process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'small and honest'}]}})+'\\n');` +
    `"`;
  const { kill, exitCode } = runRunner({
    FLEET_JOB_ID: 'job-line-cap',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_HARNESS_CMD: giantLineCmd,
  });
  try {
    const code = await Promise.race([
      exitCode,
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 30_000)),
    ]);
    assert.equal(code, 0, 'the runner must survive the oversized line and settle cleanly');

    const logs = logTexts(daemon.events);
    assert.ok(
      logs.some((text) => /truncated/.test(text)),
      `expected a truncation marker log; got: ${JSON.stringify(logs.map((l) => l.slice(0, 80)))}`,
    );
    // The small line after the giant still translated and delivered.
    assert.ok(
      daemon.events.some((e) => e.type === 'think' || (e.type === 'log' && String(e.text).includes('small and honest'))),
      'the run continues past the truncation',
    );
    // No accepted event carries the giant payload at full length.
    for (const event of daemon.events) {
      assert.ok(
        JSON.stringify(event).length < 1_100_000,
        'no event may carry an untruncated oversized payload',
      );
    }
    assert.ok(daemon.events.some((e) => e.type === 'settle'), 'the job settles');
  } finally {
    kill();
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- Settle heartbeat --------------------------------------------------------

test('a slow settle emits liveness events so the daemon idle sweep stays fed', async () => {
  const token = 'settle-token-2';
  // Each artifact upload is held ~1.2s: with a 150ms heartbeat window the
  // runner must emit settling lines while the upload is in flight. Before
  // #139 the event stream went silent the moment the harness exited.
  const daemon = await startMockDaemon({ token, artifactDelayMs: 1_200 });
  const workspace = writeWorkspace();
  const artifactCmd =
    `node -e "` +
    `const fs=require('node:fs');` +
    `fs.mkdirSync('.fleet/out/artifacts',{recursive:true});` +
    `fs.writeFileSync('.fleet/out/artifacts/report.md','# slow settle\\n');` +
    `"`;
  const { kill, exitCode } = runRunner({
    FLEET_JOB_ID: 'job-settle-heartbeat',
    FLEET_DAEMON_URL: daemon.url,
    FLEET_RUNNER_TOKEN: token,
    FLEET_WORKSPACE: workspace,
    FLEET_HARNESS_CMD: artifactCmd,
    FLEET_SETTLE_HEARTBEAT_MS: '150',
  });
  try {
    const code = await Promise.race([
      exitCode,
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 30_000)),
    ]);
    assert.equal(code, 0, 'the slow settle still completes');

    const settleIndex = daemon.events.findIndex((e) => e.type === 'settle');
    assert.ok(settleIndex >= 0, 'the settle event arrives');
    const heartbeats = daemon.events
      .slice(0, settleIndex)
      .filter((e) => e.type === 'log' && /^settling — /.test(String(e.text)));
    assert.ok(
      heartbeats.length >= 1,
      `expected settling heartbeats before the settle event; logs: ${JSON.stringify(logTexts(daemon.events))}`,
    );
    // And it stops with the settle: nothing after the settle event but state.
    const after = daemon.events.slice(settleIndex + 1).filter((e) => e.type === 'log' && /^settling — /.test(String(e.text)));
    assert.equal(after.length, 0, 'the heartbeat is cleared before the settle is emitted');
  } finally {
    kill();
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});
