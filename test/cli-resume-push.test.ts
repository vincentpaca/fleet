// `fleet resume-push` (#38): the late push from a workspace the runner kept
// because its own push failed. Against a real bare-repo remote that goes away
// and comes back — no daemon involved, because recovery must work when the
// rest of the world is broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCli, makeTempDir } from './cli-helpers.ts';
import { setupWorkspace } from '../src/runner/git.ts';
import { writeRetainedRecord, type RetainedRecord } from '../src/shared/retained.ts';

const IDENTITY = ['-c', 'user.name=Operator One', '-c', 'user.email=op@example.com'];
const git = (cwd: string, args: string[]) =>
  execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' });

/** Bare remote seeded with main. */
function makeRemote(): string {
  const dir = makeTempDir('fleet-rp-git-');
  const bare = path.join(dir, 'remote.git');
  const seed = path.join(dir, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['push', '-q', bare, 'main']);
  return bare;
}

/**
 * The state the runner leaves behind when its work push fails: a workspace on
 * the job branch with the work committed but unpushed, and a retained record in
 * $FLEET_HOME. `down` moves the remote aside so the push cannot land.
 */
function retained(opts: { jobId: string; target: string; down: boolean }): {
  home: string;
  remote: string;
  workspace: string;
  branch: string;
  record: RetainedRecord;
} {
  const home = makeTempDir('fleet-rp-home-');
  const remote = makeRemote();
  const workspace = makeTempDir('fleet-rp-ws-');
  fs.mkdirSync(path.join(workspace, '.fleet', 'out'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.fleet', 'manifest.json'), '{}');
  const { branch, base } = setupWorkspace(workspace, {
    url: remote,
    jobId: opts.jobId,
    target: opts.target,
    name: 'Operator One',
    email: 'op@example.com',
  });
  // The work the harness produced, committed but never pushed.
  fs.writeFileSync(path.join(workspace, 'work.txt'), 'the only copy\n');
  git(workspace, ['add', '-A']);
  git(workspace, ['commit', '-q', '-m', `${opts.target}: fleet job ${opts.jobId}`]);
  if (opts.down) fs.renameSync(remote, `${remote}.down`);

  const record: RetainedRecord = {
    jobId: opts.jobId,
    target: opts.target,
    branch,
    base,
    ok: true,
    reason: 'fatal: could not read from remote repository',
    at: new Date().toISOString(),
    workspace,
  };
  writeRetainedRecord(home, record);
  return { home, remote, workspace, branch, record };
}

test('resume-push: lands the work once the remote is back, then removes the workspace', async () => {
  const r = retained({ jobId: 'job-late-1', target: 'APP-123', down: true });

  // While the remote is down the retry fails and changes nothing.
  const down = await runCli(['resume-push', 'job-late-1'], { env: { FLEET_HOME: r.home } });
  assert.equal(down.code, 1, down.stdout);
  assert.match(down.stderr, /push still failing/);
  assert.ok(fs.existsSync(r.workspace), 'a failed retry must never delete the workspace');
  assert.ok(
    fs.existsSync(path.join(r.home, 'retained', 'job-late-1.json')),
    'a failed retry must never drop the record',
  );

  // The remote comes back.
  fs.renameSync(`${r.remote}.down`, r.remote);
  const up = await runCli(['resume-push', 'job-late-1'], { env: { FLEET_HOME: r.home } });
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, new RegExp(`pushed ${r.branch}`));
  assert.match(up.stdout, /workspace removed/);

  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', r.branch], {
    cwd: r.remote,
    encoding: 'utf8',
  });
  assert.match(tree, /work\.txt/, 'the work must be on the remote branch');
  assert.ok(!fs.existsSync(r.workspace), 'workspace is removed once the remote has the work');
  assert.ok(!fs.existsSync(path.join(r.home, 'retained', 'job-late-1.json')), 'record is dropped');
});

test('resume-push: refuses to clean up when the remote branch carries someone else', async () => {
  // 'delivered' means the branch is ahead of base — not that THIS commit landed.
  // Deleting on that alone would lose the retained work for good.
  const r = retained({ jobId: 'job-late-4', target: 'APP-126', down: false });
  const head = git(r.workspace, ['rev-parse', 'HEAD']).trim();

  // Someone else advances the job branch, so the retained push is rejected.
  const other = makeTempDir('fleet-rp-other-');
  execFileSync('git', ['clone', '-q', '--branch', r.branch, r.remote, other]);
  fs.writeFileSync(path.join(other, 'theirs.txt'), 'not the retained work\n');
  git(other, ['add', '-A']);
  git(other, ['commit', '-q', '-m', 'another hand on the branch']);
  git(other, ['push', '-q']);

  const res = await runCli(['resume-push', 'job-late-4'], { env: { FLEET_HOME: r.home } });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, new RegExp(`does not contain ${head}`));
  assert.ok(fs.existsSync(path.join(r.workspace, 'work.txt')), 'the retained work must survive');
  assert.ok(fs.existsSync(path.join(r.home, 'retained', 'job-late-4.json')), 'record kept');
});

