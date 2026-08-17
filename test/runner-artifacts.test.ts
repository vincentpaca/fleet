/**
 * Unit tests for src/runner/artifacts.ts: cap enforcement, sha256 computation,
 * and daemon upload mechanics using a tiny in-test HTTP server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectArtifacts, ARTIFACT_PER_FILE_CAP } from '../src/runner/artifacts.ts';

type ReceivedPost = { path: string; sha256: string; bytes: number; content: string };

/** Start a minimal artifact-endpoint HTTP server; returns url, captured posts, and close(). */
async function startArtifactServer(opts: { rejectAll?: boolean } = {}): Promise<{
  url: string;
  posts: ReceivedPost[];
  close: () => Promise<void>;
}> {
  const posts: ReceivedPost[] = [];
  const server = createServer(async (req, res) => {
    if (opts.rejectAll) {
      res.writeHead(413).end(JSON.stringify({ error: 'cap exceeded' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ReceivedPost;
    posts.push(body);
    res.writeHead(200).end(JSON.stringify({ stored: true }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    posts,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-art-'));
  mkdirSync(join(workspace, '.fleet', 'out', 'artifacts'), { recursive: true });
  return workspace;
}

test('no artifacts dir → empty result', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-art-nodir-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  try {
    const { produced, notes } = await collectArtifacts({
      workspace,
      jobId: 'job-a1',
      daemonUrl: 'http://127.0.0.1:1',  // should never be reached
      token: 'tok',
    });
    assert.deepEqual(produced, []);
    assert.deepEqual(notes, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('two artifact files → uploaded with correct sha256/bytes', async () => {
  const server = await startArtifactServer();
  const workspace = makeWorkspace();
  try {
    const content1 = '# Report\n\nAll good.\n';
    const content2 = 'col1,col2\n1,2\n';
    writeFileSync(join(workspace, '.fleet', 'out', 'artifacts', 'report.md'), content1);
    writeFileSync(join(workspace, '.fleet', 'out', 'artifacts', 'data.csv'), content2);

    const { produced, notes } = await collectArtifacts({
      workspace,
      jobId: 'job-a2',
      daemonUrl: server.url,
      token: 'tok',
    });

    assert.deepEqual(notes, []);
    assert.equal(produced.length, 2);

    // Sort for stable comparison (walkDir order may vary by OS)
    produced.sort((a, b) => a.path.localeCompare(b.path));

    const csv = produced.find((p) => p.path === 'data.csv');
    assert.ok(csv, 'data.csv entry present');
    assert.equal(csv.type, 'file');
    assert.equal(csv.bytes, Buffer.byteLength(content2));
    assert.equal(csv.sha256, createHash('sha256').update(content2).digest('hex'));

    const md = produced.find((p) => p.path === 'report.md');
    assert.ok(md, 'report.md entry present');
    assert.equal(md.bytes, Buffer.byteLength(content1));

    // Verify the daemon received both uploads with matching sha256.
    assert.equal(server.posts.length, 2);
    const csvPost = server.posts.find((p) => p.path === 'data.csv');
    assert.ok(csvPost);
    assert.equal(csvPost.sha256, csv.sha256);
    assert.equal(Buffer.from(csvPost.content, 'base64').toString(), content2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await server.close();
  }
});

test('over-cap file → noted and skipped, other files still delivered', async () => {
  const server = await startArtifactServer();
  const workspace = makeWorkspace();
  try {
    // Normal file
    writeFileSync(join(workspace, '.fleet', 'out', 'artifacts', 'small.txt'), 'small');
    // Simulate an over-cap file by writing a stub and faking its size via a
    // wrapper: we can't actually write 10MB in a unit test easily, so we'll
    // test the cap logic by using ARTIFACT_PER_FILE_CAP value directly.
    // Instead: write a real over-cap-sized file to exercise the real code path.
    // 10MB + 1 byte triggers the per-file cap.
    const overCapSize = ARTIFACT_PER_FILE_CAP + 1;
    // Writing 10MB in a test is fine for correctness but slow; use a Buffer.
    writeFileSync(join(workspace, '.fleet', 'out', 'artifacts', 'big.bin'), Buffer.alloc(overCapSize));

    const { produced, notes } = await collectArtifacts({
      workspace,
      jobId: 'job-a3',
      daemonUrl: server.url,
      token: 'tok',
    });

    assert.equal(notes.length, 1);
    assert.match(notes[0], /big\.bin/);
    assert.match(notes[0], /per-file cap/);

    assert.equal(produced.length, 1);
    assert.equal(produced[0].path, 'small.txt');

    // Only the small file was uploaded.
    assert.equal(server.posts.length, 1);
    assert.equal(server.posts[0].path, 'small.txt');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await server.close();
  }
});

test('upload failure → noted and skipped, settle proceeds', async () => {
  const server = await startArtifactServer({ rejectAll: true });
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, '.fleet', 'out', 'artifacts', 'fails.txt'), 'data');

    const { produced, notes } = await collectArtifacts({
      workspace,
      jobId: 'job-a4',
      daemonUrl: server.url,
      token: 'tok',
    });

    assert.equal(produced.length, 0);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /fails\.txt/);
    assert.match(notes[0], /upload failed/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await server.close();
  }
});

test('nested artifact subdirectory → path includes subdir', async () => {
  const server = await startArtifactServer();
  const workspace = makeWorkspace();
  try {
    mkdirSync(join(workspace, '.fleet', 'out', 'artifacts', 'charts'), { recursive: true });
    writeFileSync(join(workspace, '.fleet', 'out', 'artifacts', 'charts', 'fig1.png'), 'fakepng');

    const { produced, notes } = await collectArtifacts({
      workspace,
      jobId: 'job-a5',
      daemonUrl: server.url,
      token: 'tok',
    });

    assert.deepEqual(notes, []);
    assert.equal(produced.length, 1);
    assert.equal(produced[0].path, 'charts/fig1.png');
    assert.equal(produced[0].type, 'file');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await server.close();
  }
});
