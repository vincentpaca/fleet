/**
 * Limits get real defaults and per-dispatch overrides (#134).
 *
 * Before this, block_hot and decision_timeout were decorative: docs and schema
 * promised 30m/24h defaults, but a manifest without the keys never parked and
 * never went stale — and workOrder.limits ("per-dispatch overrides") had zero
 * consumers. These tests pin the shared helpers (the one source of truth) and
 * prove the runner honors an order's override end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDaemon } from './runner-mock-daemon.ts';
import {
  blockHotLimitMs,
  checkpointLimitMs,
  decisionTimeoutMs,
  mergedLimits,
  DEFAULT_BLOCK_HOT_MS,
  DEFAULT_CHECKPOINT_MS,
  DEFAULT_DECISION_TIMEOUT_MS,
} from '../src/shared/time.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
const parkHarness = fileURLToPath(new URL('../fixtures/park-harness.mjs', import.meta.url));

// --- The defaults themselves: what a manifest without a limits block gets ---

test('block_hot defaults to the documented 30m when the limits block is absent', () => {
  // The docs promise (architecture.md, drill.md): a blocked container parks
  // after 30m. Before #134 this returned undefined and the park watcher
  // literally never fired — a blocked job stayed hot, and billed, forever.
  assert.equal(blockHotLimitMs({}), DEFAULT_BLOCK_HOT_MS);
  assert.equal(blockHotLimitMs(undefined), DEFAULT_BLOCK_HOT_MS);
  assert.equal(DEFAULT_BLOCK_HOT_MS, 30 * 60_000, 'the default is the documented 30m');
  // An explicit value still wins over the default.
  assert.equal(blockHotLimitMs({ block_hot: '5m' }), 5 * 60_000);
});

test('decision_timeout defaults to the documented 24h when absent', () => {
  assert.equal(decisionTimeoutMs({}), DEFAULT_DECISION_TIMEOUT_MS);
  assert.equal(decisionTimeoutMs(undefined), DEFAULT_DECISION_TIMEOUT_MS);
  assert.equal(DEFAULT_DECISION_TIMEOUT_MS, 24 * 3_600_000, 'the default is the documented 24h');
  assert.equal(decisionTimeoutMs({ decision_timeout: '1h' }), 3_600_000);
});

test('an unparseable limit value falls back to the default, never to "off"', () => {
  assert.equal(blockHotLimitMs({ block_hot: 'soon' }), DEFAULT_BLOCK_HOT_MS);
  assert.equal(decisionTimeoutMs({ decision_timeout: 12 }), DEFAULT_DECISION_TIMEOUT_MS);
  assert.equal(checkpointLimitMs({ checkpoint: 'often' }), DEFAULT_CHECKPOINT_MS);
});

test('checkpoint defaults to the documented 10m when absent (#190)', () => {
  // Like idle, always armed: a container provider's workspace dies with the
  // task, so "no checkpoints" is not a configuration — only a wider cadence is.
  assert.equal(checkpointLimitMs({}), DEFAULT_CHECKPOINT_MS);
  assert.equal(checkpointLimitMs(undefined), DEFAULT_CHECKPOINT_MS);
  assert.equal(DEFAULT_CHECKPOINT_MS, 10 * 60_000, 'the default is the documented 10m');
  assert.equal(checkpointLimitMs({ checkpoint: '2m' }), 2 * 60_000);
});

// --- The merge: work-order limits override manifest limits, key by key ---

test('mergedLimits: order keys win, untouched manifest keys survive', () => {
  const merged = mergedLimits(
    { wall_clock: '4h', block_hot: '30m', decision_timeout: '24h' },
    { wall_clock: '1h' },
  );
  assert.equal(merged.wall_clock, '1h', 'the per-dispatch override wins');
  assert.equal(merged.block_hot, '30m', 'keys the order does not name keep the manifest value');
  assert.equal(merged.decision_timeout, '24h');
});

test('mergedLimits tolerates absent blocks on either side', () => {
  assert.deepEqual(mergedLimits(undefined, undefined), {});
  assert.deepEqual(mergedLimits({ idle: '5m' }, undefined), { idle: '5m' });
  assert.deepEqual(mergedLimits(undefined, { wall_clock: '1h' }), { wall_clock: '1h' });
});

// --- End to end: the runner reads the order's override and parks on it ------
//
// The manifest deliberately pins block_hot at 2h and the order overrides it
// down to 0m: the job parking within seconds proves the order's limits are
// consumed at all (they had zero consumers before #134) AND that they beat the
// manifest's value. Fails on the old code by timing out — the watcher waits
// out the manifest's 2h.

function writeWorkspace(orderLimits: Record<string, string>): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-limits-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  writeFileSync(
    join(workspace, '.fleet', 'manifest.json'),
    JSON.stringify({
      version: 1,
      setup: { image: 'node:22' },
      workspace: { repo: 'origin', strategy: 'branch-per-job' },
      harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }] },
      gates: { pickup: 'node -e "process.exit(0)"' },
      limits: { idle: '60s', block_hot: '2h' },
    }),
  );
  writeFileSync(
    join(workspace, '.fleet', 'order.json'),
    JSON.stringify({ target: '134', limits: orderLimits }),
  );
  return workspace;
}

test('a work-order block_hot override wins over the manifest and parks the job', async () => {
  const token = 'limits-token-1';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace({ block_hot: '0m' });
  const child = spawn(process.execPath, [runnerMain], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FLEET_'))),
      FLEET_JOB_ID: 'job-limits-override',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: `node ${parkHarness}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));
  try {
    const outcome = await Promise.race([
      exited.promise.then((code) => `exit ${code}`),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 30_000)),
    ]);
    assert.equal(outcome, 'exit 0', 'the runner must park (exit 0) on the order override, not wait out the manifest 2h');
    const last = daemon.events.at(-1);
    assert.equal(last?.type, 'state');
    assert.equal(last?.state, 'blocked');
    assert.equal(last?.marker, 'parked');
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
