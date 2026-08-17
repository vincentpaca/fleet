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
import { FleetDaemon } from '../src/daemon/server.ts';
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
