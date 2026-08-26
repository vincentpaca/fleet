// A daemon-initiated stall cancel must deliver the work (#197), end to end:
// CLI -> daemon (idle sweep) -> provider.terminate -> real runner teardown.
//
// The incident this replays: job-mt9y7vel's keepalive died, the daemon's idle
// sweep terminated the container, and the teardown delivered nothing — the
// commit made in-workspace never reached origin, the artifacts on disk were
// never collected, and the journal's only settle was the daemon's synthetic
// produced:[]. Here the keepalive is suppressed the same way (a huge
// FLEET_HEARTBEAT_MS), the harness holds a committed-but-unpushed commit and
// two artifact files, and the daemon fires first. On pre-#197 code the daemon
// synthesises settle+cancelled the instant terminate() returns, so every
// runner teardown event is 422-rejected and no artifact is ever collected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { FleetDaemon } from '../src/daemon/server.ts';
import { ProcessProvider } from '../src/providers/process.ts';
import { op, until } from './daemon-helpers.ts';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli', 'main.ts');
const harness = join(here, '..', 'fixtures', 'stalled-delivery-harness.mjs');

/** Bare git remote seeded with main — the job branch and the WIP push land here. */
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
  env: { vars: ['FLEET_HARNESS_CMD', 'FLEET_HEARTBEAT_MS'] },
  harness: {
    cli: 'claude-code',
    commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
  },
  gates: { pickup: 'node -e "process.exit(0)"', default_finish: 'implemented' },
  // The stall clock under test. Not tighter: setup (clone, branch push, gate)
  // emits events a few seconds apart under full-suite load, and an idle limit
  // inside those gaps cancels the job mid-clone — before the branch exists —
  // which tests the wrong thing (the schema also floors idle above the gate's
  // runtime for exactly this reason).
  limits: { idle: '10s' },
});

test('a daemon-initiated stall cancel lands the unpushed commit, collects the artifacts, and keeps the runner settle', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-stallteardown-home-'));
  const project = mkdtempSync(join(tmpdir(), 'fleet-stallteardown-proj-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'fleet-stallteardown-ws-'));
  const remote = makeRemote(mkdtempSync(join(tmpdir(), 'fleet-stallteardown-git-')));
  mkdirSync(join(project, '.fleet'), { recursive: true });
  writeFileSync(join(project, '.fleet', 'manifest.json'), JSON.stringify(manifest(remote), null, 2));

  const daemon = new FleetDaemon({
    home,
    provider: new ProcessProvider({ workspaceRoot, home }),
    port: 0,
    longPollMs: 1_000,
    // Sweep fast, fire 1s past the 10s idle limit. backstopSettleWaitMs is
    // deliberately the production default: the runner's real teardown must
    // land inside it.
    wallClockSweepIntervalMs: 100,
    idleBackstopMarginMs: 1_000,
  });
  const { port, socketPath } = await daemon.start();
  assert.ok(port, 'daemon must bind a TCP port');
  t.after(() => daemon.stop());
  delete process.env.FLEET_KEEP_WORKSPACE;

  const env = {
    ...process.env,
    FLEET_HOME: home,
    FLEET_DAEMON_URL: `http://127.0.0.1:${port}`,
    FLEET_HARNESS_CMD: `node ${harness}`,
    // The incident's dead keepalive, reproduced with the supported knob: a
    // window the run can never reach. The harness stays chatty on stdout —
    // untranslatable noise — so the runner's own stall clock never fires and
    // the daemon's event-stream sweep is what ends the job.
    FLEET_HEARTBEAT_MS: '86400000',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Operator One',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'op@example.com',
  };
  const fleet = (args: string[]) => run('node', [cli, ...args], { cwd: project, env });

  const delegated = await fleet(['delegate', 'stall-audit', '--mode', 'implement', '--finish', 'implemented']);
  const jobId = delegated.stdout.trim().split(/\s+/).find((w) => w.startsWith('job-'));
  assert.ok(jobId, `no job id in delegate output: ${delegated.stdout}`);
  const branch = `fleet/stall-audit-${jobId}`;

  // The daemon's idle sweep — not the runner — must end this job, and the
  // teardown must finish inside the daemon's settle wait. Generous budget:
  // this file runs alongside the whole suite (#130).
  await until(async () => {
    const res = await op(socketPath, 'GET', `/jobs/${jobId}`);
    const job = (res.json as { job?: { state?: string } }).job;
    return job?.state === 'cancelled';
  }, 120_000);

  // 1. The commit that existed only in the workspace is on origin (#197
  //    acceptance b). In the incident the branch never moved past creation.
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
    cwd: remote,
    encoding: 'utf8',
  });
  assert.match(tree, /committed-work\.txt/, 'the committed-but-unpushed work must land on the job branch');
  assert.ok(!tree.includes('.fleet/order.json'), 'dispatch payload must never be pushed');

  // 2. The runner's own teardown account survived: its wip-push log, its
  //    settle with real produced[], and the daemon's named cause — not a
  //    synthetic produced:[] twin (#197 acceptance c).
  const jobRes = await op(socketPath, 'GET', `/jobs/${jobId}`);
  const job = (jobRes.json as { job: { settle?: { outcome?: { produced?: { path: string }[] } } } }).job;
  const produced = job.settle?.outcome?.produced ?? [];
  assert.deepEqual(
    produced.map((p) => p.path).sort(),
    ['answer.md', 'readme-audit.md'],
    'the record settle must carry the artifacts the cancel collected',
  );
  const { stdout: log } = await fleet(['logs', jobId]);
  assert.match(log, /stall backstop: terminating the container/, 'the journal must say why the daemon acted');
  assert.match(log, new RegExp(`wip pushed to ${branch}`), "the runner's teardown push must be in the journal");

  // 3. The artifacts are fetchable, byte-identical, through the operator lane.
  const { stdout: listed } = await fleet(['artifacts', jobId]);
  assert.match(listed, /answer\.md/);
  assert.match(listed, /readme-audit\.md/);
  const outDir = mkdtempSync(join(tmpdir(), 'fleet-stallteardown-out-'));
  await fleet(['artifacts', jobId, 'get', 'answer.md', '--out', outDir]);
  assert.equal(
    readFileSync(join(outDir, 'answer.md'), 'utf8'),
    '# Answer\n\nWritten minutes before the cancel.\n',
    'the fetched artifact must be byte-identical to what the harness wrote',
  );
});
