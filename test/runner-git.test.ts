// Workspace git lifecycle (#2): branch pushed at creation, dispatch payload
// survives the clone and never gets committed, work and WIP pushes land on
// the remote. All against a local bare-repo fixture — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupWorkspace, pushWork, pushWip, jobBranch, getHeadSha, remoteHasHead, remoteMovedBeyond, renameRemoteBranch, createDraftPr, composeDraftPrText, findOpenPr, gitCredentialEnv } from '../src/runner/git.ts';

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

test('gitCredentialEnv wires gh as the github.com helper only when a token exists', () => {
  assert.deepEqual(gitCredentialEnv({}), {}, 'no token, no injection — ssh-agent flows stay untouched');
  const injected = gitCredentialEnv({ GH_TOKEN: 't' });
  assert.equal(injected.GIT_CONFIG_COUNT, '1');
  assert.equal(injected.GIT_CONFIG_KEY_0, 'credential.https://github.com.helper');
  assert.equal(injected.GIT_CONFIG_VALUE_0, '!gh auth git-credential');
  assert.deepEqual(gitCredentialEnv({ GITHUB_TOKEN: 't' }), injected, 'both token spellings gh honors');
});

test('gitCredentialEnv merges with inherited GIT_CONFIG_* instead of clobbering it (#139)', () => {
  const inherited = {
    GH_TOKEN: 't',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'fleet.inherited',
    GIT_CONFIG_VALUE_0: 'kept',
  };
  const injected = gitCredentialEnv(inherited);
  assert.equal(injected.GIT_CONFIG_COUNT, '2', 'the count grows past the inherited entries');
  assert.equal(injected.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper', 'the helper lands at the next free index');
  assert.equal(injected.GIT_CONFIG_VALUE_1, '!gh auth git-credential');
  assert.equal(injected.GIT_CONFIG_KEY_0, undefined, 'slot 0 stays the environment\'s — never rewritten');

  // git must resolve BOTH configs from the merged env — the inherited entry
  // was clobbered wholesale before #139.
  const env = { ...process.env, ...inherited, ...injected };
  const keptValue = execFileSync('git', ['config', '--get', 'fleet.inherited'], { encoding: 'utf8', env }).trim();
  assert.equal(keptValue, 'kept', 'the inherited config still resolves');
  const helper = execFileSync('git', ['config', '--get', 'credential.https://github.com.helper'], { encoding: 'utf8', env }).trim();
  assert.equal(helper, '!gh auth git-credential', 'the injected helper resolves too');
});

test('setupWorkspace never duplicates .git/info/exclude entries already present (#139)', () => {
  // Every launch gets a fresh workspace today, so duplicates cannot pile up —
  // but nothing structural guarantees that, so the append is idempotent.
  // Byte-diff: pre-seed the exclude file with exactly what setup would write
  // and assert setup leaves it byte-identical.
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const excludeFile = join(workspace, '.git', 'info', 'exclude');
  mkdirSync(join(workspace, '.git', 'info'), { recursive: true });
  const seeded = '.fleet/out/\n.fleet/order.json\n.env.fleet\n';
  writeFileSync(excludeFile, seeded);

  setupWorkspace(workspace, opts(remote));

  assert.equal(
    readFileSync(excludeFile, 'utf8'),
    seeded,
    'exclude must be byte-identical — no entry appended twice',
  );
});

test('git accepts the injected credential config — key names are real, not typos', () => {
  const out = execFileSync('git', ['config', '--get', 'credential.https://github.com.helper'], {
    encoding: 'utf8',
    env: { ...process.env, ...gitCredentialEnv({ GH_TOKEN: 't' }) },
  }).trim();
  assert.equal(out, '!gh auth git-credential');
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

// --- Re-entry (issue #6): branch-collision guard ---

test('setupWorkspace reentry: checks out existing branch with WIP, no collision', () => {
  const remote = makeRemote();

  // First: initial setup (creates the branch, pushes it).
  const ws1 = makeWorkspace();
  const { branch, base } = setupWorkspace(ws1, opts(remote));

  // Simulate WIP: commit something and push.
  writeFileSync(join(ws1, 'half-done.txt'), 'wip\n');
  pushWip(ws1, 'block_hot expired');

  // Verify the WIP commit is on the remote.
  const subjects1 = run(ws1, ['log', '--format=%s', `origin/${branch}`]);
  assert.match(subjects1, /wip\(park\)/);

  // Second: re-entry with a fresh workspace (simulates a new container).
  const ws2 = makeWorkspace();
  const result = setupWorkspace(ws2, { ...opts(remote), reentry: true });

  assert.equal(result.branch, branch);
  assert.equal(result.base, base);

  // The WIP file is present in the re-entry workspace.
  assert.ok(existsSync(join(ws2, 'half-done.txt')), 'WIP file must be present on re-entry');
  assert.equal(readFileSync(join(ws2, 'half-done.txt'), 'utf8'), 'wip\n');

  // The re-entry does not push — the remote branch is unchanged.
  const subjects2 = run(ws2, ['log', '--format=%s', `origin/${branch}`]);
  assert.match(subjects2, /wip\(park\)/, 'remote still shows the WIP commit (no new push)');

  // A subsequent pushWork on re-entry does not trip or duplicate the branch.
  writeFileSync(join(ws2, 'final.txt'), 'done\n');
  assert.equal(pushWork(ws2, 'APP-7', 'job-1', true), 'pushed');
  const files = run(ws2, ['ls-tree', '-r', '--name-only', `origin/${branch}`]);
  assert.match(files, /half-done\.txt/);
  assert.match(files, /final\.txt/);
});

// --- Branch adoption (issue #80): followthrough continues an existing PR branch ---

test('setupWorkspace adoption: checks out the adopted branch, never a fresh job branch', () => {
  const remote = makeRemote();

  // A prior job delivered on its own branch (the branch the PR points at).
  const ws1 = makeWorkspace();
  const { branch } = setupWorkspace(ws1, opts(remote)); // fleet/APP-7-job-1
  writeFileSync(join(ws1, 'delivered.txt'), 'v1\n');
  assert.equal(pushWork(ws1, 'APP-7', 'job-1', true), 'pushed');

  // The followthrough job adopts that branch.
  const ws2 = makeWorkspace();
  const result = setupWorkspace(ws2, {
    url: remote, jobId: 'job-2', target: 'APP-7',
    name: 'Operator One', email: 'op@example.com',
    adoptBranch: branch,
  });
  assert.equal(result.branch, branch, 'the adopted branch is the job branch');
  assert.equal(readFileSync(join(ws2, 'delivered.txt'), 'utf8'), 'v1\n', 'the delivered work is checked out');

  // The bug this catches: adoption falling back to the fresh-branch path would
  // push fleet/APP-7-job-2 — stranding the PR and tripping the claim guard.
  const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.ok(!refs.includes('fleet/APP-7-job-2'), 'no fresh branch may be created on adoption');

  // Work pushes to the SAME branch, so the PR updates in place.
  writeFileSync(join(ws2, 'fix.txt'), 'review feedback addressed\n');
  assert.equal(pushWork(ws2, 'APP-7', 'job-2', true), 'pushed');
  const files = run(ws2, ['ls-tree', '-r', '--name-only', `origin/${branch}`]);
  assert.match(files, /delivered\.txt/);
  assert.match(files, /fix\.txt/);
});

test('remoteMovedBeyond judges delivery against the adopted tip, not against base', () => {
  const remote = makeRemote();
  const ws1 = makeWorkspace();
  const { branch } = setupWorkspace(ws1, opts(remote));
  writeFileSync(join(ws1, 'delivered.txt'), 'v1\n');
  pushWork(ws1, 'APP-7', 'job-1', true);

  const ws2 = makeWorkspace();
  setupWorkspace(ws2, { url: remote, jobId: 'job-2', target: 'APP-7', name: 'Operator One', email: 'op@example.com', adoptBranch: branch });
  const adoptedTip = getHeadSha(ws2);

  // The bug this catches: the adopted branch is ALWAYS ahead of base (the
  // original job's commits), so an ahead-of-base test would let a do-nothing
  // followthrough claim delivery.
  assert.equal(remoteMovedBeyond(ws2, branch, adoptedTip), false, 'nothing pushed yet — no movement');

  writeFileSync(join(ws2, 'fix.txt'), 'fix\n');
  pushWork(ws2, 'APP-7', 'job-2', true);
  assert.equal(remoteMovedBeyond(ws2, branch, adoptedTip), true, 'a pushed fix moves the branch beyond the adopted tip');

  // Unknown SHA or unreachable remote: never claim movement it cannot prove.
  assert.equal(remoteMovedBeyond(ws2, branch, '0'.repeat(40)), false);
});

test('findOpenPr queries gh for the branch head and reports the PR, or undefined', () => {
  const calls: string[][] = [];
  const workspace = makeWorkspace();
  const withList = (out: string) => (args: string[]): string => {
    calls.push(args);
    return out;
  };
  const found = findOpenPr(workspace, 'fleet/APP-7-job-1', withList('[{"url":"https://github.com/acme/example-app/pull/41","number":41}]\n'));
  assert.deepEqual(found, { url: 'https://github.com/acme/example-app/pull/41', number: 41 });
  assert.deepEqual(calls[0], ['pr', 'list', '--head', 'fleet/APP-7-job-1', '--state', 'open', '--json', 'url,number', '--limit', '1']);
  assert.ok(calls.every((c) => c[1] !== 'create'), 'a continuation settle must never create a PR');

  // No open PR for the branch (closed since dispatch): undefined, not a throw.
  assert.equal(findOpenPr(workspace, 'fleet/APP-7-job-1', withList('[]\n')), undefined);
});

test('composeDraftPrText: full report renders per the delivery standard, never a bare number', () => {
  const { title, body } = composeDraftPrText({
    target: '18',
    issueTitle: 'Artifact delivery lane',
    jobId: 'job-abc',
    report: {
      status: 'READY',
      verification: ['npm test → 140 pass', 'node --test test/runner-*.ts'],
      not_done: [],
      next_action: 'Review and merge.',
    },
  });
  assert.equal(title, '#18: Artifact delivery lane');
  assert.match(body, /## Problem\nArtifact delivery lane Closes #18\./);
  assert.match(body, /## Status\nREADY/);
  assert.match(body, /## Verification\n- npm test → 140 pass\n- node --test/);
  assert.match(body, /## Not done\n- nothing/);
  assert.match(body, /Next action: Review and merge\./);
  assert.match(body, /fleet logs job-abc/);
  assert.doesNotMatch(body, /[{}"]/, 'no raw JSON leaks into the PR body');
});

test('composeDraftPrText: thin inputs degrade honestly, not to machine exhaust', () => {
  const { title, body } = composeDraftPrText({ target: 'APP-42', jobId: 'job-x' });
  assert.equal(title, 'APP-42: fleet job job-x');
  assert.match(body, /## Status\nNo report was produced/);
  assert.match(body, /## Verification\n- none reported/);
  assert.doesNotMatch(body, /Closes/, 'non-issue targets never claim to close an issue');
});

test('composeDraftPrText: a #-prefixed target is the same issue, referenced once', () => {
  // A stored order may carry `#42`: the pre-#36 CLI did not strip the hash. The
  // old inline /^\d+$/ read that as a non-issue, so the PR silently dropped its
  // `Closes` line and auto-close broke. The shared predicate normalizes it —
  // and the bug on the other side of that fix is double-prefixing, which is why
  // the reference is asserted exactly.
  const { title, body } = composeDraftPrText({ target: '#42', issueTitle: 'Fix login', jobId: 'job-h' });
  assert.equal(title, '#42: Fix login');
  assert.doesNotMatch(body, /##42/, 'the hash must not be applied twice');
  assert.equal((body.match(/Closes #42\./g) ?? []).length, 1, 'exactly one Closes line, for issue 42');
});

test('pushWork delivers commits the agent made itself (not just uncommitted changes)', () => {
  // #34's second run: the agent committed per the playbook, pushWork saw a
  // clean status and skipped the push - the delivery vanished with the workspace.
  const remote = makeRemote();
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-ws-'));
  const { branch } = setupWorkspace(workspace, { url: remote, target: 'APP-9', jobId: 'job-self', name: 'Operator One', email: 'op@example.com' });
  writeFileSync(join(workspace, 'work.txt'), 'agent work\n');
  run(workspace, ['add', '-A']);
  run(workspace, ['commit', '-q', '-m', 'agent commits its own work']);
  assert.equal(pushWork(workspace, 'APP-9', 'job-self', true), 'pushed');
  const remoteLog = run(remote, ['log', '--oneline', branch]);
  assert.match(remoteLog, /agent commits its own work/);
});

test('pushWork reports delivered when the agent pushed itself, even after a post-push amend', () => {
  // #34's third run: agent committed, pushed, then amended - runner push was
  // rejected and the job was mislabeled "clean" despite the delivery existing.
  const remote = makeRemote();
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-ws-'));
  const { branch, base } = setupWorkspace(workspace, { url: remote, target: 'APP-8', jobId: 'job-amend', name: 'Operator One', email: 'op@example.com' });
  writeFileSync(join(workspace, 'work.txt'), 'agent work\n');
  run(workspace, ['add', '-A']);
  run(workspace, ['commit', '-q', '-m', 'agent work']);
  run(workspace, ['push', '-q']);
  run(workspace, ['commit', '--amend', '-q', '--no-edit']); // diverge from remote
  assert.equal(pushWork(workspace, 'APP-8', 'job-amend', true, base), 'delivered');
  const remoteLog = run(remote, ['log', '--oneline', branch]);
  assert.match(remoteLog, /agent work/);
});

test('remoteHasHead answers only for this HEAD, not for "the branch moved"', () => {
  // #38: `fleet resume-push` deletes a retained workspace on this answer, so a
  // branch that is ahead with somebody else's commit must read as false.
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const { branch } = setupWorkspace(workspace, opts(remote));
  writeFileSync(join(workspace, 'work.txt'), 'the only copy\n');
  run(workspace, ['add', '-A']);
  run(workspace, ['commit', '-q', '-m', 'work']);
  assert.equal(remoteHasHead(workspace, branch), false, 'unpushed commit is not on the remote');

  assert.equal(pushWork(workspace, 'APP-7', 'job-1', true), 'pushed');
  assert.equal(remoteHasHead(workspace, branch), true, 'pushed commit is on the remote');

  // Local history rewritten after the push: the remote has a commit, but not
  // this one — the retained work would be lost if this returned true.
  writeFileSync(join(workspace, 'work.txt'), 'rewritten\n');
  run(workspace, ['add', '-A']);
  run(workspace, ['commit', '--amend', '-q', '-m', 'work (amended)']);
  assert.equal(remoteHasHead(workspace, branch), false, 'an amended HEAD is not on the remote');

  // An unreachable remote is a "no", never a throw.
  const gone = mkdtempSync(join(tmpdir(), 'fleet-git-gone-'));
  run(workspace, ['remote', 'set-url', 'origin', join(gone, 'nope.git')]);
  assert.equal(remoteHasHead(workspace, branch), false);
});

test('a push that hangs is SIGKILLed at its bound and throws a timeout that names it (#152)', async () => {
  // A working remote first: a timeout on a live connection must never fire.
  const remote = makeRemote();
  const workspace = makeWorkspace();
  setupWorkspace(workspace, opts(remote));
  writeFileSync(join(workspace, 'half-done.txt'), 'wip\n');
  assert.equal(pushWip(workspace, 'block_hot expired', 30_000), 'pushed');

  // Then the black-holed remote from the issue: a server that accepts the
  // connection and never answers. Without the bound, git push waits on it
  // forever — and because these calls are execFileSync, so does the caller's
  // whole event loop: on pre-#152 code this test wedges instead of failing
  // an assertion.
  const server = createServer(() => { /* hold every request open */ });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === 'object');
  run(workspace, ['remote', 'set-url', 'origin', `http://127.0.0.1:${addr.port}/repo.git`]);
  writeFileSync(join(workspace, 'half-done.txt'), 'more wip\n');
  const started = Date.now();
  assert.throws(
    () => pushWip(workspace, 'cancelled: SIGTERM', 1_500),
    /git push timed out after 1500ms/,
    'the error must name the timeout so the teardown log can distinguish a hang from a rejection',
  );
  assert.ok(Date.now() - started < 10_000, 'the hang must be cut at the bound, not ride it out');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Harness-exit auto-retry: claim release by rename (#30) ─────────────────────

test('renameRemoteBranch moves the claim aside and keeps every commit reachable (#30)', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const { branch } = setupWorkspace(workspace, opts(remote));
  writeFileSync(join(workspace, 'partial.txt'), 'half-finished\n');
  pushWork(workspace, 'APP-7', 'job-1', false);

  assert.equal(renameRemoteBranch(workspace, branch, `${branch}-attempt1`), 'renamed');
  const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.ok(!refs.includes(`refs/heads/${branch}\n`), 'the old claim name is gone');
  assert.ok(refs.includes(`refs/heads/${branch}-attempt1`), 'the evidence branch exists');
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', `${branch}-attempt1`], { cwd: remote, encoding: 'utf8' });
  assert.match(tree, /partial\.txt/, 'the partial work survives the rename');
});

test('renameRemoteBranch on a branch the remote never had reports absent, touches nothing', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  setupWorkspace(workspace, opts(remote));
  assert.equal(renameRemoteBranch(workspace, 'fleet/APP-7-job-ghost', 'fleet/APP-7-job-ghost-attempt1'), 'absent');
  const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.ok(!refs.includes('ghost'), 'no ref invented');
});

test('a retry attempt renames the previous claim, then creates its fresh branch from base (#30)', () => {
  const remote = makeRemote();
  const first = makeWorkspace();
  const { branch } = setupWorkspace(first, opts(remote));
  writeFileSync(join(first, 'partial.txt'), 'attempt 1 got this far\n');
  pushWork(first, 'APP-7', 'job-1', false);

  // Attempt 2: same job id, fresh workspace — exactly what the daemon relaunches.
  const second = makeWorkspace();
  const setup = setupWorkspace(second, { ...opts(remote), retryAttempt: 2 });
  assert.equal(setup.branch, branch, 'the retry claims the same branch name');
  assert.equal(setup.released, `${branch}-attempt1`, 'the previous claim is reported released');

  const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.ok(refs.includes(`refs/heads/${branch}-attempt1`), 'attempt 1 evidence retained');
  assert.ok(refs.includes(`refs/heads/${branch}\n`), 'the fresh claim branch is pushed');
  // The fresh branch starts from base — attempt 1's partial work is NOT on it.
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: remote, encoding: 'utf8' });
  assert.ok(!tree.includes('partial.txt'), 'the retry starts clean, not on top of the failed attempt');
  const evidence = execFileSync('git', ['ls-tree', '-r', '--name-only', `${branch}-attempt1`], { cwd: remote, encoding: 'utf8' });
  assert.match(evidence, /partial\.txt/, 'the failed attempt stays inspectable');
});

test('a retry whose previous attempt never pushed proceeds without a rename', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  // No prior branch on the remote (attempt 1 died before its creation push).
  const setup = setupWorkspace(workspace, { ...opts(remote), retryAttempt: 2 });
  assert.equal(setup.released, undefined);
  const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.ok(refs.includes(`refs/heads/${setup.branch}`), 'the branch is still created and pushed');
});
