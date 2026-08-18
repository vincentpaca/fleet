// Push-failure retention (#38), over the real wire: CLI -> daemon ->
// ProcessProvider -> real runner -> a harness that takes the remote down
// mid-run. The workspace must survive (it is the only copy of the work), be
// registered under $FLEET_HOME/retained/, and be recoverable with
// `fleet resume-push` once the remote comes back. The successful-push case
// still deletes the workspace and registers nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { FleetDaemon } from '../src/daemon/server.ts';
import { ProcessProvider } from '../src/providers/process.ts';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli', 'main.ts');
const harness = join(here, '..', 'fixtures', 'outage-harness.mjs');

// Real child processes and a live long-poll: fake timers cannot drive another
// process's clock, so a short real delay is the only workable wait.
const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Bare git remote seeded with main — the job branch and work push land here. */
function makeRemote(dir: string): string {
  const bare = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  const g = ['-c', 'user.name=Operator One', '-c', 'user.email=op@example.com'];
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  execFileSync('git', [...g, 'add', '-A'], { cwd: seed });
  execFileSync('git', [...g, 'commit', '-q', '-m', 'seed'], { cwd: seed });
  execFileSync('git', [...g, 'push', '-q', bare, 'main'], { cwd: seed });
  return bare;
}

const manifest = (repo: string) => ({
  version: 1,
  setup: { image: 'node:22', script: '.fleet/setup.sh' },
  workspace: { repo, strategy: 'branch-per-job' },
  env: { vars: ['FLEET_HARNESS_CMD', 'TEST_OUTAGE_REMOTE'] },
  harness: {
    cli: 'claude-code',
    commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
  },
  gates: { pickup: 'node -e "process.exit(0)"', default_finish: 'implemented' },
});

type Rig = {
  home: string;
  project: string;
  remote: string;
  workspaceRoot: string;
  fleet: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  daemon: FleetDaemon;
};

/**
 * Stand up home + project + bare remote + daemon on the ProcessProvider, with a
 * `fleet` runner bound to them. `outage` decides whether the fake harness moves
 * the remote aside before the runner's work push.
 */
