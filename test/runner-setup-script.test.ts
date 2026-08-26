// One-layer setup (#49): the runner executes manifest setup.script in the
// workspace before the pickup gate when the image did not bake it.
//
// The bug this guards: on ECS the runner task definition pins the deployment's
// :runner image, which bakes no repo setup — and nothing else ran setup.script
// either, so jobs survived on the agent noticing missing dependencies and
// installing by hand. The contract now: no baked marker → the script runs
// before the gate, observably; marker present → skipped, observably; failure →
// the job cancels before model spend, same shape as a failing gate.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDaemon } from './runner-mock-daemon.ts';
import { runSetupScript, dropPrivileges } from '../src/runner/setup.ts';
import { SETUP_BAKED_BASENAME, setupBakedMarkerPath } from '../src/shared/setup-marker.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));

// ---------- unit: runSetupScript ----------

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-setup-'));
}

/** Manifest fragment with the given setup block. */
function manifestWith(setup: Record<string, unknown> | undefined): Record<string, unknown> {
  return setup === undefined ? {} : { setup };
}

/** A marker path that provably does not exist. */
function absentMarker(workspace: string): string {
  return join(workspace, 'no-such-marker');
}

describe('runSetupScript', () => {
  test('no setup.script → none, and nothing executes', () => {
    const workspace = tempWorkspace();
    try {
      const outcome = runSetupScript({
        workspace,
        manifest: manifestWith({ image: 'node:22' }),
        markerPath: absentMarker(workspace),
      });
      assert.equal(outcome.kind, 'none');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('marker present → baked, and the script does not run', () => {
    const workspace = tempWorkspace();
    try {
      mkdirSync(join(workspace, '.fleet'), { recursive: true });
      writeFileSync(join(workspace, '.fleet', 'setup.sh'), 'touch setup-ran.txt\n');
      const marker = join(workspace, 'marker');
      writeFileSync(marker, '2026-08-24T00:00:00Z\n');
      const outcome = runSetupScript({
        workspace,
        manifest: manifestWith({ script: '.fleet/setup.sh' }),
        markerPath: marker,
      });
      assert.equal(outcome.kind, 'baked');
      assert.match((outcome as { note: string }).note, /baked into the image/);
      assert.ok(!existsSync(join(workspace, 'setup-ran.txt')), 'baked setup must not run again');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('script declared but not on disk → missing, named in the note', () => {
    const workspace = tempWorkspace();
    try {
      const outcome = runSetupScript({
        workspace,
        manifest: manifestWith({ script: '.fleet/setup.sh' }),
        markerPath: absentMarker(workspace),
      });
      assert.equal(outcome.kind, 'missing');
      assert.match((outcome as { note: string }).note, /\.fleet\/setup\.sh not found/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('script runs in the workspace and reports ok', () => {
    const workspace = tempWorkspace();
    try {
      mkdirSync(join(workspace, '.fleet'), { recursive: true });
      // No execute bit on purpose: the runner invokes `sh <path>`, the same
      // invocation the two-layer build bakes, so mode must not matter.
      writeFileSync(join(workspace, '.fleet', 'setup.sh'), 'echo done > setup-ran.txt\n');
      const outcome = runSetupScript({
        workspace,
        manifest: manifestWith({ script: '.fleet/setup.sh' }),
        markerPath: absentMarker(workspace),
      });
      assert.equal(outcome.kind, 'ran', JSON.stringify(outcome));
      assert.equal(readFileSync(join(workspace, 'setup-ran.txt'), 'utf8').trim(), 'done');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('failing script → failed, with exit code and first output line', () => {
    const workspace = tempWorkspace();
    try {
      mkdirSync(join(workspace, '.fleet'), { recursive: true });
      writeFileSync(join(workspace, '.fleet', 'setup.sh'), 'echo "boom: tool missing" >&2\nexit 3\n');
      const outcome = runSetupScript({
        workspace,
        manifest: manifestWith({ script: '.fleet/setup.sh' }),
        markerPath: absentMarker(workspace),
      });
      assert.equal(outcome.kind, 'failed');
      const failed = outcome as { note: string; detail: string };
      assert.match(failed.detail, /exit 3/);
      assert.match(failed.detail, /boom: tool missing/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('script over the kill budget → failed with a timeout note', () => {
    const workspace = tempWorkspace();
    try {
      mkdirSync(join(workspace, '.fleet'), { recursive: true });
      writeFileSync(join(workspace, '.fleet', 'setup.sh'), 'sleep 30\n');
      const outcome = runSetupScript({
        workspace,
        manifest: manifestWith({ script: '.fleet/setup.sh' }),
        markerPath: absentMarker(workspace),
        timeoutMs: 200,
      });
      assert.equal(outcome.kind, 'failed');
      assert.match((outcome as { detail: string }).detail, /timed out/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ---------- unit: dropPrivileges (#196) ----------
//
// The real drop (root → uid 1000) only happens inside the runner container and
// is asserted on live jobs in test/cli-image.test.ts (FLEET_TEST_DOCKER=1).
// What can and must hold on any host: a non-root process is a clean no-op.
// The plausible bug: an unconditional setuid throws EPERM off-root, which
// would cancel every process-provider job on the drop that #196 added.

describe('dropPrivileges', () => {
  test('not root → skipped, and nothing is mutated', { skip: process.getuid?.() === 0 ? 'test host is root' : false }, () => {
    const workspace = tempWorkspace();
    const homeBefore = process.env.HOME;
    const userBefore = process.env.USER;
    try {
      const outcome = dropPrivileges(workspace);
      assert.equal(outcome.kind, 'skipped', JSON.stringify(outcome));
      assert.equal(process.env.HOME, homeBefore, 'a skipped drop must not rehome the process');
      assert.equal(process.env.USER, userBefore);
      assert.notEqual(process.getuid?.(), 0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('setupBakedMarkerPath', () => {
  test('defaults to $HOME/.fleet-setup-baked; FLEET_SETUP_MARKER overrides', () => {
    assert.equal(setupBakedMarkerPath({}), join(homedir(), SETUP_BAKED_BASENAME));
    assert.equal(setupBakedMarkerPath({ FLEET_SETUP_MARKER: '/x/marker' }), '/x/marker');
  });
});

// ---------- through the real runner: acceptance for #49 (one-layer) ----------

function writeWorkspace(pickup: string, setupScript?: string): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-setup-run-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  writeFileSync(
    join(workspace, '.fleet', 'manifest.json'),
    JSON.stringify({
      version: 1,
      setup: { image: 'node:22', script: '.fleet/setup.sh' },
      workspace: { repo: 'git@github.com:acme/example.git', strategy: 'branch-per-job' },
      harness: {
        cli: 'claude-code',
        commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
      },
      gates: { pickup },
    }),
  );
  if (setupScript !== undefined) {
    writeFileSync(join(workspace, '.fleet', 'setup.sh'), setupScript);
  }
  return workspace;
}

function runRunner(env: Record<string, string>): Promise<number> {
  // Strip fleet job env this test process may itself have inherited.
  const { FLEET_GIT_URL: _u, FLEET_GIT_NAME: _n, FLEET_GIT_EMAIL: _e, ...parentEnv } = process.env;
  const child = spawn(process.execPath, [runnerMain], {
    env: { ...parentEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));
  return exited.promise;
}

test('setup.script runs before the pickup gate and is observable in the event log', async () => {
  const token = 'test-token-setup-1';
  const daemon = await startMockDaemon({ token });
  // The gate PASSES only if setup already ran — this is the ordering proof,
  // and the pre-fix failure mode: no setup pass → gate fails → job cancelled.
  const workspace = writeWorkspace(
    `node -e "process.exit(require('node:fs').existsSync('setup-ran.txt')?0:1)"`,
    'echo ok > setup-ran.txt\n',
  );
  try {
    const exitCode = await runRunner({
      FLEET_JOB_ID: 'job-setup-1',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_SETUP_MARKER: join(workspace, 'no-such-marker'),
      FLEET_HARNESS_CMD: `node -e "process.exit(0)"`,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(daemon.rejected, []);

    const cancelled = daemon.events.find((e) => e.type === 'state' && e.state === 'cancelled');
    assert.equal(cancelled, undefined, 'setup must run before the gate probes for its output');

    const logs = daemon.events.filter((e) => e.type === 'log').map((e) => String(e.text));
    const announceAt = logs.findIndex((t) => t === 'setup script: .fleet/setup.sh');
    const ranAt = logs.findIndex((t) => /^setup script \.fleet\/setup\.sh ok \(\d+s\)$/.test(t));
    const gateAt = logs.findIndex((t) => t.startsWith('pickup gate:'));
    assert.ok(announceAt >= 0, `no setup announce in: ${logs.join(' | ')}`);
    assert.ok(ranAt > announceAt, `no setup outcome in: ${logs.join(' | ')}`);
    assert.ok(gateAt > ranAt, 'the gate must be announced after setup completed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('a baked image (marker present) skips the workspace setup pass, observably', async () => {
  const token = 'test-token-setup-2';
  const daemon = await startMockDaemon({ token });
  // The gate PASSES only if setup did NOT run: running a baked script twice is
  // the bug the marker exists to prevent.
  const workspace = writeWorkspace(
    `node -e "process.exit(require('node:fs').existsSync('setup-ran.txt')?1:0)"`,
    'echo ok > setup-ran.txt\n',
  );
  const marker = join(workspace, 'baked-marker');
  writeFileSync(marker, '2026-08-24T00:00:00Z\n');
  try {
    const exitCode = await runRunner({
      FLEET_JOB_ID: 'job-setup-2',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_SETUP_MARKER: marker,
      FLEET_HARNESS_CMD: `node -e "process.exit(0)"`,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(daemon.rejected, []);
    const logs = daemon.events.filter((e) => e.type === 'log').map((e) => String(e.text));
    assert.ok(
      logs.some((t) => t.includes('baked into the image; skipping')),
      `no baked-skip line in: ${logs.join(' | ')}`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('a failing setup.script cancels the job before the gate, reason setup-script', async () => {
  const token = 'test-token-setup-3';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace(
    `node -e "process.exit(0)"`,
    'echo "boom: apt is gone" >&2\nexit 7\n',
  );
  try {
    const exitCode = await runRunner({
      FLEET_JOB_ID: 'job-setup-3',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_SETUP_MARKER: join(workspace, 'no-such-marker'),
      FLEET_HARNESS_CMD: `node -e "process.exit(0)"`,
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(daemon.rejected, []);

    const logs = daemon.events.filter((e) => e.type === 'log').map((e) => String(e.text));
    assert.ok(!logs.some((t) => t.startsWith('pickup gate:')), 'the gate must not run after a failed setup');

    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'a failed setup still settles');
    const report = settle.report as Record<string, unknown>;
    assert.equal(report.status, 'BLOCKED');
    assert.match(String(report.next_action), /fix setup script: exit 7/);
    assert.match(String(report.next_action), /boom: apt is gone/);

    const cancelled = daemon.events.find((e) => e.type === 'state' && e.state === 'cancelled');
    assert.ok(cancelled, 'a failed setup cancels the job');
    assert.equal(cancelled.reason, 'setup-script');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});
