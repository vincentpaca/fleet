// Workspace git lifecycle (#2): branch pushed at creation, dispatch payload
// survives the clone and never gets committed, work and WIP pushes land on
// the remote. All against a local bare-repo fixture — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupWorkspace, pushWork, pushWip, sideMerged, jobBranch, validBranchName, getHeadSha, remoteHasHead, remoteMovedBeyond, renameRemoteBranch, createDraftPr, composeDraftPrText, findOpenPr, gitCredentialEnv } from '../src/runner/git.ts';

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

/** A job's push refs (#291): its branch, and the side branch keyed on its id. */
const R = (branch: string, jobId = 'job-1') => ({ branch, side: `fleet-diverged/${jobId}` });

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
  assert.equal(pushWork(workspace, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', true), 'pushed');
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
  assert.equal(pushWork(workspace, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', true), 'clean');
  writeFileSync(join(workspace, 'half-done.txt'), 'wip\n');
  assert.equal(pushWip(workspace, R('fleet/APP-7-job-1'), 'block_hot expired'), 'pushed');
  const subject = run(workspace, ['log', '-1', '--format=%s', 'origin/fleet/APP-7-job-1']);
  assert.match(subject, /^wip\(park\): block_hot expired/);
});

test('partial work is pushed with a partial marker — evidence over tidiness', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const { branch: _branch3 } = setupWorkspace(workspace, opts(remote));
  writeFileSync(join(workspace, 'attempt.txt'), 'incomplete\n');
  assert.equal(pushWork(workspace, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', false), 'pushed');
  const subject = run(workspace, ['log', '-1', '--format=%s', 'origin/fleet/APP-7-job-1']);
  assert.match(subject.trim(), /\(partial\)$/);
});

test('jobBranch sanitizes hostile targets', () => {
  assert.equal(jobBranch('QA symptom: 403 on upload!', 'j9'), 'fleet/QA-symptom-403-on-upload-j9');
  assert.equal(jobBranch('...', 'j9'), 'fleet/work-j9');
});

/** A prose target the length of a whole prompt — the canary's shape, longer. */
const LONG_TARGET = 'Canary: prove this deployment can run a job. '.repeat(9);

test('jobBranch caps the name at what git can lock, keeping the job id whole', () => {
  const jobId = 'job-mfk2z8x1-9a3c7e02';
  const branch = jobBranch(LONG_TARGET, jobId);
  const component = branch.slice('fleet/'.length);
  // The measured ceiling: git locks a loose ref by creating <name>.lock, so a
  // component may be NAME_MAX (255) minus five. 251 fails "File name too long".
  assert.ok(component.length <= 250, `component is ${component.length} characters`);
  // Truncation must eat the target, never the suffix that distinguishes jobs.
  assert.ok(branch.endsWith(`-${jobId}`), branch);
  assert.notEqual(branch, jobBranch(LONG_TARGET, 'job-mfk2z8x1-9a3c7e03'));
  // fleet reclaim lists claims by jobBranch(target, ''); a cut whose width
  // depends on the job id would leave it matching nothing.
  assert.ok(branch.startsWith(jobBranch(LONG_TARGET, '')), 'the claim prefix must still prefix the branch');
});

test('a prose target long enough to break git still creates and pushes its branch', () => {
  // The failure this replaces: an uncapped name reached setupWorkspace and the
  // job died there on "cannot lock ref ... File name too long".
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const { branch } = setupWorkspace(workspace, { ...opts(remote), target: LONG_TARGET, jobId: 'job-mfk2z8x1-9a3c7e02' });
  const refs = execFileSync('git', ['ls-remote', '--heads', remote, branch], { encoding: 'utf8' });
  assert.ok(refs.includes(`refs/heads/${branch}`), `branch ${branch} never reached the remote`);
  // And the claim it creates can still be released — the rename appends more.
  assert.equal(renameRemoteBranch(workspace, branch, `${branch}-attempt1`), 'renamed');
});

/** Ask git itself whether a name is a legal ref — never re-implement its rules here. */
function gitAcceptsRef(name: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', `refs/heads/${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Targets shaped like the ones that reach dispatch: prose, punctuation, paths,
 * control bytes, and the ellipsis that made this test necessary.
 */
const HOSTILE_TARGETS = [
  'QA symptom: 403 on upload!',
  '...',
  '..',
  'a..b',
  'Fix the flake in auth... then re-run CI',
  '.hidden',
  'trailing.',
  'refs.lock',
  'HEAD@{1}',
  '@',
  '-oops',
  'feature/../../etc/passwd',
  'a b',
  '   ',
  '///',
  '$(touch /tmp/pwn) && `id`',
  'tab\tand\nnewline\x7f',
  'ünïcødé prose target',
  'x'.repeat(400),
  LONG_TARGET,
  `${'y'.repeat(199)}...tail`,
];

test('every name jobBranch emits is one git accepts, and one validBranchName admits', () => {
  // The class this pins: a target reaching setupWorkspace as a ref git refuses,
  // which kills the job there. Length was one instance; '.' surviving the
  // sanitizer's character class into '..' — which git bans anywhere in a ref —
  // was another. Both are the same defect, so both are checked the same way:
  // against real git, not against a copy of its rules.
  for (const target of HOSTILE_TARGETS) {
    const branch = jobBranch(target, 'job-mfk2z8x1-9a3c7e02');
    assert.ok(gitAcceptsRef(branch), `git refuses ${JSON.stringify(branch)} from target ${JSON.stringify(target)}`);
    // And the vet applied to externally-chosen names must admit our own —
    // if it did not, the two would be enforcing different shapes.
    assert.equal(validBranchName(branch), true, branch);
  }
});

test('two long targets sharing a cut prefix keep distinct claim namespaces', () => {
  // Truncation alone made these one namespace, and `fleet reclaim <target>`
  // releases by that namespace: reclaiming one would have renamed the other's
  // live claim out from under a running job.
  const shared = 'Investigate the intermittent 502 from the upload service. '.repeat(5);
  const [a, b] = [`${shared} It reproduces on retry.`, `${shared} It never reproduces on retry.`];
  assert.notEqual(jobBranch(a, 'job-1'), jobBranch(b, 'job-1'));
  const [prefixA, prefixB] = [jobBranch(a, ''), jobBranch(b, '')];
  assert.ok(!prefixA.startsWith(prefixB) && !prefixB.startsWith(prefixA), `${prefixA} vs ${prefixB}`);
  // The discriminator comes off the target, not the job id, so the reclaim
  // prefix still prefixes every job branch for that target.
  assert.ok(jobBranch(a, 'job-1').startsWith(prefixA), prefixA);
  assert.ok(jobBranch(a, 'job-2').startsWith(prefixA), prefixA);
});

test('validBranchName is a whitelist, refusing names git itself accepts', () => {
  // git has no use for these bytes so it permits them. The consumer downstream
  // is not git: the branch lands in the harness prompt (continuationClause) and
  // on a command line, where every one of them means something.
  for (const legalButUnsafe of ['a$b', 'a`b', 'a(b)', 'a|b', 'a{b}', 'a;b', 'a&b', 'a>b', "a'b", 'a"b', 'a#b', 'ünïcode']) {
    assert.equal(gitAcceptsRef(legalButUnsafe), true, `git should still accept ${legalButUnsafe}`);
    assert.equal(validBranchName(legalButUnsafe), false, legalButUnsafe);
  }
});

test('validBranchName applies git ref rules to a name chosen elsewhere', () => {
  for (const ok of ['fleet/9-job-old', 'feature/a.b', 'v2', 'a'.repeat(250)]) {
    assert.equal(validBranchName(ok), true, ok);
  }
  const refused = [
    '', '@', '-oops', '--upload-pack=touch /tmp/pwn', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?b',
    'a*b', 'a[b', 'a\\b', 'a@{b', 'a/', '/a', 'a//b', 'a.', '.a', 'a/.b', 'a.lock', 'a/b.lock',
    'a\nb', 'a\x7fb', 'a'.repeat(251),
  ];
  for (const bad of refused) {
    assert.equal(validBranchName(bad), false, JSON.stringify(bad));
  }
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
  pushWork(workspace, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', true);
  const sha = getHeadSha(workspace);
  assert.match(sha, /^[0-9a-f]{40}$/);
  // The SHA matches what git reports for HEAD on the remote.
  const remoteHead = run(workspace, ['rev-parse', `origin/fleet/APP-7-job-1`]).trim();
  assert.equal(sha, remoteHead);
});

// Settle reports and event log lines keep only err.message's first line, and
// execFileSync's first line is the argv echoed back — the #218 dispatches all
// settled with "Command failed: git config user.name …" while git's actual
// refusal (dubious ownership) sat below the fold. The chokepoint refolds.
test('a failed git call carries stderr on the first line of err.message', () => {
  const notARepo = mkdtempSync(join(tmpdir(), 'fleet-ws-'));
  assert.throws(
    () => getHeadSha(notARepo),
    (err: unknown) => {
      const firstLine = String(err instanceof Error ? err.message : err).split('\n')[0];
      assert.match(firstLine, /^git rev-parse failed: fatal: not a git repository/);
      return true;
    },
  );
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
  pushWip(ws1, R('fleet/APP-7-job-1'), 'block_hot expired');

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
  assert.equal(pushWork(ws2, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', true), 'pushed');
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
  assert.equal(pushWork(ws1, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', true), 'pushed');

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
  assert.equal(pushWork(ws2, R(branch, 'job-2'), 'APP-7', 'job-2', true), 'pushed');
  const files = run(ws2, ['ls-tree', '-r', '--name-only', `origin/${branch}`]);
  assert.match(files, /delivered\.txt/);
  assert.match(files, /fix\.txt/);
});

test('remoteMovedBeyond judges delivery against the adopted tip, not against base', () => {
  const remote = makeRemote();
  const ws1 = makeWorkspace();
  const { branch } = setupWorkspace(ws1, opts(remote));
  writeFileSync(join(ws1, 'delivered.txt'), 'v1\n');
  pushWork(ws1, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', true);

  const ws2 = makeWorkspace();
  setupWorkspace(ws2, { url: remote, jobId: 'job-2', target: 'APP-7', name: 'Operator One', email: 'op@example.com', adoptBranch: branch });
  const adoptedTip = getHeadSha(ws2);

  // The bug this catches: the adopted branch is ALWAYS ahead of base (the
  // original job's commits), so an ahead-of-base test would let a do-nothing
  // followthrough claim delivery.
  assert.equal(remoteMovedBeyond(ws2, branch, adoptedTip), false, 'nothing pushed yet — no movement');

  writeFileSync(join(ws2, 'fix.txt'), 'fix\n');
  pushWork(ws2, R(branch, 'job-2'), 'APP-7', 'job-2', true);
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
  assert.equal(pushWork(workspace, R(branch, 'job-self'), 'APP-9', 'job-self', true), 'pushed');
  const remoteLog = run(remote, ['log', '--oneline', branch]);
  assert.match(remoteLog, /agent commits its own work/);
});

test('pushWork never reads a post-push amend as clean: the amended HEAD is diverted, the pushed one kept', () => {
  // #34's third run: agent committed, pushed, then amended - runner push was
  // rejected and the job was mislabeled "clean" despite the delivery existing.
  // Since #291 the amended HEAD, which the job branch refuses, is diverted to
  // the side branch rather than dropped.
  const remote = makeRemote();
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-ws-'));
  const { branch, base } = setupWorkspace(workspace, { url: remote, target: 'APP-8', jobId: 'job-amend', name: 'Operator One', email: 'op@example.com' });
  writeFileSync(join(workspace, 'work.txt'), 'agent work\n');
  run(workspace, ['add', '-A']);
  run(workspace, ['commit', '-q', '-m', 'agent work']);
  run(workspace, ['push', '-q']);
  run(workspace, ['commit', '--amend', '-q', '-m', 'agent work (amended)']); // diverge from remote
  const outcome = pushWork(workspace, R(branch, 'job-amend'), 'APP-8', 'job-amend', true, base);
  assert.ok(typeof outcome === 'object', `expected a diversion, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.diverted, 'fleet-diverged/job-amend');
  assert.equal(outcome.delivered, true, 'the job branch already carries the delivery, so its PR still opens (#34)');
  assert.match(run(remote, ['log', '--oneline', branch]), /agent work$/m, 'the pushed delivery stays on the job branch');
  assert.match(run(remote, ['log', '--oneline', outcome.diverted]), /agent work \(amended\)/, 'the amend is not lost');
});

test('from a foreign branch that contains the job tip, the runner pushes to the job branch and commits nothing locally (#291)', () => {
  const remote = makeRemote();
  const ws = makeWorkspace();
  const { branch } = setupWorkspace(ws, opts(remote));
  // Another PR's branch, cut from the job tip and on origin: what `gh pr
  // checkout <n>` leaves, with an upstream the agent may later plain-push to.
  run(ws, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(ws, 'feature.txt'), 'their PR\n');
  run(ws, ['add', 'feature.txt']);
  run(ws, ['commit', '-q', '-m', 'their PR']);
  run(ws, ['push', '-q', '-u', 'origin', 'feature']);
  const featureTip = run(ws, ['rev-parse', 'feature']).trim();

  // Nothing of the agent's own yet: PR n's commits are not republished as work.
  assert.equal(pushWip(ws, R(branch), 'review only'), 'clean');
  assert.doesNotMatch(run(remote, ['ls-tree', '-r', '--name-only', branch]), /feature\.txt/);

  writeFileSync(join(ws, 'mine.txt'), 'built on top\n');
  assert.equal(pushWip(ws, R(branch), 'one'), 'pushed');
  assert.equal(run(ws, ['rev-parse', 'feature']).trim(), featureTip, 'the local foreign branch must not move');
  assert.equal(run(remote, ['rev-parse', 'feature']).trim(), featureTip, 'origin/feature must not move');
  assert.match(run(remote, ['ls-tree', '-r', '--name-only', branch]), /mine\.txt/);

  // The runner's own snapshot is not in HEAD, by design; the next checkpoint
  // still lands on the job branch instead of diverting.
  writeFileSync(join(ws, 'mine.txt'), 'built on top, more\n');
  assert.equal(pushWip(ws, R(branch), 'two'), 'pushed');
  assert.equal(run(remote, ['show', `${branch}:mine.txt`]), 'built on top, more\n');
  assert.equal(execFileSync('git', ['ls-remote', '--heads', remote, 'fleet-diverged/job-1'], { encoding: 'utf8' }), '', 'nothing diverted');
  assert.equal(run(ws, ['rev-parse', 'feature']).trim(), featureTip);
});

test('a diversion never counts as clean when the job branch already carries the agent\'s own push (#291)', () => {
  const remote = makeRemote();
  const ws = makeWorkspace();
  const { branch, base } = setupWorkspace(ws, opts(remote));
  writeFileSync(join(ws, 'delivered.txt'), 'agent pushed this\n');
  run(ws, ['add', '-A']);
  run(ws, ['commit', '-q', '-m', 'agent delivery']);
  run(ws, ['push', '-q']);
  run(ws, ['checkout', '-q', '-b', 'm', 'origin/main']);
  // HEAD (main) does not build on the job branch, and has nothing of its own:
  // the settle must still see the delivery the job branch holds.
  assert.equal(pushWork(ws, R(branch), 'APP-7', 'job-1', true, base), 'delivered');
});

test('a snapshot that carried an edit since dropped is not "reverted" on the side branch (#291)', () => {
  const remote = makeRemote();
  const ws = makeWorkspace();
  const { branch } = setupWorkspace(ws, opts(remote));
  writeFileSync(join(ws, 'checkpointed.txt'), 'x\n');
  assert.equal(pushWip(ws, R(branch), 'checkpoint'), 'pushed');
  run(ws, ['checkout', '-q', '-b', 'x', 'origin/main']);
  writeFileSync(join(ws, 'scratch.txt'), 'kept on the side branch\n');
  const first = pushWip(ws, R(branch), 'one');
  assert.ok(typeof first === 'object' && first.moved);
  const sideTip = run(remote, ['rev-parse', 'fleet-diverged/job-1']).trim();
  rmSync(join(ws, 'scratch.txt'));
  const second = pushWip(ws, R(branch), 'two');
  assert.ok(typeof second === 'object' && !second.moved, `got ${JSON.stringify(second)}`);
  assert.equal(run(remote, ['rev-parse', 'fleet-diverged/job-1']).trim(), sideTip, 'the side branch keeps the edit');
});

test('an agent commit the runner pushed as-is is never forgiven: a later unrelated checkout diverts (#291)', () => {
  const remote = makeRemote();
  const ws = makeWorkspace();
  const { branch } = setupWorkspace(ws, opts(remote));
  // The agent's own commit C1 on a scratch branch; the checkpoint pushes it as-is.
  run(ws, ['checkout', '-q', '-b', 'scratch']);
  writeFileSync(join(ws, 'c1.txt'), 'the agent\'s work\n');
  run(ws, ['add', 'c1.txt']);
  run(ws, ['commit', '-q', '-m', 'C1']);
  assert.equal(pushWip(ws, R(branch), 'one'), 'pushed');
  const c1 = run(ws, ['rev-parse', 'HEAD']).trim();
  assert.equal(run(remote, ['rev-parse', branch]).trim(), c1);

  // What `gh pr checkout 99` leaves: another PR's branch cut from main, then edits.
  run(ws, ['checkout', '-q', '-b', 'pr99', 'origin/main']);
  writeFileSync(join(ws, 'p99.txt'), 'their PR\n');
  run(ws, ['add', 'p99.txt']);
  run(ws, ['commit', '-q', '-m', 'PR 99']);
  run(ws, ['push', '-q', '-u', 'origin', 'pr99']);
  writeFileSync(join(ws, 'review-notes.txt'), 'edits on top of PR 99\n');
  const outcome = pushWip(ws, R(branch), 'two');
  assert.ok(typeof outcome === 'object', `PR 99's work must not land on the job branch; got ${JSON.stringify(outcome)}`);
  assert.equal(run(remote, ['rev-parse', branch]).trim(), c1, 'the job branch keeps C1 and only C1');
  assert.match(run(remote, ['ls-tree', '-r', '--name-only', branch]), /c1\.txt/);
  assert.doesNotMatch(run(remote, ['ls-tree', '-r', '--name-only', branch]), /p99\.txt/);
});

test('an amend after the runner pushed the agent\'s commit diverts instead of merging over it (#291)', () => {
  const remote = makeRemote();
  const ws = makeWorkspace();
  const { branch } = setupWorkspace(ws, opts(remote));
  run(ws, ['checkout', '-q', '-b', 'scratch']);
  writeFileSync(join(ws, 'c1.txt'), 'v1\n');
  run(ws, ['add', 'c1.txt']);
  run(ws, ['commit', '-q', '-m', 'C1']);
  assert.equal(pushWip(ws, R(branch), 'one'), 'pushed');
  const c1 = run(ws, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(ws, 'c1.txt'), 'v2\n');
  run(ws, ['commit', '-q', '-a', '--amend', '-m', 'C1 (amended)']);
  const outcome = pushWip(ws, R(branch), 'two');
  assert.ok(typeof outcome === 'object', `an amend must divert; got ${JSON.stringify(outcome)}`);
  assert.equal(run(remote, ['rev-parse', branch]).trim(), c1, 'no merge of C1 and its amend on the job branch');
  assert.equal(run(remote, ['show', `${outcome.diverted}:c1.txt`]), 'v2\n');
});

test('a missing side branch is found absent whatever git prints on stderr (#291)', () => {
  const remote = makeRemote();
  const ws = makeWorkspace();
  const { branch } = setupWorkspace(ws, opts(remote));
  writeFileSync(join(ws, 'checkpointed.txt'), 'x\n');
  assert.equal(pushWip(ws, R(branch), 'checkpoint'), 'pushed');
  run(ws, ['checkout', '-q', '-b', 'x', 'origin/main']);
  writeFileSync(join(ws, 'unsaved.txt'), 'only here\n');
  // A localized git, or one that opens with a redirect warning: every failing
  // fetch says something other than "couldn't find remote ref".
  withGitShim([
    'if [ "$1" = fetch ]; then',
    '  "$REAL_GIT" "$@" 2>/dev/null && exit 0',
    '  code=$?',
    '  echo "warning: redirecting to elsewhere" >&2',
    '  echo "fatal: Remote-Referenz nicht gefunden" >&2',
    '  exit $code',
    'fi',
  ], () => {
    const outcome = pushWip(ws, R(branch), 'cancelled: SIGTERM');
    assert.ok(typeof outcome === 'object' && outcome.moved, `the first diversion must land; got ${JSON.stringify(outcome)}`);
  });
  assert.match(run(remote, ['ls-tree', '-r', '--name-only', 'fleet-diverged/job-1']), /unsaved\.txt/);
});

/**
 * Run `fn` with a `git` shim first on PATH (#291): `body` is sh that runs
 * before the real git, reachable as "$REAL_GIT"; falling through execs it.
 * The runner's git calls inherit process.env, so the shim sees every one.
 */
function withGitShim(body: string[], fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-git-shim-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'git'), ['#!/bin/sh', `REAL_GIT="${realGit}"`, ...body, 'exec "$REAL_GIT" "$@"', ''].join('\n'), { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    fn();
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('re-entry names the side branch an earlier park diverted to; a retry moves it aside (#291)', () => {
  const remote = makeRemote();
  const ws1 = makeWorkspace();
  const { branch } = setupWorkspace(ws1, opts(remote));
  writeFileSync(join(ws1, 'checkpointed.txt'), 'x\n');
  assert.equal(pushWip(ws1, R(branch), 'checkpoint'), 'pushed');
  run(ws1, ['checkout', '-q', '-b', 'x', 'origin/main']);
  writeFileSync(join(ws1, 'parked.txt'), 'diverted at park\n');
  assert.ok(typeof pushWip(ws1, R(branch), 'block_hot expired') === 'object');

  const ws2 = makeWorkspace();
  const reentry = setupWorkspace(ws2, { ...opts(remote), reentry: true });
  assert.equal(reentry.side, 'fleet-diverged/job-1');
  assert.equal(reentry.divertedEarlier, 'fleet-diverged/job-1', 'the re-entered run must be told where the parked work is');

  // Once the job branch contains the side tip, nobody is told to bring it over again.
  const sideTip = run(remote, ['rev-parse', 'fleet-diverged/job-1']).trim();
  run(remote, ['update-ref', `refs/heads/${branch}`, sideTip]);
  const merged = setupWorkspace(makeWorkspace(), { ...opts(remote), reentry: true });
  assert.equal(merged.divertedEarlier, undefined, 'work already on the job branch is not announced');
  assert.equal(sideMerged(ws2, R(branch)), true);

  const retry = setupWorkspace(makeWorkspace(), { ...opts(remote), retryAttempt: 2 });
  assert.equal(retry.releasedSide, 'fleet-diverged/job-1-attempt1', 'the side branch rename is reported, like the claim');
  const heads = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.ok(!heads.includes('refs/heads/fleet-diverged/job-1\n'), 'the retry must not inherit attempt 1\'s side branch');
  assert.ok(heads.includes('refs/heads/fleet-diverged/job-1-attempt1'), 'attempt 1\'s diverted work stays reachable');
});

test('a HEAD the job branch refuses goes to one side branch, chained, payload-free, agent branch untouched (#291)', () => {
  const remote = makeRemote();
  const ws = makeWorkspace();
  const { branch } = setupWorkspace(ws, opts(remote));
  const side = 'fleet-diverged/job-1';
  writeFileSync(join(ws, 'checkpointed.txt'), 'on the job branch\n');
  assert.equal(pushWip(ws, R(branch), 'checkpoint'), 'pushed');
  const jobTip = run(remote, ['rev-parse', branch]).trim();

  // A fresh branch off main holds nothing beyond the job branch: no side push.
  run(ws, ['checkout', '-q', '-b', 'x', 'origin/main']);
  assert.equal(pushWip(ws, R(branch), 'idle'), 'clean');
  assert.equal(execFileSync('git', ['ls-remote', '--heads', remote, side], { encoding: 'utf8' }), '', 'no side branch invented for nothing');

  // Agent work, committed and not: diverted without moving x or its index.
  writeFileSync(join(ws, 'a.txt'), 'a\n');
  run(ws, ['add', 'a.txt']);
  run(ws, ['commit', '-q', '-m', 'agent a']);
  writeFileSync(join(ws, 'dirty.txt'), 'd\n');
  const xTip = run(ws, ['rev-parse', 'x']).trim();
  const first = pushWip(ws, R(branch), 'one');
  assert.ok(typeof first === 'object' && first.diverted === side && first.moved, `got ${JSON.stringify(first)}`);
  assert.match(first.reason, /the agent is on branch x, whose history does not contain origin\/fleet\/APP-7-job-1/);
  assert.equal(run(ws, ['rev-parse', 'x']).trim(), xTip, 'the agent\'s branch must not carry a runner commit');
  assert.match(run(ws, ['status', '--porcelain']), /^\?\? dirty\.txt$/m, 'the agent\'s index must be untouched');

  // The agent moves on; the next diversion fast-forwards the same side branch
  // with a plain push (a wrong parent would be rejected here, not forced).
  run(ws, ['add', 'dirty.txt']);
  run(ws, ['commit', '-q', '-m', 'agent b']);
  const second = pushWip(ws, R(branch), 'two');
  assert.ok(typeof second === 'object' && second.moved);
  const third = pushWip(ws, R(branch), 'three');
  assert.ok(typeof third === 'object' && !third.moved, 'nothing new is not a push');

  const tree = run(remote, ['ls-tree', '-r', '--name-only', side]);
  assert.match(tree, /a\.txt/);
  assert.match(tree, /dirty\.txt/);
  // The dispatch payload stays out, exactly as on the job branch.
  assert.ok(!tree.includes('.env.fleet'), 'sync files must never be committed');
  assert.ok(!tree.includes('.fleet/order.json'), 'order.json must never be committed');
  assert.match(run(remote, ['show', `${side}:.fleet/manifest.json`]), /repo copy/, 'the dispatched manifest must not replace the tracked one');
  assert.equal(run(remote, ['rev-parse', branch]).trim(), jobTip, 'the job branch never moves for diverted work');
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

  assert.equal(pushWork(workspace, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', true), 'pushed');
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
  assert.equal(pushWip(workspace, R('fleet/APP-7-job-1'), 'block_hot expired', 30_000), 'pushed');

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
    () => pushWip(workspace, R('fleet/APP-7-job-1'), 'cancelled: SIGTERM', 1_500),
    /git push timed out after 1500ms/,
    'the error must name the timeout so the teardown log can distinguish a hang from a rejection',
  );
  assert.ok(Date.now() - started < 10_000, 'the hang must be cut at the bound, not ride it out');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('the network calls of one diverted push share ONE bound, not one each (#291)', () => {
  const remote = makeRemote();
  const ws = makeWorkspace();
  const { branch } = setupWorkspace(ws, opts(remote));
  writeFileSync(join(ws, 'checkpointed.txt'), 'x\n');
  assert.equal(pushWip(ws, R(branch), 'checkpoint'), 'pushed');
  run(ws, ['checkout', '-q', '-b', 'x', 'origin/main']);
  writeFileSync(join(ws, 'first.txt'), 'diverted once\n');
  assert.ok(typeof pushWip(ws, R(branch), 'one') === 'object', 'the side branch exists from here on');
  writeFileSync(join(ws, 'second.txt'), 'more\n');

  // With the side branch present the divert path makes three network calls:
  // ls-remote, fetch, push. Each takes ~1.2s here, so all three fit a 3000ms
  // bound each but not one shared 3000ms deadline — which is the cancel
  // teardown's budget, and running past it loses the settle.
  withGitShim(['case "$1" in ls-remote|fetch|push) sleep 1.2;; esac'], () => {
    assert.throws(() => pushWip(ws, R(branch), 'cancelled: SIGTERM', 3_000), /timed out/);
  });
});

test('a failing side-branch check never fails re-entry setup; it reminds instead (#291)', () => {
  const remote = makeRemote();
  const { branch } = setupWorkspace(makeWorkspace(), opts(remote));
  // The check is informational: main has no such call, so a remote that will
  // not list the side branch must not kill a re-entry that worked before.
  withGitShim(['case "$*" in *ls-remote*fleet-diverged*) echo "fatal: unable to access" >&2; exit 128;; esac'], () => {
    const reentry = setupWorkspace(makeWorkspace(), { ...opts(remote), reentry: true });
    assert.equal(reentry.branch, branch);
    assert.equal(reentry.divertedEarlier, 'fleet-diverged/job-1', 'an unanswered check reminds rather than stays silent');
  });
});

// ── Harness-exit auto-retry: claim release by rename (#30) ─────────────────────

test('renameRemoteBranch moves the claim aside and keeps every commit reachable (#30)', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const { branch } = setupWorkspace(workspace, opts(remote));
  writeFileSync(join(workspace, 'partial.txt'), 'half-finished\n');
  pushWork(workspace, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', false);

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
  pushWork(first, R('fleet/APP-7-job-1'), 'APP-7', 'job-1', false);

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

// ── Host-lost auto-retry: resume, never rename (#293) ─────────────────────────

test('a host-lost retry resumes the lost attempt\'s pushed WIP commit, renaming nothing (#293)', () => {
  const remote = makeRemote();
  const first = makeWorkspace();
  const { branch } = setupWorkspace(first, opts(remote));
  writeFileSync(join(first, 'partial.txt'), 'attempt 1 got this far\n');
  // The cancel teardown's push as the host went away, as plain git so this
  // test is independent of the push helpers' signatures (#291 changes them).
  execFileSync('git', ['add', 'partial.txt'], { cwd: first });
  execFileSync('git', ['commit', '-q', '-m', 'wip: cancelled: SIGTERM'], { cwd: first });
  execFileSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: first });
  const wip = execFileSync('git', ['rev-parse', branch], { cwd: remote, encoding: 'utf8' }).trim();

  const second = makeWorkspace();
  const setup = setupWorkspace(second, { ...opts(remote), retryAttempt: 2, resume: true });
  assert.equal(setup.branch, branch);
  assert.equal(setup.resumed, true, 'the setup reports the resume');
  assert.equal(setup.released, undefined, 'nothing renamed: the claim is still this job\'s');
  assert.equal(getHeadSha(second), wip, 'attempt 2 starts from attempt 1\'s pushed WIP commit');
  assert.equal(readFileSync(join(second, 'partial.txt'), 'utf8'), 'attempt 1 got this far\n');
  const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.ok(!refs.includes('-attempt1'), 'no evidence branch: the work continues in place');

  // Attempt 2's work lands on top of attempt 1's, on the same branch.
  writeFileSync(join(second, 'work.txt'), 'finished on attempt 2\n');
  execFileSync('git', ['add', 'work.txt'], { cwd: second });
  execFileSync('git', ['commit', '-q', '-m', 'finish'], { cwd: second });
  // A fast-forward: rejected if attempt 2 had not started from attempt 1's tip.
  execFileSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: second });
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: remote, encoding: 'utf8' });
  assert.match(tree, /partial\.txt/);
  assert.match(tree, /work\.txt/);
});

test('a host-lost resume finds the lost attempt\'s diverted work and renames nothing (#291 with #293)', () => {
  const remote = makeRemote();
  const first = makeWorkspace();
  const { branch } = setupWorkspace(first, opts(remote));
  // Attempt 1's agent left the job branch's history; its WIP went to the side branch.
  const side = 'fleet-diverged/job-1';
  writeFileSync(join(first, 'diverted.txt'), 'attempt 1, off the job branch\n');
  execFileSync('git', ['checkout', '-q', '--orphan', 'elsewhere'], { cwd: first });
  execFileSync('git', ['add', 'diverted.txt'], { cwd: first });
  execFileSync('git', ['commit', '-q', '-m', 'wip: diverted'], { cwd: first });
  execFileSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${side}`], { cwd: first });

  const second = makeWorkspace();
  const setup = setupWorkspace(second, { ...opts(remote), retryAttempt: 2, resume: true });
  assert.equal(setup.branch, branch);
  assert.equal(setup.resumed, true);
  // Keyed on `existing`, not on the declared re-entry/adoption alone: a resume
  // that missed this would continue without the lost attempt's diverted work.
  assert.equal(setup.divertedEarlier, side, 'the resumed attempt is told where the diverted work is');
  assert.equal(setup.releasedSide, undefined, 'a resume renames no side branch');
  const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.ok(refs.includes(`refs/heads/${side}\n`), 'the side branch is still under its own name');
  assert.ok(!refs.includes('-attempt1'), 'nothing renamed aside');
});

test('a host-lost retry whose lost attempt never pushed creates its branch as usual (#293)', () => {
  const remote = makeRemote();
  const workspace = makeWorkspace();
  const setup = setupWorkspace(workspace, { ...opts(remote), retryAttempt: 2, resume: true });
  assert.equal(setup.resumed, undefined, 'nothing to resume');
  const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
  assert.ok(refs.includes(`refs/heads/${setup.branch}`), 'the branch is created and pushed, not a git failure');
});
