// End-to-end smoke: real CLI -> real daemon -> ProcessProvider -> real runner
// (child process) -> fake harness raising a real decision -> operator answers
// via the CLI -> settle -> done. Everything over the actual wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FleetDaemon } from '../src/daemon/server.ts';
import { ProcessProvider } from '../src/providers/process.ts';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli', 'main.ts');
const harness = join(here, 'fixtures', 'e2e-harness.mjs');

// Integration test against real child processes and a live HTTP long-poll:
// deterministic/fake timers cannot drive an external process's clock, so a
// short real polling delay is the only workable wait here.
const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const manifest = {
  version: 1,
  setup: { image: 'node:22', script: '.fleet/setup.sh' },
  workspace: { repo: 'git@github.com:acme/webapp.git', strategy: 'branch-per-job', sync: ['.env.fleet'] },
  env: { vars: ['FLEET_HARNESS_CMD'] },
  harness: {
    cli: 'claude-code',
    agents: '.claude/agents',
    commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }],
  },
  gates: { pickup: 'node -e "process.exit(0)"', default_finish: 'implemented' },
};

test('delegate -> blocked -> answer -> done, over the real wire', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-e2e-home-'));
  const project = mkdtempSync(join(tmpdir(), 'fleet-e2e-proj-'));
  mkdirSync(join(project, '.fleet'), { recursive: true });
  writeFileSync(join(project, '.fleet', 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(project, '.env.fleet'), 'EXAMPLE=1\n');

  const daemon = new FleetDaemon({ home, provider: new ProcessProvider(), port: 0, longPollMs: 1_000 });
  const { port } = await daemon.start();
  t.after(() => daemon.stop());
  assert.ok(port, 'daemon must bind a TCP port');

  const env = {
    ...process.env,
    FLEET_DAEMON_URL: `http://127.0.0.1:${port}`,
    FLEET_HARNESS_CMD: `node ${harness}`,
  };
  const fleet = (args: string[], cwd: string = project) => run('node', [cli, ...args], { cwd, env });

  // Manifest is lintable before anything runs.
  await fleet(['lint']);

  const delegated = await fleet(['delegate', 'APP-123', '--mode', 'implement', '--finish', 'implemented']);
  const jobId = delegated.stdout.trim().split(/\s+/).find((w) => w.startsWith('job-'));
  assert.ok(jobId, `no job id in delegate output: ${delegated.stdout}`);

  const getJob = async () => {
    const { stdout } = await fleet(['status', jobId]);
    return stdout;
  };
  const waitFor = async (predicate: (s: string) => boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const s = await getJob();
      if (predicate(s)) return s;
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}; last status:\n${s}`);
      await delay(250);
    }
  };

  // The decision must block the job before any answer exists.
  const blocked = await waitFor((s) => /blocked/i.test(s), 'blocked');
  assert.match(blocked, /blocked/i);

  await fleet(['answer', jobId, '--option', 'rebase']);
  await waitFor((s) => /\bdone\b/i.test(s), 'done');

  // Transcript replays from the daemon's persisted event log.
  const { stdout: log } = await fleet(['logs', jobId]);
  for (const marker of ['running', 'decision', 'answer', 'settle', 'done']) {
    assert.match(log, new RegExp(marker, 'i'), `transcript missing ${marker}`);
  }
  assert.match(log, /rebase/, 'answered option should appear in the transcript');
  assert.match(log, /open the pull request/, 'report next_action should appear in settle');

  // Event log on disk is the source of truth and every line is valid JSON.
  const jobsDir = join(home, 'jobs');
  const dir = readdirSync(jobsDir).find((d) => d === jobId) ?? readdirSync(jobsDir)[0];
  const raw = readFileSync(join(jobsDir, dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.ok(raw.length >= 6, `expected a full event log, got ${raw.length} lines`);
  for (const lineText of raw) JSON.parse(lineText);
});
