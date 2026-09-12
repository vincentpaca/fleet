// The README's agent path (#184): a single copy-pasteable sequence an agent
// can follow from a fresh checkout to a clean doctor. This test executes the
// README's own fenced block — not a copy of it — so a command that drifts
// from the CLI fails CI as broken onboarding, not as prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli, makeTempDir, fakeCloudBin, startMockDaemon } from './cli-helpers.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The commands of the README's agent-path block, in order. */
function agentPathCommands(): string[] {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const section = readme.split(/^### The agent path$/m)[1];
  assert.ok(section, 'README.md carries "### The agent path"');
  const block = section.match(/```sh\n([\s\S]*?)```/);
  assert.ok(block, 'the agent path has a fenced sh block');
  return block![1].split('\n').map((line) => line.trim()).filter(Boolean);
}

test('the README agent path runs headless from install to a clean doctor (#184)', async (t) => {
  const commands = agentPathCommands();
  assert.equal(commands[0], 'npm install -g ownfleet', 'the block starts at the install');
  assert.equal(commands.at(-1), 'fleet doctor', 'the block ends at the proof');

  // A fresh target repo with an origin — what an agent is pointed at.
  const cwd = makeTempDir('fleet-agent-path-');
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=agent@invalid', '-c', 'user.name=agent', ...args], { cwd });
  };
  git('init', '--quiet');
  git('commit', '--allow-empty', '--quiet', '-m', 'init');
  git('remote', 'add', 'origin', 'git@github.com:fleet-test/target.git');

  // The machine state, pinned: a temp HOME, fake terraform/aws on PATH, and a
  // model credential in the environment so the seat walk has nothing to ask.
  const state = makeTempDir('fleet-agent-path-state-');
  const env: Record<string, string | undefined> = {
    HOME: makeTempDir('fleet-agent-path-home-'),
    PATH: `${fakeCloudBin(state)}${path.delimiter}${process.env.PATH}`,
    FAKE_TF_DIR: state,
    FAKE_AWS_DIR: state,
    FLEET_IMAGE_POLL_MS: '5',
    AWS_REGION: undefined,
    AWS_DEFAULT_REGION: undefined,
    ANTHROPIC_API_KEY: 'sk-ant-api-here',
  };

  // `fleet connect` holds a live tunnel; its stand-in is a daemon answering on
  // the captured URL, stamped at this checkout's HEAD — what a deployed image
  // built from the pinned ref reports.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const daemon = await startMockDaemon({
    'GET /health': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, build: head }));
    },
  });
  t.after(() => daemon.close());

  for (const command of commands.slice(1)) {
    const [bin, ...args] = command.split(/\s+/);
    assert.equal(bin, 'fleet', `only fleet commands after the install: ${command}`);
    if (args[0] === 'connect') {
      // The tunnel's effect, not its process: point the capture at the daemon.
      const configPath = path.join(cwd, '.fleet', 'infra', 'aws', 'fleet-config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(configPath, JSON.stringify({ ...config, daemon_url: daemon.url }, null, 2));
      continue;
    }
    const res = await runCli(args, { cwd, env });
    assert.equal(res.code, 0, `\`${command}\` failed:\n${res.stdout}\n${res.stderr}`);
    if (args[0] === 'doctor') assert.match(res.stdout, /doctor: clean/);
  }
});
