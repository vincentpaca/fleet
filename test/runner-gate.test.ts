import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDaemon } from './runner-mock-daemon.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
const repoGate = fileURLToPath(new URL('../.fleet/gate.mjs', import.meta.url));

function writeManifest(workspace: string, pickup: string): void {
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
}

// #56: this repo's own gate, run for real by the runner. An investigate-mode
// prose dispatch must clear it (no gh, no issue) and reach the artifact settle;
// the same dispatch under the implement default must die at the gate instead.
test("investigate-mode prose dispatch clears this repo's gate and settles with a report artifact", async () => {
  const token = 'test-token-gate-mode';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-gate-mode-'));
  try {
    writeManifest(workspace, `node ${repoGate}`);
    writeFileSync(
      join(workspace, '.fleet', 'order.json'),
      JSON.stringify({
        mode: 'investigate',
        target: 'why do queued jobs sit behind the capacity cap',
        finish: 'inspected',
      }),
    );
    // Investigate harness: the deliverable is the artifact, not a branch.
    const harness =
      `node -e "const fs=require('node:fs');` +
      `fs.mkdirSync('.fleet/out/artifacts',{recursive:true});` +
      `fs.writeFileSync('.fleet/out/artifacts/findings.md','# Findings\\n');` +
      `fs.writeFileSync('.fleet/out/report.json',JSON.stringify(` +
      `{status:'READY',next_action:'read the findings',verification:['queue depth sampled'],not_done:[]}))"`;

    // FLEET_MODE/FLEET_TARGET outrank the staged order inside the gate: if this
    // test process is itself a fleet job, an inherited value would decide the
    // assertion instead of the fixture.
    const {
      FLEET_GIT_URL: _u, FLEET_GIT_NAME: _n, FLEET_GIT_EMAIL: _e,
      FLEET_MODE: _m, FLEET_TARGET: _t, ...parentEnv
    } = process.env;
    const child = spawn(process.execPath, [runnerMain], {
      env: {
        ...parentEnv,
        FLEET_JOB_ID: 'job-gate-mode',
        FLEET_DAEMON_URL: daemon.url,
        FLEET_RUNNER_TOKEN: token,
        FLEET_WORKSPACE: workspace,
        FLEET_HARNESS_CMD: harness,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = Promise.withResolvers<number>();
    child.on('close', (code) => exited.resolve(code ?? -1));
    assert.equal(await exited.promise, 0);

    assert.deepEqual(daemon.rejected, []);
    const cancelled = daemon.events.find((event) => event.type === 'state' && event.state === 'cancelled');
    assert.equal(cancelled, undefined, 'the gate must not abort a report-only dispatch');

    const settle = daemon.events.find((event) => event.type === 'settle');
    assert.ok(settle, 'settle event posted');
    const outcome = settle.outcome;
    assert.ok(outcome && typeof outcome === 'object' && 'produced' in outcome);
    const produced = outcome.produced as { path: string }[];
    assert.deepEqual(produced.map((entry) => entry.path), ['findings.md']);
    assert.equal(daemon.artifacts.length, 1);
    assert.equal(daemon.artifacts[0].path, 'findings.md');
    // The report travels too: artifacts are collected on an independent path,
    // so produced[] alone would still pass if a schema-invalid report were
    // dropped by the runner.
    const report = settle.report;
    assert.ok(report && typeof report === 'object' && 'status' in report);
    assert.equal(report.status, 'READY');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test("the same prose dispatch under the implement default dies at this repo's gate", async () => {
  const token = 'test-token-gate-mode-2';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-gate-mode-'));
  try {
    writeManifest(workspace, `node ${repoGate}`);
    writeFileSync(
      join(workspace, '.fleet', 'order.json'),
      JSON.stringify({
        mode: 'implement',
        target: 'why do queued jobs sit behind the capacity cap',
        finish: 'merge-ready',
      }),
    );

    const {
      FLEET_GIT_URL: _u2, FLEET_GIT_NAME: _n2, FLEET_GIT_EMAIL: _e2,
      FLEET_MODE: _m2, FLEET_TARGET: _t2, ...parentEnv
    } = process.env;
    const child = spawn(process.execPath, [runnerMain], {
      env: {
        ...parentEnv,
        FLEET_JOB_ID: 'job-gate-mode-2',
        FLEET_DAEMON_URL: daemon.url,
        FLEET_RUNNER_TOKEN: token,
        FLEET_WORKSPACE: workspace,
        FLEET_HARNESS_CMD: `node -e "process.exit(0)"`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = Promise.withResolvers<number>();
    child.on('close', (code) => exited.resolve(code ?? -1));
    assert.equal(await exited.promise, 1);

    const cancelled = daemon.events.find((event) => event.type === 'state' && event.state === 'cancelled');
    assert.equal(cancelled?.reason, 'pickup-gate');
    const settle = daemon.events.find((event) => event.type === 'settle');
    const report = settle?.report;
    assert.ok(report && typeof report === 'object' && 'next_action' in report);
    assert.match(String(report.next_action), /implement mode requires a ready GitHub issue/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('pickup gate failure settles BLOCKED and cancels with reason pickup-gate', async () => {
  const token = 'test-token-gate';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-gate-'));
  try {
    writeManifest(
      workspace,
      `node -e "console.log('missing dependency: widget'); console.log('more detail'); process.exit(3)"`,
    );

    // Strip fleet job env vars that the test process inherits from its own runner
    // context — if FLEET_GIT_URL is set the child runner tries to use it.
    const { FLEET_GIT_URL: _gitUrl, FLEET_GIT_NAME: _gitName, FLEET_GIT_EMAIL: _gitEmail, ...parentEnv } = process.env;
    const child = spawn(process.execPath, [runnerMain], {
      env: {
        ...parentEnv,
        FLEET_JOB_ID: 'job-gate-1',
        FLEET_DAEMON_URL: daemon.url,
        FLEET_RUNNER_TOKEN: token,
        FLEET_WORKSPACE: workspace,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = Promise.withResolvers<number>();
    child.on('close', (code) => exited.resolve(code ?? -1));
    const exitCode = await exited.promise;

    // Nonzero-clean: failure exit code, but every event flushed and accepted.
    assert.equal(exitCode, 1);
    assert.deepEqual(daemon.rejected, []);
    assert.equal(daemon.badTokenCount, 0);

    // The log line is the gate announcing itself before it runs (#39): the gate
    // is a blocking spawnSync, and the daemon's stall backstop reads silence on
    // the event stream, so an unannounced gate is indistinguishable from a wedge.
    assert.deepEqual(
      daemon.events.map((event) => event.type),
      ['state', 'log', 'settle', 'state'],
    );
    assert.deepEqual(daemon.events.map((event) => event.seq), [0, 1, 2, 3]);
    assert.ok(daemon.events.every((event) => event.job === 'job-gate-1'));

    const [running, gateLog, settle, cancelled] = daemon.events;
    assert.match(String(gateLog.text), /^pickup gate: /);
    assert.equal(running.state, 'running');

    assert.deepEqual(settle.outcome, { produced: [], findings: 0, decisions: 0 });
    assert.deepEqual(settle.report, {
      status: 'BLOCKED',
      next_action: 'fix pickup gate: missing dependency: widget',
    });

    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.reason, 'pickup-gate');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('gate failure with stderr-only output uses the stderr first line', async () => {
  const token = 'test-token-gate-2';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-gate-'));
  try {
    writeManifest(
      workspace,
      `node -e "console.error('fetch failed: remote unreachable'); process.exit(1)"`,
    );

    const { FLEET_GIT_URL: _gitUrl2, FLEET_GIT_NAME: _gitName2, FLEET_GIT_EMAIL: _gitEmail2, ...parentEnv2 } = process.env;
    const child = spawn(process.execPath, [runnerMain], {
      env: {
        ...parentEnv2,
        FLEET_JOB_ID: 'job-gate-2',
        FLEET_DAEMON_URL: daemon.url,
        FLEET_RUNNER_TOKEN: token,
        FLEET_WORKSPACE: workspace,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = Promise.withResolvers<number>();
    child.on('close', (code) => exited.resolve(code ?? -1));
    assert.equal(await exited.promise, 1);

    const settle = daemon.events.find((event) => event.type === 'settle');
    assert.ok(settle, 'settle event posted');
    const report = settle.report;
    assert.ok(report && typeof report === 'object' && 'next_action' in report);
    assert.equal(report.next_action, 'fix pickup gate: fetch failed: remote unreachable');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});