async function rig(outage: boolean): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), 'fleet-retain-home-'));
  const project = mkdtempSync(join(tmpdir(), 'fleet-retain-proj-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'fleet-retain-ws-'));
  const remote = makeRemote(mkdtempSync(join(tmpdir(), 'fleet-retain-git-')));
  mkdirSync(join(project, '.fleet'), { recursive: true });
  writeFileSync(join(project, '.fleet', 'manifest.json'), JSON.stringify(manifest(remote), null, 2));

  const daemon = new FleetDaemon({
    home,
    provider: new ProcessProvider({ workspaceRoot, home }),
    port: 0,
    longPollMs: 1_000,
  });
  const { port } = await daemon.start();
  assert.ok(port, 'daemon must bind a TCP port');

  // The provider runs in this process and reads FLEET_KEEP_WORKSPACE from it;
  // an inherited keep flag would mask both behaviours under test.
  delete process.env.FLEET_KEEP_WORKSPACE;

  const env = {
    ...process.env,
    FLEET_HOME: home,
    FLEET_DAEMON_URL: `http://127.0.0.1:${port}`,
    FLEET_HARNESS_CMD: `node ${harness}`,
    TEST_OUTAGE_REMOTE: outage ? remote : '',
    // `fleet delegate` refuses without a git identity; supply one through git's
    // own env config so the test does not depend on the machine's ~/.gitconfig.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Operator One',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'op@example.com',
  };
  const fleet = (args: string[]) => run('node', [cli, ...args], { cwd: project, env });
  return { home, project, remote, workspaceRoot, fleet, daemon };
}

/** Dispatch and wait for a terminal state; returns the job id. */
async function dispatch(r: Rig, target: string): Promise<string> {
  const delegated = await r.fleet(['delegate', target, '--mode', 'implement', '--finish', 'implemented']);
  const jobId = delegated.stdout.trim().split(/\s+/).find((w) => w.startsWith('job-'));
  assert.ok(jobId, `no job id in delegate output: ${delegated.stdout}`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { stdout } = await r.fleet(['status', jobId]);
    if (/\b(done|cancelled)\b/i.test(stdout)) return jobId;
    assert.ok(Date.now() < deadline, `timed out waiting for a terminal state; last status:\n${stdout}`);
    await delay(250);
  }
}

const jobWorkspaces = (root: string, jobId: string): string[] =>
  readdirSync(root).filter((name) => name.startsWith(`fleet-${jobId}-`));

test('work push fails: workspace retained, registered, and recovered by resume-push', async (t) => {
  const r = await rig(true);
  t.after(() => r.daemon.stop());

  const jobId = await dispatch(r, 'APP-123');

  // 1. It is registered, so it cannot leak silently. The record is written by
  //    the provider's exit handler — the same handler that would otherwise
  //    delete the directory — so wait for it before judging the directory.
  const recordPath = join(r.home, 'retained', `${jobId}.json`);
  const recordDeadline = Date.now() + 10_000;
  while (!existsSync(recordPath)) {
    assert.ok(Date.now() < recordDeadline, `no retained record at ${recordPath}`);
    await delay(100);
  }

  // 2. The directory is still there — it is the only copy of the work.
  const kept = jobWorkspaces(r.workspaceRoot, jobId);
  assert.equal(kept.length, 1, `expected the workspace to survive a failed push, found ${kept.length}`);
  const workspace = join(r.workspaceRoot, kept[0]);
  assert.ok(existsSync(join(workspace, 'work.txt')), 'the harness edit must still be on disk');

  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
  assert.equal(record.workspace, workspace);
  assert.equal(record.jobId, jobId);
  assert.equal(record.branch, `fleet/APP-123-${jobId}`);
  assert.equal(record.target, 'APP-123');
  assert.equal(record.ok, true, 'the harness itself exited clean');
  assert.match(String(record.reason), /\S/, 'the record carries why the push failed');

  // 3. The transcript says so too: the push failure and the retained path.
  //    (`fleet doctor` listing retained records is covered in cli-doctor.)
  const { stdout: log } = await r.fleet(['logs', jobId]);
  assert.match(log, /WORK PUSH FAILED/);
  assert.match(log, /workspace retained at/);
  assert.match(log, new RegExp(`resume-push ${jobId}`));

  // 4. The remote comes back; the late push delivers and cleans up.
  renameSync(`${r.remote}.down`, r.remote);
  const recovered = await r.fleet(['resume-push', jobId]);
  assert.match(recovered.stdout, new RegExp(`pushed fleet/APP-123-${jobId}`));
  assert.match(recovered.stdout, /workspace removed/);

  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', `fleet/APP-123-${jobId}`], {
    cwd: r.remote,
    encoding: 'utf8',
  });
  assert.match(tree, /work\.txt/, 'the late push must land the work on the job branch');
  assert.ok(!tree.includes('.fleet/order.json'), 'dispatch payload must never be pushed');

  assert.deepEqual(jobWorkspaces(r.workspaceRoot, jobId), [], 'workspace must be gone after a successful late push');
  assert.ok(!existsSync(recordPath), 'the retained record must be dropped once the remote has the work');
});

test('work push succeeds: workspace removed and nothing is retained', async (t) => {
  const r = await rig(false);
  t.after(() => r.daemon.stop());

  const jobId = await dispatch(r, 'APP-124');

  const deadline = Date.now() + 10_000;
  while (jobWorkspaces(r.workspaceRoot, jobId).length > 0) {
    assert.ok(Date.now() < deadline, 'workspace was not removed after a successful push');
    await delay(100);
  }
  assert.ok(!existsSync(join(r.home, 'retained', `${jobId}.json`)), 'a delivered job retains nothing');
  assert.ok(!existsSync(join(r.home, 'retained')), 'the registry directory is only created on demand');

  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', `fleet/APP-124-${jobId}`], {
    cwd: r.remote,
    encoding: 'utf8',
  });
  assert.match(tree, /work\.txt/, 'the work push landed as today');
});
