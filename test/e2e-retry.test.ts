// End-to-end for the harness-exit auto-retry (#30): real CLI -> real daemon ->
// ProcessProvider -> real runner, with a fixture harness that exits 1 mid-run
// on its first launch and succeeds on the second. The retry must be policy,
// not improvisation: partial branch renamed (evidence retained), one fresh
// launch, both attempts in the transcript, attempt count on the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
const harness = join(here, '..', 'fixtures', 'retry-harness.mjs');

// Integration test against real child processes: a short real polling delay is
// the only workable wait (same trade as e2e-delegate.test.ts).
const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Bare git remote seeded with main — job branches and work pushes land here. */
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
  setup: { image: 'node:22' },
  workspace: { repo, strategy: 'branch-per-job' },
  env: { vars: ['FLEET_HARNESS_CMD'] },
  harness: {
    cli: 'claude-code',
    commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }],
  },
  gates: { pickup: 'node -e "process.exit(0)"', default_finish: 'implemented' },
});

test('harness-exit auto-retry over the real wire: rename, relaunch, succeed on attempt 2', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-retry-home-'));
  const project = mkdtempSync(join(tmpdir(), 'fleet-retry-proj-'));
  const scratch = mkdtempSync(join(tmpdir(), 'fleet-retry-marker-'));
  const remote = makeRemote(mkdtempSync(join(tmpdir(), 'fleet-retry-git-')));
  mkdirSync(join(project, '.fleet'), { recursive: true });
  writeFileSync(join(project, '.fleet', 'manifest.json'), JSON.stringify(manifest(remote), null, 2));

  const daemon = new FleetDaemon({ home, provider: new ProcessProvider(), port: 0, longPollMs: 1_000 });
  const { port } = await daemon.start();
  t.after(() => daemon.stop());
  assert.ok(port, 'daemon must bind a TCP port');

  const env = {
    ...process.env,
    FLEET_DAEMON_URL: `http://127.0.0.1:${port}`,
    FLEET_HARNESS_CMD: `node ${harness} ${join(scratch, 'attempt-1-ran')}`,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Operator One',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'op@example.com',
  };
  const fleet = (args: string[]) => run('node', [cli, ...args], { cwd: project, env });

  const delegated = await fleet(['delegate', 'APP-123', '--mode', 'implement', '--finish', 'implemented']);
  const jobId = delegated.stdout.trim().split(/\s+/).find((w) => w.startsWith('job-'));
  assert.ok(jobId, `no job id in delegate output: ${delegated.stdout}`);

  const waitFor = async (predicate: (s: string) => boolean, what: string) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const { stdout } = await fleet(['status', jobId]);
      if (predicate(stdout)) return stdout;
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}; last status:\n${stdout}`);
      await delay(250);
    }
  };

  // The retry is silent policy until it succeeds — but never invisible: the
  // settled job says done AND names the attempt.
  const settled = await waitFor((s) => /\bdone\b/.test(s), 'done after one auto-retry');
  assert.match(settled, /\[attempt 2\]/, 'status must show the attempt count');

  // Events record both attempts, in lifecycle order.
  const { stdout: log } = await fleet(['logs', jobId]);
  const markers = [
    'running',                    // attempt 1
    'reason=harness-exit',        // attempt 1 dies
    'auto-retrying',              // the daemon's policy line
    'reason=retry attempt=2',     // the re-queue event
    'running',                    // attempt 2 (emitted before its git setup)
    'claim released',             // attempt 2 renamed the partial branch
    'status=READY',               // attempt 2's settle
    'done',
  ];
  let lastIndex = -1;
  for (const marker of markers) {
    const index = log.indexOf(marker, lastIndex + 1);
    assert.ok(index !== -1, `transcript missing "${marker}" after position ${lastIndex}:\n${log}`);
    lastIndex = index;
  }

  // The partial branch was renamed, never deleted: attempt 1's evidence lives
  // at -attempt1, and the final branch carries only attempt 2's work.
  const heads = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  const branch = `fleet/APP-123-${jobId}`;
  assert.ok(heads.includes(`refs/heads/${branch}-attempt1`), `attempt 1 evidence branch missing:\n${heads}`);
  assert.ok(heads.includes(`refs/heads/${branch}\n`), `final claim branch missing:\n${heads}`);
  const evidence = execFileSync('git', ['ls-tree', '-r', '--name-only', `${branch}-attempt1`], { cwd: remote, encoding: 'utf8' });
  assert.match(evidence, /partial\.txt/, 'attempt 1 partial work retained on the renamed branch');
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: remote, encoding: 'utf8' });
  assert.match(tree, /work\.txt/, 'attempt 2 work delivered on the claim branch');
  assert.ok(!tree.includes('partial.txt'), 'the retry started clean — attempt 1 work is not on the final branch');
});
