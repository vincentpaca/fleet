/**
 * Daemon artifact endpoint tests: path-escape guard, cap enforcement,
 * list, and get via a real FleetDaemon over TCP.
 *
 * Exercises the `#safeArtifactPath` guard (the only barrier between a runner
 * token and arbitrary file writes) so a deletion of the `..` check would
 * cause a test failure. AGENTS.md: "New behavior ships with a test that fails
 * on a plausible bug — not a test that restates the implementation."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FleetDaemon } from '../src/daemon/server.ts';
import { artifactDir, ARTIFACT_TOTAL_CAP } from '../src/shared/home.ts';
import { MANIFEST, WORK_ORDER, StubProvider, tempHome } from './daemon-helpers.ts';

async function makeJob(daemon: FleetDaemon): Promise<{ jobId: string; token: string }> {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: MANIFEST, workOrder: WORK_ORDER }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, `job creation returned ${res.status}: ${text}`);
  const body = JSON.parse(text) as { job: { id: string } };
  const jobId = body.job.id;
  // registry.getJob returns the full JobRecord including runnerToken (the operator
  // HTTP endpoint strips it via publicJob(); the registry method does not).
  const record = daemon.registry.getJob(jobId);
  assert.ok(record);
  return { jobId, token: record.runnerToken };
}

async function postArtifact(
  port: number,
  jobId: string,
  token: string,
  path: string,
  content: string,
): Promise<Response> {
  const buf = Buffer.from(content);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return fetch(`http://127.0.0.1:${port}/internal/jobs/${encodeURIComponent(jobId)}/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-runner-token': token },
    body: JSON.stringify({ path, content: buf.toString('base64'), sha256, bytes: buf.length }),
  });
}

test('safe path: artifact stored, listed, and retrievable', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);

  const postRes = await postArtifact(daemon.port!, jobId, token, 'report.md', '# hello\n');
  assert.equal(postRes.status, 200);
  const postBody = await postRes.json() as { stored: boolean; path: string; bytes: number };
  assert.equal(postBody.stored, true);
  assert.equal(postBody.path, 'report.md');
  assert.equal(postBody.bytes, Buffer.byteLength('# hello\n'));

  // List returns the artifact.
  const listRes = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts`);
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as { artifacts: { path: string; bytes: number }[] };
  assert.equal(listed.artifacts.length, 1);
  assert.equal(listed.artifacts[0].path, 'report.md');

  // Get round-trips byte-identical content.
  const getRes = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts/report.md`);
  assert.equal(getRes.status, 200);
  const got = await getRes.json() as { content: string; sha256: string };
  assert.equal(Buffer.from(got.content, 'base64').toString(), '# hello\n');
  assert.equal(got.sha256, createHash('sha256').update('# hello\n').digest('hex'));
});

test('path traversal: .. segment rejected with 400', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);

  const traversalPaths = ['../escape', '../../etc/cron.d/x', 'ok/../bad', 'a/../../b'];
  for (const bad of traversalPaths) {
    const res = await postArtifact(daemon.port!, jobId, token, bad, 'x');
    assert.equal(res.status, 400, `expected 400 for path: ${bad}`);
    const body = await res.json() as { error: string };
    assert.match(body.error, /invalid artifact path/, `wrong error for "${bad}": ${body.error}`);
  }
});

test('absolute path rejected with 400', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);

  for (const bad of ['/etc/passwd', '/tmp/x']) {
    const res = await postArtifact(daemon.port!, jobId, token, bad, 'x');
    assert.equal(res.status, 400, `expected 400 for absolute path: ${bad}`);
  }
});

test('over per-file cap: rejected with 413', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);

  const overCapBytes = 10 * 1024 * 1024 + 1;
  const content = Buffer.alloc(overCapBytes, 'x');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const res = await fetch(`http://127.0.0.1:${daemon.port}/internal/jobs/${encodeURIComponent(jobId)}/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-runner-token': token },
    body: JSON.stringify({ path: 'huge.bin', content: content.toString('base64'), sha256, bytes: overCapBytes }),
  });
  assert.equal(res.status, 413);
  const body = await res.json() as { error: string };
  assert.match(body.error, /per-file cap/);
});

test('sha256 mismatch: rejected with 422', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);

  const content = 'hello';
  const wrongSha256 = 'deadbeef'.repeat(8); // 64 hex chars, wrong value
  const res = await fetch(`http://127.0.0.1:${daemon.port}/internal/jobs/${encodeURIComponent(jobId)}/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-runner-token': token },
    body: JSON.stringify({
      path: 'f.txt',
      content: Buffer.from(content).toString('base64'),
      sha256: wrongSha256,
      bytes: Buffer.byteLength(content),
    }),
  });
  assert.equal(res.status, 422);
  const body = await res.json() as { error: string };
  assert.match(body.error, /sha256 mismatch/);
});

test('get nonexistent artifact: 404', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId } = await makeJob(daemon);
  const res = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts/missing.txt`);
  assert.equal(res.status, 404);
});

test('nested path stored and retrieved correctly', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);

  const postRes = await postArtifact(daemon.port!, jobId, token, 'charts/fig1.png', 'fakepng');
  assert.equal(postRes.status, 200);

  const getRes = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts/charts/fig1.png`);
  assert.equal(getRes.status, 200);
  const got = await getRes.json() as { path: string; content: string };
  assert.equal(got.path, 'charts/fig1.png');
  assert.equal(Buffer.from(got.content, 'base64').toString(), 'fakepng');
});

// ---- #119: cap-walk cost, torn writes, crash-safety ----

test('upload cost: N uploads and list trigger at most one tree walk', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);
  const uploads = 12;
  for (let i = 0; i < uploads; i++) {
    const res = await postArtifact(daemon.port!, jobId, token, `file-${i}.txt`, `content ${i}`);
    assert.equal(res.status, 200);
  }
  for (let i = 0; i < 2; i++) {
    const listRes = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts`);
    assert.equal(listRes.status, 200);
    const listed = await listRes.json() as { artifacts: { path: string }[] };
    assert.equal(listed.artifacts.length, uploads);
  }
  // Before #119 the total-cap check walked the whole artifact tree (a statSync
  // per existing file) on every upload, and list walked again per request: this
  // sequence cost 14 walks and N(N+1)/2 stats. The bookkeeping walks once.
  assert.equal(daemon.artifactWalkCount(), 1);
});

test('torn write: a truncated artifact on disk is served as an error, not as valid', async (t) => {
  const home = tempHome();
  const daemon = new FleetDaemon({ home, provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);
  const postRes = await postArtifact(daemon.port!, jobId, token, 'data.bin', 'the full artifact content');
  assert.equal(postRes.status, 200);

  // Simulate a torn write: truncate the stored file directly on disk.
  truncateSync(join(artifactDir(home, jobId), 'data.bin'), 5);

  const getRes = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts/data.bin`);
  assert.equal(getRes.status, 500);
  const body = await getRes.json() as { error: string };
  assert.match(body.error, /sha256 mismatch/);
});

test('recorded sha survives a daemon restart: corruption still detected', async (t) => {
  const home = tempHome();
  const daemon1 = new FleetDaemon({ home, provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon1.start();
  const { jobId, token } = await makeJob(daemon1);
  const postRes = await postArtifact(daemon1.port!, jobId, token, 'report.md', 'original bytes');
  assert.equal(postRes.status, 200);
  await daemon1.stop();

  // Corrupt while no daemon is running, then boot a fresh one on the same home.
  writeFileSync(join(artifactDir(home, jobId), 'report.md'), 'tampered bytes!');
  const daemon2 = new FleetDaemon({ home, provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon2.start();
  t.after(() => daemon2.stop());

  const getRes = await fetch(`http://127.0.0.1:${daemon2.port}/jobs/${encodeURIComponent(jobId)}/artifacts/report.md`);
  assert.equal(getRes.status, 500);
  const body = await getRes.json() as { error: string };
  assert.match(body.error, /sha256 mismatch/);
});

test('crash leftover: an in-flight tmp file is not listed, not served, not uploadable', async (t) => {
  const home = tempHome();
  const daemon = new FleetDaemon({ home, provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);
  // A daemon that died mid-write leaves `<path>.fleet-tmp` behind. Plant one
  // before the first artifact operation so the bookkeeping load sees it.
  const artDir = artifactDir(home, jobId);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(join(artDir, 'ghost.md.fleet-tmp'), 'partial byt');

  const postRes = await postArtifact(daemon.port!, jobId, token, 'real.md', 'complete');
  assert.equal(postRes.status, 200);
  // The completed upload leaves no tmp file of its own behind.
  assert.equal(existsSync(join(artDir, 'real.md.fleet-tmp')), false);

  const listRes = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts`);
  const listed = await listRes.json() as { artifacts: { path: string }[] };
  assert.deepEqual(listed.artifacts.map((a) => a.path), ['real.md']);

  const getRes = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts/ghost.md.fleet-tmp`);
  assert.equal(getRes.status, 400);

  const upRes = await postArtifact(daemon.port!, jobId, token, 'x.fleet-tmp', 'y');
  assert.equal(upRes.status, 400);
  // Sanity: the leftover is still on disk (skipped, not silently deleted).
  assert.ok(readdirSync(artDir).includes('ghost.md.fleet-tmp'));
});

test('total cap counts pre-existing on-disk artifacts, not a trusted stale number', async (t) => {
  const home = tempHome();
  const daemon = new FleetDaemon({ home, provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);
  // A sparse file at exactly the cap: statSync reports the logical size
  // without writing 100MB. The bookkeeping must count it from disk.
  const artDir = artifactDir(home, jobId);
  mkdirSync(artDir, { recursive: true });
  const big = join(artDir, 'big.bin');
  closeSync(openSync(big, 'w'));
  truncateSync(big, ARTIFACT_TOTAL_CAP);

  const res = await postArtifact(daemon.port!, jobId, token, 'small.txt', 'x');
  assert.equal(res.status, 413);
  const body = await res.json() as { error: string };
  assert.match(body.error, /total artifact cap/);
});

test('overwrite replaces the entry: charged the delta, listed once', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId, token } = await makeJob(daemon);
  assert.equal((await postArtifact(daemon.port!, jobId, token, 'a.txt', 'five!')).status, 200);
  assert.equal((await postArtifact(daemon.port!, jobId, token, 'a.txt', 'two')).status, 200);

  const listRes = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts`);
  const listed = await listRes.json() as { artifacts: { path: string; bytes: number }[] };
  assert.deepEqual(listed.artifacts, [{ path: 'a.txt', bytes: 3 }]);

  // The replacement content is what round-trips.
  const getRes = await fetch(`http://127.0.0.1:${daemon.port}/jobs/${encodeURIComponent(jobId)}/artifacts/a.txt`);
  assert.equal(getRes.status, 200);
  const got = await getRes.json() as { content: string };
  assert.equal(Buffer.from(got.content, 'base64').toString(), 'two');
});

test('wrong runner token: 401', async (t) => {
  const daemon = new FleetDaemon({ home: tempHome(), provider: new StubProvider(), port: 0, longPollMs: 500 });
  await daemon.start();
  t.after(() => daemon.stop());

  const { jobId } = await makeJob(daemon);
  const res = await fetch(`http://127.0.0.1:${daemon.port}/internal/jobs/${encodeURIComponent(jobId)}/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-runner-token': 'wrong-token' },
    body: JSON.stringify({ path: 'f.txt', content: 'aGVsbG8=', sha256: 'x'.repeat(64), bytes: 5 }),
  });
  assert.equal(res.status, 401);
});
