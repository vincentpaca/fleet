import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { validateWorkOrder } from '../src/validate.mjs';
import { runCli, makeTempDir, startMockDaemon, sendJson, type MockRequest } from './cli-helpers.ts';
import { toHttpsGitUrl } from '../src/shared/giturl.ts';

const MANIFEST = {
  version: 1,
  setup: { image: 'node:22', script: '.fleet/setup.sh' },
  workspace: {
    repo: 'git@github.com:acme/example-app.git',
    strategy: 'branch-per-job',
    sync: ['.env.fleet'],
  },
  env: { vars: ['ACME_API_TOKEN'] },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'node .fleet/check-ready.js', default_finish: 'merge-ready' },
};

function scaffold(manifest: unknown = MANIFEST): string {
  const cwd = makeTempDir('fleet-cli-delegate-');
  fs.mkdirSync(path.join(cwd, '.fleet'));
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(cwd, '.env.fleet'), 'ACME_SETTING=example.com\n');
  return cwd;
}

function jobsRoute() {
  return {
    'POST /jobs': (_req: MockRequest, res: ServerResponse) => {
      sendJson(res, 201, { job: { id: 'job-1', state: 'queued' } });
    },
  };
}
test('delegate builds a valid implement work order from presets and posts it', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /job-1 queued/);

  assert.equal(daemon.requests.length, 1);
  const body = JSON.parse(daemon.requests[0].body);

  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(body.workOrder.mode, 'implement');
  assert.equal(body.workOrder.target, 'APP-123');
  assert.equal(body.workOrder.finish, 'merge-ready');
  assert.equal(body.workOrder.report, 'status-first');
  assert.equal(body.workOrder.authority.edit, true);
  assert.equal(body.workOrder.authority.merge, false, 'merge never grantable');
  assert.equal(body.workOrder.authority.deploy, false, 'deploy never grantable');

  assert.deepEqual(body.manifest, MANIFEST, 'manifest travels with the dispatch');
  assert.equal(body.env.ACME_API_TOKEN, 'token-value', 'env value read from the dispatching shell');
  assert.equal(
    Buffer.from(body.sync['.env.fleet'], 'base64').toString('utf8'),
    'ACME_SETTING=example.com\n',
    'sync file content shipped base64-encoded',
  );
});

test('delegate --mode and --finish override the preset', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123', '--mode', 'assess', '--finish', 'inspected'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.mode, 'assess');
  assert.equal(body.workOrder.finish, 'inspected');
  assert.equal(body.workOrder.authority.edit, false, 'assess is read-only');
  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.equal(ok, true, JSON.stringify(errors));
});

test('delegate fails loudly on a missing env var, before any POST', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: undefined },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /missing env var: ACME_API_TOKEN/);
  assert.match(res.stderr, /\.fleet\/\.env/, 'error names the file as a fallback source');
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate: var present only in .fleet/.env is injected into the job', async (t) => {
  const cwd = scaffold();
  // Write .fleet/.env with the var; remove it from the shell env.
  fs.writeFileSync(path.join(cwd, '.fleet', '.env'), 'ACME_API_TOKEN=from-dotenv\n');
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: undefined },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.env.ACME_API_TOKEN, 'from-dotenv', 'dotenv value injected when shell var absent');
});

test('delegate: shell env wins over .fleet/.env when var is in both', async (t) => {
  const cwd = scaffold();
  fs.writeFileSync(path.join(cwd, '.fleet', '.env'), 'ACME_API_TOKEN=from-dotenv\n');
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'from-shell' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.env.ACME_API_TOKEN, 'from-shell', 'shell value takes precedence over .fleet/.env');
});

test('delegate fails loudly on a missing sync file, before any POST', async (t) => {
  const cwd = scaffold();
  fs.rmSync(path.join(cwd, '.env.fleet'));
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /missing sync file: \.env\.fleet/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate rejects an unknown mode and an invalid manifest locally', async () => {
  const cwd = scaffold();
  const badMode = await runCli(['delegate', 'APP-123', '--mode', 'conquer'], {
    cwd,
    env: { ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(badMode.code, 1);
  assert.match(badMode.stderr, /unknown mode "conquer"/);
  assert.match(badMode.stderr, /implement/, 'lists available modes');

  const badCwd = scaffold({ version: 1 });
  const badManifest = await runCli(['delegate', 'APP-123'], { cwd: badCwd });
  assert.equal(badManifest.code, 1);
  assert.match(badManifest.stderr, /must have required property/);
});

test('delegate surfaces daemon 422 errors readably', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'POST /jobs': (req, res) => {
      sendJson(res, 422, { errors: [{ instancePath: '/workOrder/finish', message: 'is not targetable' }] });
    },
  });
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /\/workOrder\/finish is not targetable/);
});

