// `fleet reclaim <target>` (#30): release a dead job's branch claim by
// renaming it on origin — the manual sibling of the harness-exit auto-retry's
// rename, for the messes policy does not cover. Rename, never delete; refuse
// while the claiming job is live; released -attemptN branches are not claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, makeTempDir, startMockDaemon } from './cli-helpers.ts';

const IDENTITY = ['-c', 'user.name=Operator One', '-c', 'user.email=op@example.com'];

/** A bare remote seeded with main, plus a local clone whose origin is it. */
function makeRepo(): { remote: string; clone: string } {
  const dir = makeTempDir('fleet-reclaim-');
  const remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  mkdirSync(seed);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  execFileSync('git', [...IDENTITY, 'add', '-A'], { cwd: seed });
  execFileSync('git', [...IDENTITY, 'commit', '-q', '-m', 'seed'], { cwd: seed });
  execFileSync('git', [...IDENTITY, 'push', '-q', remote, 'main'], { cwd: seed });
  const clone = join(dir, 'clone');
  execFileSync('git', ['clone', '-q', remote, clone]);
  return { remote, clone };
}

const pushBranch = (clone: string, name: string): void => {
  execFileSync('git', ['push', '-q', 'origin', `main:refs/heads/${name}`], { cwd: clone });
};

const heads = (remote: string): string =>
  execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });

test('reclaim releases a dead job claim: renamed aside, released branches untouched', async (t) => {
  const { remote, clone } = makeRepo();
  pushBranch(clone, 'fleet/APP-123-job-dead1');
  pushBranch(clone, 'fleet/APP-123-job-old0-attempt1'); // already released — not a claim
  const daemon = await startMockDaemon({
    'GET /jobs/job-dead1': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job: { id: 'job-dead1', state: 'cancelled', reason: 'harness-exit' } }));
    },
  });
  t.after(() => daemon.close());

  const result = await runCli(['reclaim', 'APP-123'], { cwd: clone, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /released fleet\/APP-123-job-dead1 -> fleet\/APP-123-job-dead1-attempt1/);

  const refs = heads(remote);
  assert.ok(!refs.includes('refs/heads/fleet/APP-123-job-dead1\n'), 'the claim is released');
  assert.ok(refs.includes('refs/heads/fleet/APP-123-job-dead1-attempt1'), 'the evidence is retained, not deleted');
  assert.ok(refs.includes('refs/heads/fleet/APP-123-job-old0-attempt1'), 'released branches stay as they were');
});

test('reclaim refuses while the claiming job is live', async (t) => {
  const { remote, clone } = makeRepo();
  pushBranch(clone, 'fleet/APP-123-job-live1');
  const daemon = await startMockDaemon({
    'GET /jobs/job-live1': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job: { id: 'job-live1', state: 'running' } }));
    },
  });
  t.after(() => daemon.close());

  const result = await runCli(['reclaim', 'APP-123'], { cwd: clone, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(result.code, 1, 'a live claim must not be releasable');
  assert.match(result.stderr, /job job-live1 is running — cancel it/);
  assert.ok(heads(remote).includes('refs/heads/fleet/APP-123-job-live1\n'), 'the live claim is untouched');
});

test('reclaim proceeds with a warning when the daemon holds no record (or is unreachable)', async () => {
  const { remote, clone } = makeRepo();
  pushBranch(clone, 'fleet/APP-123-job-lost1');
  // runCli scrubs FLEET_DAEMON_URL and points FLEET_HOME at a fresh dir, so
  // daemon resolution lands on a socket that does not exist — the operator's
  // escape hatch must still work when the record-keeper is gone.
  const result = await runCli(['reclaim', 'APP-123'], { cwd: clone });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /no record of job-lost1 \(or is unreachable\) — releasing on your authority/);
  const refs = heads(remote);
  assert.ok(refs.includes('refs/heads/fleet/APP-123-job-lost1-attempt1'), 'released despite the missing record');
});

test('a second reclaim of the same job picks the next free attempt suffix', async () => {
  const { remote, clone } = makeRepo();
  pushBranch(clone, 'fleet/APP-123-job-dead1');
  pushBranch(clone, 'fleet/APP-123-job-dead1-attempt1'); // an earlier release
  const result = await runCli(['reclaim', 'APP-123'], { cwd: clone });
  assert.equal(result.code, 0, result.stderr);
  const refs = heads(remote);
  assert.ok(refs.includes('refs/heads/fleet/APP-123-job-dead1-attempt2'), 'attempt 1 evidence is never overwritten');
  assert.ok(refs.includes('refs/heads/fleet/APP-123-job-dead1-attempt1'), 'the earlier release survives');
  assert.ok(!refs.includes('refs/heads/fleet/APP-123-job-dead1\n'), 'the claim is released');
});

test('reclaim with nothing to release says so and exits 0', async () => {
  const { clone } = makeRepo();
  pushBranch(clone, 'fleet/APP-123-job-old0-attempt1'); // released — not a claim
  const result = await runCli(['reclaim', 'APP-123'], { cwd: clone });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no claim branches for APP-123/);
});
