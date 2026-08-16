import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDaemon } from './runner-mock-daemon.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
const fixturePath = fileURLToPath(
  new URL('./fixtures/harness-stream.ndjson', import.meta.url),
);

// Fake harness: replays the fixture stream on stdout and writes its report
// mid-run — like a real harness; the runner wipes .fleet/out at startup, so
// pre-staged reports never survive (that is the ghost-decision fix).
const REPLAY_CMD =
  `node -e "const fs=require('node:fs');fs.writeFileSync('.fleet/out/report.json',process.env.FLEET_REPORT);process.stdout.write(fs.readFileSync(process.env.FLEET_FIXTURE,'utf8'))"`;

function writeWorkspace(pickup: string): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-happy-'));
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
  return workspace;
}

function runRunner(env: Record<string, string>): Promise<number> {
  const child = spawn(process.execPath, [runnerMain], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));
  return exited.promise;
}

test('full happy path: running → gate ok → harness replay → settle → done', async () => {
  const token = 'test-token-happy';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace(`node -e "process.exit(0)"`);
  try {
    const report = {
      status: 'READY',
      next_action: 'open the pull request',
      implemented: ['generic feature'],
      verification: ['fixture replay completed'],
    };

    const exitCode = await runRunner({
      FLEET_JOB_ID: 'job-happy-1',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: REPLAY_CMD,
      FLEET_FIXTURE: fixturePath,
      FLEET_REPORT: JSON.stringify(report),
    });
    assert.equal(exitCode, 0);

    // Every posted event passed schema validation at intake — the mock
    // daemon 422s anything invalid, which would have failed the run.
    assert.deepEqual(daemon.rejected, []);
    assert.equal(daemon.badTokenCount, 0);

    const types = daemon.events.map((event) => event.type);
    assert.deepEqual(types, [
      'state', // running
      'log', // system init line
      'think', // planning text
      'log', // tool_use Read
      'log', // tool_result toolu_01
      'think', // implementing text (batched with the Write tool_use)
      'log', // tool_use Write
      'log', // tool_result toolu_02
      'log', // unknown structured line
      'log', // non-JSON line
      'settle',
      'state', // done
    ]);

    // Runner-owned seq: starts at 0, strictly monotonic, gap-free.
    assert.deepEqual(
      daemon.events.map((event) => event.seq),
      daemon.events.map((_, index) => index),
    );
    assert.ok(daemon.events.every((event) => event.job === 'job-happy-1'));

    const [running] = daemon.events;
    assert.equal(running.state, 'running');

    const settle = daemon.events.at(-2);
    assert.ok(settle);
    assert.equal(settle.rung, 'implemented');
    assert.deepEqual(settle.outcome, { produced: [], findings: 0, decisions: 0 });
    assert.deepEqual(settle.report, report);
    assert.ok(typeof settle.minutes === 'number' && settle.minutes >= 0);

    const done = daemon.events.at(-1);
    assert.ok(done);
    assert.equal(done.state, 'done');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('harness nonzero exit → settle partial + state cancelled reason harness-exit', async () => {
  const token = 'test-token-happy-2';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace(`node -e "process.exit(0)"`);
  try {
    const exitCode = await runRunner({
      FLEET_JOB_ID: 'job-happy-2',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD:
        `node -e "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'partial work'}]}})); console.error('ran out of budget'); process.exit(2)"`,
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(daemon.rejected, []);

    const types = daemon.events.map((event) => event.type);
    assert.deepEqual(types, ['state', 'think', 'settle', 'state']);

    const settle = daemon.events[2];
    assert.equal(settle.rung, undefined, 'no rung claimed on failure');
    assert.deepEqual(settle.outcome, { produced: [], findings: 0, decisions: 0 });
    const report = settle.report;
    assert.ok(report && typeof report === 'object' && 'status' in report);
    assert.equal(report.status, 'PARTIAL');
    assert.ok('next_action' in report);
    assert.match(String(report.next_action), /harness exit 2/);

    const cancelled = daemon.events[3];
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.reason, 'harness-exit');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});
