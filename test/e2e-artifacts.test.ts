// End-to-end: artifact delivery lane. A fake harness writes two artifact files
// under .fleet/out/artifacts/; after the job settles the daemon stores them,
// produced[] lists both with correct sha256/bytes, `fleet artifacts get`
// round-trips byte-identical content, and artifacts are absent from the branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
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
const artifactsHarness = join(here, '..', 'fixtures', 'artifacts-harness.mjs');

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Bare git remote for testing the branch-push side-effects. */
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
  workspace: { repo, strategy: 'branch-per-job', sync: ['.env.fleet'] },
  env: { vars: ['FLEET_HARNESS_CMD'] },
  harness: {
    cli: 'claude-code',
    commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }],
  },
  gates: { pickup: 'node -e "process.exit(0)"', default_finish: 'implemented' },
});

// Known content written by artifacts-harness.mjs (must match exactly).
const ARTIFACT_CONTENT = {
  'report.md': '# Assessment\n\nNo critical issues found.\n',
  'data.txt': 'col1,col2\n1,2\n3,4\n',
};

test('artifact delivery: produced[] lists both files, get round-trips content, branch clean', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-art-e2e-home-'));
  const project = mkdtempSync(join(tmpdir(), 'fleet-art-e2e-proj-'));
  const remote = makeRemote(mkdtempSync(join(tmpdir(), 'fleet-art-e2e-git-')));
  mkdirSync(join(project, '.fleet'), { recursive: true });
  writeFileSync(join(project, '.fleet', 'manifest.json'), JSON.stringify(manifest(remote), null, 2));
  writeFileSync(join(project, '.env.fleet'), 'EXAMPLE=1\n');

  const daemon = new FleetDaemon({ home, provider: new ProcessProvider(), port: 0, longPollMs: 1_000 });
  const { port } = await daemon.start();
  t.after(() => daemon.stop());
  assert.ok(port, 'daemon must bind a TCP port');

  const env = {
    ...process.env,
    FLEET_DAEMON_URL: `http://127.0.0.1:${port}`,
    FLEET_HARNESS_CMD: `node ${artifactsHarness}`,
  };
  const fleet = (args: string[], cwd: string = project) => run('node', [cli, ...args], { cwd, env });

  const delegated = await fleet(['delegate', 'assess-target', '--mode', 'assess', '--finish', 'implemented']);
  const jobId = delegated.stdout.trim().split(/\s+/).find((w) => w.startsWith('job-'));
  assert.ok(jobId, `no job id in delegate output: ${delegated.stdout}`);

  // Wait for the job to reach done.
  const waitFor = async (pred: (s: string) => boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { stdout } = await fleet(['status', jobId]);
      if (pred(stdout)) return stdout;
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await delay(250);
    }
  };
  await waitFor((s) => /\bdone\b/i.test(s), 'done');

  // ── 1. produced[] lists both artifacts with correct sha256/bytes ──────────

  // Read the settle event from the daemon's persisted event log.
  const jobsDir = join(home, 'jobs');
  const jobDir = readdirSync(jobsDir).find((d) => d === jobId);
  assert.ok(jobDir, `job directory ${jobId} not found under ${jobsDir}`);
  const events = readFileSync(join(jobsDir, jobDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const settle = events.find((e) => e.type === 'settle');
  assert.ok(settle, 'settle event present in event log');

  const produced = settle.outcome?.produced as Array<{
    id: string; type: string; title: string; path: string; sha256: string; bytes: number;
  }>;
  assert.equal(produced.length, 2, `expected 2 artifacts, got ${produced.length}`);

  const byPath: Record<string, typeof produced[0]> = {};
  for (const entry of produced) {
    assert.equal(entry.type, 'file');
    byPath[entry.path] = entry;
  }

  for (const [filename, content] of Object.entries(ARTIFACT_CONTENT)) {
    const entry = byPath[filename];
    assert.ok(entry, `produced[] missing ${filename}`);
    const expectedBytes = Buffer.byteLength(content);
    const expectedSha256 = createHash('sha256').update(content).digest('hex');
    assert.equal(entry.bytes, expectedBytes, `${filename}: bytes mismatch`);
    assert.equal(entry.sha256, expectedSha256, `${filename}: sha256 mismatch`);
  }

  // ── 2. fleet artifacts list ───────────────────────────────────────────────

  const { stdout: listOut } = await fleet(['artifacts', jobId]);
  for (const filename of Object.keys(ARTIFACT_CONTENT)) {
    assert.match(listOut, new RegExp(filename), `list output missing ${filename}`);
  }

  // ── 3. fleet artifacts get round-trips byte-identical content ─────────────

  const outDir = mkdtempSync(join(tmpdir(), 'fleet-art-dl-'));
  for (const [filename, expectedContent] of Object.entries(ARTIFACT_CONTENT)) {
    await fleet(['artifacts', jobId, 'get', filename, '--out', outDir]);
    const downloaded = readFileSync(join(outDir, filename), 'utf8');
    assert.equal(downloaded, expectedContent, `${filename}: downloaded content does not match`);
  }

  // ── 4. Artifacts absent from the pushed branch ────────────────────────────

  const heads = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  const branchLine = heads.split('\n').find((l) => l.includes('refs/heads/fleet/assess-target-'));
  assert.ok(branchLine, `job branch missing on the remote:\n${heads}`);
  const branch = branchLine.split('refs/heads/')[1];
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: remote, encoding: 'utf8' });

  for (const filename of Object.keys(ARTIFACT_CONTENT)) {
    assert.ok(
      !tree.includes(filename),
      `artifact ${filename} should not appear on the pushed branch`,
    );
  }
  assert.ok(!tree.includes('.fleet/out'), '.fleet/out must not appear on the pushed branch');
});

