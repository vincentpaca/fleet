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
      'log', // setup script announced (#49: runs before the gate when unbaked)
      'log', // setup outcome (not on disk in this workspace → skipping, observably)
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
      'log', // empty-handed note (#81): no git, no PR, no artifacts in this run
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

    // The run pushed nothing, opened no PR and delivered no artifacts, so the
    // empty-handed note (#81) precedes the settle and rides its not_done.
    const emptyHanded = daemon.events.at(-3);
    assert.ok(emptyHanded);
    assert.match(String(emptyHanded.text), /no deliverable landed/);

    const settle = daemon.events.at(-2);
    assert.ok(settle);
    assert.equal(settle.rung, 'implemented');
    assert.deepEqual(settle.outcome, { produced: [], findings: 0, decisions: 0 });
    const settleReport = settle.report as Record<string, unknown>;
    const { not_done: notDone, ...rest } = settleReport;
    assert.deepEqual(rest, report, 'the harness report survives intact');
    assert.ok(Array.isArray(notDone) && notDone.length === 1);
    assert.match(String(notDone[0]), /no deliverable landed/);
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
    // The first two logs are the setup-script announce + skip (#49); the extra
    // log before settle is the empty-handed note (#81): a failed run that also
    // delivered nothing says so too.
    assert.deepEqual(types, ['state', 'log', 'log', 'log', 'log', 'think', 'log', 'settle', 'state']);

    const settle = daemon.events[7];
    assert.equal(settle.rung, undefined, 'no rung claimed on failure');
    assert.deepEqual(settle.outcome, { produced: [], findings: 0, decisions: 0 });
    const report = settle.report;
    assert.ok(report && typeof report === 'object' && 'status' in report);
    assert.equal(report.status, 'PARTIAL');
    assert.ok('next_action' in report);
    assert.match(String(report.next_action), /harness exit 2/);

    const cancelled = daemon.events[8];
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.reason, 'harness-exit');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- Prose delivery is prompt-owned; the runner grades reality (#36, #208) ---

/** Stage a prose order: no publish authority, no mode — the shape's own row. */
function stageProseOrder(workspace: string): void {
  writeFileSync(
    join(workspace, '.fleet', 'order.json'),
    JSON.stringify({
      // No mode field: a prose target is the shape, and `publish` is the only
      // authority bit anything reads.
      target: 'why do queued jobs sit behind the capacity cap',
      finish: 'inspected',
      authority: { publish: false, merge: false, deploy: false },
    }),
  );
}

/** Stage an issue-shaped delivery order: publish granted, merge-ready target. */
function stageIssueOrder(workspace: string): void {
  writeFileSync(
    join(workspace, '.fleet', 'order.json'),
    JSON.stringify({
      target: '61',
      finish: 'merge-ready',
      authority: { publish: true, merge: false, deploy: false },
    }),
  );
}

/**
 * A stateful fake `gh` for PATH: `pr create` records that a PR now exists and
 * prints its URL (what the agent's own call sees); `pr list --head <branch>`
 * answers with that PR when one was created, `[]` otherwise (what the runner's
 * findOpenPr grading reads at settle). One binary drives both sides so the
 * test exercises the real settle path, not a canned lookup.
 */
function fakeGhPrBin(prUrl: string): { bin: string; calls: () => string[] } {
  const bin = mkdtempSync(join(tmpdir(), 'fleet-happy-gh-'));
  const log = join(bin, 'gh-calls.log');
  const marker = join(bin, 'pr-created');
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "pr create") touch "${marker}"; echo "${prUrl}";;
  "pr list") if [ -f "${marker}" ]; then echo '[{"url":"${prUrl}","number":99}]'; else echo '[]'; fi;;
  *) echo '[]';;