test('delegate requires a target argument (usage error)', async () => {
  const cwd = scaffold();
  const res = await runCli(['delegate'], { cwd });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage error/);
});

test('delegate: non-numeric target (APP-123) never sets workOrder.title', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.title, undefined, 'non-numeric target must never set title');
});

// Minimal manifest with no env vars or sync, so the gh-title tests are
// self-contained; gh itself is faked on PATH so both branches are forced,
// not left to whatever the machine's real gh returns.
const MIN_MANIFEST = {
  version: 1,
  setup: { image: 'node:22' },
  workspace: { repo: 'git@github.com:acme/example-app.git', strategy: 'branch-per-job' },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'node .fleet/check-ready.js', default_finish: 'merge-ready' },
};

function fakeGh(script: string): string {
  const bin = makeTempDir('fleet-fake-gh-');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

test('delegate: numeric target stamps workOrder.title from gh', async (t) => {
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('echo "Fix the flaky heartbeat"');

  const res = await runCli(['delegate', '42'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.target, '42', 'target preserved');
  assert.equal(body.workOrder.title, 'Fix the flaky heartbeat', 'title stamped from gh');
  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.ok(ok, `work order with numeric target must validate: ${JSON.stringify(errors)}`);
});

test('delegate: a gh failure degrades to no title, never an empty one', async (t) => {
  const cwd = scaffold(MIN_MANIFEST);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = fakeGh('exit 1');

  const res = await runCli(['delegate', '42'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.title, undefined, 'failed gh lookup must leave title absent');
  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.ok(ok, `work order without title must validate: ${JSON.stringify(errors)}`);
});

test('delegate rewrites an ssh github remote to https when the job ships a GitHub token', async (t) => {
  const cwd = scaffold({ ...MANIFEST, env: { vars: ['ACME_API_TOKEN', 'GH_TOKEN'] } });
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', GH_TOKEN: 'gh-token' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(
    body.env.FLEET_GIT_URL,
    'https://github.com/acme/example-app.git',
    'ssh remote becomes https — containers hold no SSH keys, only the token',
  );
});

test('delegate keeps the ssh remote verbatim when no GitHub token ships', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(
    body.env.FLEET_GIT_URL,
    'git@github.com:acme/example-app.git',
    'without a token the URL is untouched — ssh-agent still covers the process provider',
  );
});

// --- Typed PR target (#80): delegate pr/<n> continues an existing PR ---

/** A bin dir whose `gh` prints the given JSON (recording its args); prepended to PATH. */
function fakeGhBin(stdout: string, exitCode = 0): { bin: string; calls: () => string[] } {
  const bin = makeTempDir('fleet-fake-gh-');
  const log = path.join(bin, 'gh-calls.log');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\necho "$@" >> "${log}"\ncat <<'EOF'\n${stdout}\nEOF\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return {
    bin,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

const OPEN_PR = JSON.stringify({
  number: 41,
  state: 'OPEN',
  headRefName: 'fleet/9-job-old',
  title: 'Fix the widget pipeline',
  closingIssuesReferences: [{ number: 9 }],
});

test('delegate pr/<n> implies followthrough, resolves the head branch, and ships continues', async (t) => {
  const cwd = scaffold();
  const gh = fakeGhBin(OPEN_PR);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'pr/41'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', PATH: `${gh.bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.workOrder.mode, 'followthrough', 'a PR target implies followthrough');
  assert.deepEqual(body.workOrder.continues, { pr: 41, branch: 'fleet/9-job-old' });
  assert.equal(body.workOrder.target, '9', 'the linked issue becomes the target — board lineage');
  assert.equal(body.workOrder.title, 'Fix the widget pipeline');
  const { ok, errors } = validateWorkOrder(body.workOrder);
  assert.ok(ok, JSON.stringify(errors));
  assert.match(gh.calls()[0], /^pr view 41 --json /, 'resolved via gh pr view at dispatch');
});

test('delegate accepts a full GitHub PR URL and falls back to a pr/<n> target without a linked issue', async (t) => {
  const cwd = scaffold();
  const gh = fakeGhBin(JSON.stringify({
    number: 41, state: 'OPEN', headRefName: 'fleet/9-job-old', title: 'Fix the widget pipeline',
    closingIssuesReferences: [],
  }));
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'https://github.com/acme/example-app/pull/41'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', PATH: `${gh.bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.deepEqual(body.workOrder.continues, { pr: 41, branch: 'fleet/9-job-old' });
  assert.equal(body.workOrder.target, 'pr/41', 'no single linked issue — the PR reference is the target');
  assert.match(gh.calls()[0], /^pr view https:\/\/github\.com\/acme\/example-app\/pull\/41 /, 'URLs pass to gh verbatim — they name the repo');
});

test('delegate refuses a non-open PR before any POST', async (t) => {
  // The bug this catches: resolving (or failing) only after the daemon has a
  // job record — a container would burn on a branch nobody can update a PR from.
  const cwd = scaffold();
  const gh = fakeGhBin(JSON.stringify({ number: 41, state: 'MERGED', headRefName: 'fleet/9-job-old', title: 'x', closingIssuesReferences: [] }));
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'pr/41'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', PATH: `${gh.bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /PR #41 is MERGED, not open/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate refuses a gh resolution failure before any POST', async (t) => {
  const cwd = scaffold();
  const gh = fakeGhBin('', 1);
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'pr/404'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value', PATH: `${gh.bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /cannot resolve PR target pr\/404/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

test('delegate rejects a PR target with a conflicting --mode', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);

  const res = await runCli(['delegate', 'pr/41', '--mode', 'implement'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, ACME_API_TOKEN: 'token-value' },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /implies --mode followthrough/);
  assert.equal(daemon.requests.length, 0, 'nothing posted');
});

// --- Two-layer image on the delegate path (#121): async build, streamed to this stdout ---

test('delegate with cli_version builds the job image, streams docker output to stdout, and ships the tag', async (t) => {
  const cwd = scaffold({ ...MIN_MANIFEST, harness: { ...MIN_MANIFEST.harness, cli_version: '9.9.9' } });
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  // A docker whose inspect always misses and whose build streams a line, the
  // way a real build narrates its layers.
  const bin = makeTempDir('fleet-fake-docker-');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    '#!/bin/sh\ncase "$1" in\n  build) echo "FAKE_BUILD_PROGRESS step 1/3" ;;\n  image) exit 1 ;;\nesac\nexit 0\n',
    { mode: 0o755 },
  );

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /building job image fleet-job:/);
  // The plain CLI owns its stdout: build progress streams through, the same
  // visibility stdio:'inherit' used to give — without blocking the event loop.
  assert.match(res.stdout, /FAKE_BUILD_PROGRESS step 1\/3/);
  const body = JSON.parse(daemon.requests[0].body);
  assert.match(body.image, /^fleet-job:[0-9a-f]{16}$/, 'the built tag rides the dispatch');
});

test('delegate fails loudly when the build fails, carrying the build tail, before any POST', async (t) => {
  const cwd = scaffold({ ...MIN_MANIFEST, harness: { ...MIN_MANIFEST.harness, cli_version: '9.9.9' } });
  const daemon = await startMockDaemon(jobsRoute());
  t.after(daemon.close);
  const bin = makeTempDir('fleet-fake-docker-');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    '#!/bin/sh\ncase "$1" in\n  build) echo "no space left on device" >&2; exit 17 ;;\n  image) exit 1 ;;\nesac\nexit 0\n',
    { mode: 0o755 },
  );

  const res = await runCli(['delegate', 'APP-123'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /docker build exited 17/);
  assert.match(res.stderr, /no space left on device/, 'the failure carries the build tail');
  assert.equal(daemon.requests.length, 0, 'a failed build posts nothing — build-before-POST');
});

test('toHttpsGitUrl: github ssh forms rewrite, everything else passes through', () => {
  assert.equal(toHttpsGitUrl('git@github.com:acme/example-app.git'), 'https://github.com/acme/example-app.git');
  assert.equal(toHttpsGitUrl('ssh://git@github.com/acme/example-app.git'), 'https://github.com/acme/example-app.git');
  assert.equal(toHttpsGitUrl('https://github.com/acme/example-app.git'), 'https://github.com/acme/example-app.git');
  assert.equal(toHttpsGitUrl('git@git.example.com:acme/tools.git'), 'git@git.example.com:acme/tools.git', 'non-github hosts untouched — no credential can serve them yet');
  assert.equal(toHttpsGitUrl('/tmp/local/bare.git'), '/tmp/local/bare.git', 'local paths untouched');
});