test('over-cap artifact: settle still completes, other artifacts delivered, note emitted', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-cap-e2e-home-'));
  const project = mkdtempSync(join(tmpdir(), 'fleet-cap-e2e-proj-'));
  const remote = makeRemote(mkdtempSync(join(tmpdir(), 'fleet-cap-e2e-git-')));
  mkdirSync(join(project, '.fleet'), { recursive: true });
  writeFileSync(join(project, '.fleet', 'manifest.json'), JSON.stringify(manifest(remote), null, 2));
  writeFileSync(join(project, '.env.fleet'), 'EXAMPLE=1\n');

  // A harness that writes one normal artifact and one over-cap artifact.
  const overCapHarnessPath = join(mkdtempSync(join(tmpdir(), 'fleet-cap-harness-')), 'harness.mjs');
  writeFileSync(overCapHarnessPath, `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });
const artDir = join(out, 'artifacts');
mkdirSync(artDir, { recursive: true });
writeFileSync(join(artDir, 'small.txt'), 'ok');
// Write 10MB + 1 byte to trigger the per-file cap on the daemon side.
writeFileSync(join(artDir, 'huge.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
writeFileSync(join(out, 'report.json'), JSON.stringify({ status: 'READY', next_action: 'check artifacts' }));
line({ type: 'result', subtype: 'success' });
`);

  const daemon = new FleetDaemon({ home, provider: new ProcessProvider(), port: 0, longPollMs: 1_000 });
  const { port } = await daemon.start();
  t.after(() => daemon.stop());
  assert.ok(port);

  const env = {
    ...process.env,
    FLEET_DAEMON_URL: `http://127.0.0.1:${port}`,
    FLEET_HARNESS_CMD: `node ${overCapHarnessPath}`,
  };
  const fleet = (args: string[], cwd: string = project) => run('node', [cli, ...args], { cwd, env });

  const delegated = await fleet(['delegate', 'cap-target', '--mode', 'assess', '--finish', 'implemented']);
  const jobId = delegated.stdout.trim().split(/\s+/).find((w) => w.startsWith('job-'));
  assert.ok(jobId);

  const waitFor = async (pred: (s: string) => boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { stdout } = await fleet(['status', jobId]);
      if (pred(stdout)) return;
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await delay(250);
    }
  };
  await waitFor((s) => /\bdone\b/i.test(s), 'done');

  // The job must have reached done (not cancelled) despite the over-cap file.
  const { stdout: statusOut } = await fleet(['status', jobId]);
  assert.match(statusOut, /\bdone\b/i, 'job must be done despite over-cap artifact');

  // The settle event's produced[] must include only the small artifact.
  const jobsDir = join(home, 'jobs');
  const jobDir = readdirSync(jobsDir).find((d) => d === jobId);
  assert.ok(jobDir, `job directory ${jobId} not found under ${jobsDir}`);
  const events = readFileSync(join(jobsDir, jobDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const settle = events.find((e) => e.type === 'settle');
  assert.ok(settle);
  const produced = settle.outcome?.produced as Array<{ path: string }>;
  assert.equal(produced.length, 1, 'only the small artifact should appear in produced[]');
  assert.equal(produced[0].path, 'small.txt');

  // A log event must note the skipped over-cap file.
  const logs = events.filter((e) => e.type === 'log');
  const capNote = logs.find((e) => typeof e.text === 'string' && /huge\.bin/.test(e.text) && /cap/.test(e.text));
  assert.ok(capNote, 'no cap-exceeded log note for huge.bin');
});
