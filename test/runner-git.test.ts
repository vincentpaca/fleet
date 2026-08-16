// Workspace git lifecycle (#2): branch pushed at creation, dispatch payload
// survives the clone and never gets committed, work and WIP pushes land on
// the remote. All against a local bare-repo fixture — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupWorkspace, pushWork, pushWip, jobBranch, getHeadSha, createDraftPr } from '../src/runner/git.ts';

const IDENTITY = ['-c', 'user.name=Operator One', '-c', 'user.email=op@example.com'];
const run = (cwd: string, args: string[]) => execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' });

/** A bare remote seeded with main: README.md + a tracked .fleet/manifest.json. */
function makeRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-git-'));
  const bare = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  mkdirSync(join(seed, '.fleet'), { recursive: true });
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  writeFileSync(join(seed, '.fleet', 'manifest.json'), '{"tracked":"repo copy"}\n');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  run(seed, ['add', '-A']);
  run(seed, ['commit', '-q', '-m', 'seed']);
  run(seed, ['push', '-q', bare, 'main']);
  return bare;
}

/** A staged workspace as the provider leaves it: dispatch payload, no git. */
function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-ws-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  writeFileSync(
    join(workspace, '.fleet', 'manifest.json'),
    JSON.stringify({ workspace: { sync: ['.env.fleet'] } }),
  );
  writeFileSync(join(workspace, '.fleet', 'order.json'), '{"target":"APP-7"}');
  writeFileSync(join(workspace, '.env.fleet'), 'SECRETISH=1\n');
  return workspace;
}

const opts = (url: string) => ({ url, jobId: 'job-1', target: 'APP-7', name: 'Operator One', email: 'op@example.com' });

test('branch is pushed at creation, before any work exists', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const { branch, base } = setupWorkspace(workspace, opts(remote));
  assert.equal(branch, 'fleet/APP-7-job-1');
  assert.equal(base, 'main');
  const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.match(refs, /refs\/heads\/fleet\/APP-7-job-1/);
  // The clone is real: seed content is present.
  assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8'), 'seed\n');
});

test('dispatch payload survives the clone and is never committed', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const { branch: _branch } = setupWorkspace(workspace, opts(remote));
  // Dispatched manifest wins over the repo's tracked copy...
  assert.match(readFileSync(join(workspace, '.fleet', 'manifest.json'), 'utf8'), /sync/);
  // ...and order/sync/out never reach the remote even after a full work push.
  writeFileSync(join(workspace, 'feature.txt'), 'real work\n');
  writeFileSync(join(workspace, '.fleet', 'out', 'report.json'), '{}');
  assert.equal(pushWork(workspace, 'APP-7', 'job-1', true), 'pushed');
  const files = run(workspace, ['ls-tree', '-r', '--name-only', 'origin/fleet/APP-7-job-1']);
  assert.match(files, /feature\.txt/);
  assert.ok(!files.includes('.fleet/order.json'), 'order.json must never be committed');
  assert.ok(!files.includes('.env.fleet'), 'sync files must never be committed');
  assert.ok(!files.includes('.fleet/out'), 'the out/ channel must never be committed');
  // The tracked manifest keeps its repo content on the remote, not the dispatched one.
  const manifest = run(workspace, ['show', 'origin/fleet/APP-7-job-1:.fleet/manifest.json']);
  assert.match(manifest, /repo copy/);
});

test('pushWork is honest about a clean tree; pushWip lands a park commit', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const { branch: _branch2 } = setupWorkspace(workspace, opts(remote));
  assert.equal(pushWork(workspace, 'APP-7', 'job-1', true), 'clean');
  writeFileSync(join(workspace, 'half-done.txt'), 'wip\n');
  assert.equal(pushWip(workspace, 'block_hot expired'), 'pushed');
  const subject = run(workspace, ['log', '-1', '--format=%s', 'origin/fleet/APP-7-job-1']);
  assert.match(subject, /^wip\(park\): block_hot expired/);
});

test('partial work is pushed with a partial marker — evidence over tidiness', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const { branch: _branch3 } = setupWorkspace(workspace, opts(remote));
  writeFileSync(join(workspace, 'attempt.txt'), 'incomplete\n');
  assert.equal(pushWork(workspace, 'APP-7', 'job-1', false), 'pushed');
  const subject = run(workspace, ['log', '-1', '--format=%s', 'origin/fleet/APP-7-job-1']);
  assert.match(subject.trim(), /\(partial\)$/);
});

test('jobBranch sanitizes hostile targets', () => {
  assert.equal(jobBranch('QA symptom: 403 on upload!', 'j9'), 'fleet/QA-symptom-403-on-upload-j9');
  assert.equal(jobBranch('...', 'j9'), 'fleet/work-j9');
});

test('setup fails loudly on an unreachable remote', () => {
  const workspace = makeWorkspace();
  assert.throws(() => setupWorkspace(workspace, opts(join(tmpdir(), 'nope-does-not-exist.git'))));
  assert.ok(existsSync(join(workspace, '.fleet', 'manifest.json')), 'payload untouched on failure');
});

test('getHeadSha returns the current HEAD SHA after a commit', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  setupWorkspace(workspace, opts(remote));
  writeFileSync(join(workspace, 'work.txt'), 'some work\n');
  pushWork(workspace, 'APP-7', 'job-1', true);
  const sha = getHeadSha(workspace);
  assert.match(sha, /^[0-9a-f]{40}$/);
  // The SHA matches what git reports for HEAD on the remote.
  const remoteHead = run(workspace, ['rev-parse', `origin/fleet/APP-7-job-1`]).trim();
  assert.equal(sha, remoteHead);
});

test('createDraftPr calls gh with correct args and returns trimmed URL', () => {
  // Inject a mock ghRun to avoid real GitHub API calls.
  const calls: string[][] = [];
  const mockGh = (args: string[]): string => {
    calls.push(args);
    return 'https://github.com/owner/repo/pull/42\n';
  };
  const workspace = makeWorkspace(); // path used as cwd context only
  const prUrl = createDraftPr(workspace, {
    base: 'main',
    branch: 'fleet/APP-7-job-1',
    title: 'APP-7',
    body: '{"status":"READY","next_action":"review"}',
    ghRun: mockGh,
  });
  assert.equal(prUrl, 'https://github.com/owner/repo/pull/42');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    'pr', 'create',
    '--draft',
    '--base', 'main',
    '--head', 'fleet/APP-7-job-1',
    '--title', 'APP-7',
    '--body', '{"status":"READY","next_action":"review"}',
  ]);
});

test('createDraftPr propagates gh failures as thrown errors', () => {
  const failingGh = (_args: string[]): string => {
    throw new Error('gh: Pull request create failed: already exists');
  };
  const workspace = makeWorkspace();
  assert.throws(
    () => createDraftPr(workspace, { base: 'main', branch: 'fleet/x-j1', title: 'x', body: '', ghRun: failingGh }),
    /already exists/,
  );
});
