import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  `node -e "const fs=require('node:fs');fs.writeFileSync('.fleet/out/report.json',process.env.TEST_REPORT);process.stdout.write(fs.readFileSync(process.env.TEST_FIXTURE,'utf8'))"`;

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
  // Strip fleet job env vars that the test process inherits from its own runner
  // context — if FLEET_GIT_URL is set, the child runner would try to use it and
  // emit unexpected log events that break the event-sequence assertions.
  const { FLEET_GIT_URL: _gitUrl, FLEET_GIT_NAME: _gitName, FLEET_GIT_EMAIL: _gitEmail, ...parentEnv } = process.env;
  const child = spawn(process.execPath, [runnerMain], {
    env: { ...parentEnv, ...env },
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
      TEST_FIXTURE: fixturePath,
      TEST_REPORT: JSON.stringify(report),
    });
    assert.equal(exitCode, 0);

    // Every posted event passed schema validation at intake — the mock
    // daemon 422s anything invalid, which would have failed the run.
    assert.deepEqual(daemon.rejected, []);
    assert.equal(daemon.badTokenCount, 0);

    const types = daemon.events.map((event) => event.type);
    assert.deepEqual(types, [
      'state', // running
      'log', // pickup gate announced (#39: the gate emits nothing itself)
      'log', // gate passed, harness command
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

// --- Followthrough continuation (#80): the runner adopts the PR branch end to end ---

/** A bare remote with main plus a delivered job branch (what a settled PR points at). */
function makeContinuationRemote(): { remote: string; branch: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-happy-git-'));
  const remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  const branch = 'fleet/9-job-old';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  const g = (args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Operator One', '-c', 'user.email=op@example.com', ...args], { cwd: seed, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'seed']);
  g(['push', '-q', remote, 'main']);
  g(['checkout', '-q', '-b', branch]);
  writeFileSync(join(seed, 'delivered.txt'), 'v1\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'delivered']);
  g(['push', '-q', remote, branch]);
  return { remote, branch };
}

/** A bin dir whose `gh` prints the given JSON and records its args; for PATH. */
function fakeGhBin(stdout: string): { bin: string; calls: () => string[] } {
  const bin = mkdtempSync(join(tmpdir(), 'fleet-happy-gh-'));
  const log = join(bin, 'gh-calls.log');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${log}"\ncat <<'EOF'\n${stdout}\nEOF\n`, { mode: 0o755 });
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

/** Stage a followthrough order carrying continues into the workspace. */
function stageContinuationOrder(workspace: string, branch: string): void {
  writeFileSync(
    join(workspace, '.fleet', 'order.json'),
    JSON.stringify({
      mode: 'followthrough',
      target: '9',
      finish: 'merge-ready',
      authority: { edit: true, publish: true },
      continues: { pr: 41, branch },
    }),
  );
}

test('followthrough continuation: adopts the PR branch, pushes to it, reports the existing PR', async () => {
  const token = 'test-token-continue-1';
  const daemon = await startMockDaemon({ token });
  const { remote, branch } = makeContinuationRemote();
  const workspace = writeWorkspace(`node -e "process.exit(0)"`);
  stageContinuationOrder(workspace, branch);
  const prUrl = 'https://github.com/acme/example-app/pull/41';
  const gh = fakeGhBin(`[{"url":"${prUrl}","number":41}]`);
  try {
    const exitCode = await runRunner({
      FLEET_JOB_ID: 'job-continue-1',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_GIT_URL: remote,
      FLEET_GIT_NAME: 'Operator One',
      FLEET_GIT_EMAIL: 'op@example.com',
      PATH: `${gh.bin}:${process.env.PATH ?? ''}`,
      FLEET_HARNESS_CMD: `node -e "require('node:fs').writeFileSync('fix.txt','review feedback addressed\\n')"`,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(daemon.rejected, []);

    const logs = daemon.events.filter((e) => e.type === 'log').map((e) => String(e.text));
    assert.ok(
      logs.some((t) => t.includes(`workspace adopted branch ${branch} (continues PR #41)`)),
      `no adoption log in: ${logs.join(' | ')}`,
    );

    // The settle claims the EXISTING PR, at pr-open — no PR was created.
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle);
    assert.equal(settle.rung, 'pr-open');
    const report = settle.report as Record<string, unknown>;
    assert.equal(report.pr, prUrl, 'the existing PR is the settle PR');
    const ghCalls = gh.calls();
    assert.ok(ghCalls.some((c) => c.startsWith('pr list')), `expected a pr list lookup, saw: ${ghCalls.join(' | ')}`);
    assert.ok(!ghCalls.some((c) => c.startsWith('pr create')), 'a continuation must never create a PR');

    // The fix landed on the SAME branch (the PR updates in place), and no
    // fresh job branch exists — the bug this catches: adoption falling back to
    // the fresh-branch path, stranding the PR.
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: remote, encoding: 'utf8' });
    assert.match(files, /fix\.txt/);
    const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
    assert.ok(!refs.includes('job-continue-1'), 'no fresh branch may be created on adoption');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('followthrough continuation that changes nothing claims no rung', async () => {
  // The bug this catches: judging delivery by ahead-of-base — an adopted
  // branch is always ahead of base, so a do-nothing followthrough would claim
  // 'delivered' and ride the ladder to pr-open having done no work.
  const token = 'test-token-continue-2';
  const daemon = await startMockDaemon({ token });
  const { remote, branch } = makeContinuationRemote();
  const workspace = writeWorkspace(`node -e "process.exit(0)"`);
  stageContinuationOrder(workspace, branch);
  const gh = fakeGhBin('[]');
  try {
    const exitCode = await runRunner({
      FLEET_JOB_ID: 'job-continue-2',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_GIT_URL: remote,
      FLEET_GIT_NAME: 'Operator One',
      FLEET_GIT_EMAIL: 'op@example.com',
      PATH: `${gh.bin}:${process.env.PATH ?? ''}`,
      FLEET_HARNESS_CMD: `node -e "process.exit(0)"`,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(daemon.rejected, []);

    const logs = daemon.events.filter((e) => e.type === 'log').map((e) => String(e.text));
    assert.ok(
      logs.some((t) => t.includes(`no new commits beyond the adopted tip of ${branch}`)),
      `no honest push note in: ${logs.join(' | ')}`,
    );
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle);
    assert.equal(settle.rung, undefined, 'a do-nothing continuation must claim no rung');
    assert.ok(!gh.calls().some((c) => c.startsWith('pr')), 'no PR lookup or creation without a delivery');
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
    assert.deepEqual(types, ['state', 'log', 'log', 'think', 'settle', 'state']);

    const settle = daemon.events[4];
    assert.equal(settle.rung, undefined, 'no rung claimed on failure');
    assert.deepEqual(settle.outcome, { produced: [], findings: 0, decisions: 0 });
    const report = settle.report;
    assert.ok(report && typeof report === 'object' && 'status' in report);
    assert.equal(report.status, 'PARTIAL');
    assert.ok('next_action' in report);
    assert.match(String(report.next_action), /harness exit 2/);

    const cancelled = daemon.events[5];
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.reason, 'harness-exit');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});