esac
`,
    { mode: 0o755 },
  );
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

/** A bare remote with a `main` to branch from. */
function makeFreshRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-happy-fresh-'));
  const remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  const g = (args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Operator One', '-c', 'user.email=op@example.com', ...args], { cwd: seed, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'seed']);
  g(['push', '-q', remote, 'main']);
  return remote;
}

/** Run one staged order to settle and report what the runner did about a PR. */
async function settleRun(opts: {
  jobId: string;
  token: string;
  stageOrder: (workspace: string) => void;
  harnessCmd: string;
}): Promise<{ rung: unknown; report: Record<string, unknown>; ghCalls: string[]; logs: string[] }> {
  const daemon = await startMockDaemon({ token: opts.token });
  const remote = makeFreshRemote();
  const workspace = writeWorkspace(`node -e "process.exit(0)"`);
  opts.stageOrder(workspace);
  const gh = fakeGhPrBin('https://github.com/acme/example-app/pull/99');
  try {
    const exitCode = await runRunner({
      FLEET_JOB_ID: opts.jobId,
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: opts.token,
      FLEET_WORKSPACE: workspace,
      FLEET_GIT_URL: remote,
      FLEET_GIT_NAME: 'Operator One',
      FLEET_GIT_EMAIL: 'op@example.com',
      PATH: `${gh.bin}:${process.env.PATH ?? ''}`,
      FLEET_HARNESS_CMD: opts.harnessCmd,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(daemon.rejected, []);
    const settle = daemon.events.find((e) => e.type === 'settle');
    assert.ok(settle, 'settle event posted');
    return {
      rung: settle.rung,
      report: (settle.report ?? {}) as Record<string, unknown>,
      ghCalls: gh.calls(),
      logs: daemon.events.filter((e) => e.type === 'log').map((e) => String(e.text)),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
}

/** Writes a work commit, so the settle has a delivery to grade. */
const WRITE_NOTES_CMD = `node -e "require('node:fs').writeFileSync('notes.md','findings\\n')"`;

test('prose whose agent opens nothing settles at pushed with no runner-composed PR', async () => {
  // Half of #208's grading promise, and the product promise it carries over
  // from #36: an open-ended prompt cannot quietly become a pull request — the
  // runner composes no PR for a prose dispatch, and the settle claims none.
  const run = await settleRun({
    jobId: 'job-prose-nopub',
    token: 'test-token-prose-1',
    stageOrder: stageProseOrder,
    harnessCmd: WRITE_NOTES_CMD,
  });
  assert.ok(
    !run.ghCalls.some((c) => c.startsWith('pr create')),
    `no PR may be created without publish authority, saw: ${run.ghCalls.join(' | ')}`,
  );
  assert.ok(!run.logs.some((t) => t.includes('draft PR opened')), 'and it must not claim one');
  assert.equal(run.report.pr, undefined, 'no PR in the settle report');
  // The branch is still pushed — evidence has to survive the container — so the
  // rung reached is `pushed`, not `inspected`. That is exactly why a repo's
  // default_finish is skipped only for rungs above this one (D17).
  assert.equal(run.rung, 'pushed');
});

test('prose whose agent opened a PR itself settles at pr-open (#208)', async () => {
  // The other half: delivery is prompt-owned, so when the prompt asked for a
  // PR and the agent ran `gh pr create` on the job branch, the settle grades
  // reality — pr-open, exceeding the prose `inspected` target (D6 blesses
  // exceeding). The bug this catches: the runner keying the rung on the
  // publish bit instead of on what actually happened, which would report an
  // existing, reviewable PR as mere `pushed` and hide it from the board.
  const run = await settleRun({
    jobId: 'job-prose-agentpr',
    token: 'test-token-prose-2',
    stageOrder: stageProseOrder,
    harnessCmd:
      `node -e "require('node:fs').writeFileSync('notes.md','findings\\n');` +
      `require('node:child_process').execFileSync('gh',['pr','create','--draft','--title','t','--body','b'])"`,
  });
  assert.equal(run.rung, 'pr-open');
  assert.equal(run.report.pr, 'https://github.com/acme/example-app/pull/99', 'the agent-opened PR is the settle PR');
  assert.ok(run.logs.some((t) => t.includes('agent-opened PR detected')), 'the settle says how the PR got there');
  assert.equal(
    run.ghCalls.filter((c) => c.startsWith('pr create')).length,
    1,
    `only the agent's own pr create may run — the runner never composes a prose PR, saw: ${run.ghCalls.join(' | ')}`,
  );
});

test('an issue dispatch still ends in a runner-composed draft PR', async () => {
  // #208 removes only the prose-side flag: publish stays the issue/adoption
  // contract, and the runner composing the draft PR from the settle report is
  // Fleet's return-path job, not a stylistic choice.
  const run = await settleRun({
    jobId: 'job-issue-pub',
    token: 'test-token-issue-1',
    stageOrder: stageIssueOrder,
    harnessCmd: WRITE_NOTES_CMD,
  });
  assert.ok(
    run.ghCalls.some((c) => c.startsWith('pr create')),
    `authority.publish must reach pr create, saw: ${run.ghCalls.join(' | ')}`,
  );
  assert.equal(run.rung, 'pr-open');
  assert.ok(run.logs.some((t) => t.includes('draft PR opened')), 'and the PR is reported');
});