test('resume-push: an incomplete record is refused, never guessed at', async () => {
  // The provider writes a record like this when the retain request existed but
  // could not be parsed: the workspace was kept on purpose, so keep it.
  const home = makeTempDir('fleet-rp-home-');
  const workspace = makeTempDir('fleet-rp-ws-');
  // A workspace the runner kept is a git workspace — it clones or inits before
  // anything else runs, so this fixture inits one and the case stays about the
  // record being incomplete rather than the workspace being unusable. A bare
  // mkdir of .git was enough while the guard only checked that the path
  // existed; it is not a repository, which is exactly what the neighbouring
  // test proves is unrecoverable.
  execFileSync('git', ['init', '-q', workspace]);
  writeRetainedRecord(home, {
    jobId: 'job-late-5',
    reason: 'retain request unreadable — the runner asked to keep this workspace',
    at: new Date().toISOString(),
    workspace,
  });
  const res = await runCli(['resume-push', 'job-late-5'], { env: { FLEET_HOME: home } });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /incomplete/);
  assert.match(res.stderr, /recover it by hand/);
  assert.ok(fs.existsSync(workspace), 'workspace kept');
  assert.ok(fs.existsSync(path.join(home, 'retained', 'job-late-5.json')), 'record kept');
});

test('resume-push: unknown job fails without touching anything', async () => {
  const home = makeTempDir('fleet-rp-home-');
  const res = await runCli(['resume-push', 'job-nope'], { env: { FLEET_HOME: home } });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no retained workspace for job job-nope/);
  assert.match(res.stderr, new RegExp(path.join(home, 'retained').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('resume-push: a record whose workspace is gone is dropped, not silently retried', async () => {
  const r = retained({ jobId: 'job-late-2', target: 'APP-124', down: false });
  fs.rmSync(r.workspace, { recursive: true, force: true });
  const res = await runCli(['resume-push', 'job-late-2'], { env: { FLEET_HOME: r.home } });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /retained workspace is gone/);
  assert.ok(
    !fs.existsSync(path.join(r.home, 'retained', 'job-late-2.json')),
    'a record pointing nowhere is dropped so doctor stops reporting it',
  );
});

test('resume-push: a workspace path that holds no git repo is dropped too', async () => {
  // The record's path can survive as an empty or clobbered directory — a
  // partial delete, or something else reusing the name after a cleanup. It
  // holds no work, so it is exactly as unrecoverable as a missing path. Before
  // this was checked, resume-push tried to push from it and failed deep in git
  // ("Command failed: git add -A") while keeping a record nobody could ever
  // act on; CI hit that shape intermittently.
  const r = retained({ jobId: 'job-late-6', target: 'APP-126', down: false });
  fs.rmSync(r.workspace, { recursive: true, force: true });
  fs.mkdirSync(r.workspace, { recursive: true });

  const res = await runCli(['resume-push', 'job-late-6'], { env: { FLEET_HOME: r.home } });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /retained workspace is gone/);
  assert.ok(
    !fs.existsSync(path.join(r.home, 'retained', 'job-late-6.json')),
    'a record pointing at a workspace with no git repo is dropped like a missing one',
  );
});

test('resume-push: nothing to push is a failure that keeps the workspace', async () => {
  // Workspace on the job branch with no commit beyond it: there is no
  // deliverable here, and pretending otherwise would delete the evidence.
  const home = makeTempDir('fleet-rp-home-');
  const remote = makeRemote();
  const workspace = makeTempDir('fleet-rp-ws-');
  fs.mkdirSync(path.join(workspace, '.fleet', 'out'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.fleet', 'manifest.json'), '{}');
  const { branch, base } = setupWorkspace(workspace, {
    url: remote,
    jobId: 'job-late-3',
    target: 'APP-125',
    name: 'Operator One',
    email: 'op@example.com',
  });
  writeRetainedRecord(home, {
    jobId: 'job-late-3',
    target: 'APP-125',
    branch,
    base,
    ok: false,
    reason: 'fatal: unable to access remote',
    at: new Date().toISOString(),
    workspace,
  });

  const res = await runCli(['resume-push', 'job-late-3'], { env: { FLEET_HOME: home } });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /nothing to push/);
  assert.ok(fs.existsSync(workspace), 'workspace kept for inspection');
  assert.ok(fs.existsSync(path.join(home, 'retained', 'job-late-3.json')), 'record kept too');
});

test('resume-push: takes exactly one job id', async () => {
  const res = await runCli(['resume-push'], { env: { FLEET_HOME: makeTempDir('fleet-rp-home-') } });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage error/);
});
