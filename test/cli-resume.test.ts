// fleet resume: reconnect a checkout to its in-flight work via local pointers.
// Covers: dispatched.jsonl written by delegate, daemon resolution via
// fleet-config.json, resume output ordering, --answer drop-through, and the
// daemon-unreachable / unknown-to-daemon error paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { runCli, makeTempDir, startMockDaemon, sendJson, sendNdjson, type MockRequest } from './cli-helpers.ts';

// ── Minimal manifest used in all tests ───────────────────────────────────────

const MINIMAL_MANIFEST = {
  version: 1,
  setup: { image: 'node:22' },
  workspace: { repo: 'git@github.com:example/app.git', strategy: 'branch-per-job' },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'true', default_finish: 'merge-ready' },
};

function scaffold(manifest: unknown = MINIMAL_MANIFEST): string {
  const cwd = makeTempDir('fleet-cli-resume-');
  fs.mkdirSync(path.join(cwd, '.fleet'));
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), JSON.stringify(manifest));
  return cwd;
}

// ── Ledger write on delegate ──────────────────────────────────────────────────

test('delegate writes a pointer entry to .fleet/dispatched.jsonl', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'POST /jobs': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 201, { job: { id: 'job-res-1', state: 'queued' } }),
  });
  t.after(daemon.close);

  const res = await runCli(['delegate', '42'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);

  const ledgerPath = path.join(cwd, '.fleet', 'dispatched.jsonl');
  assert.ok(fs.existsSync(ledgerPath), 'dispatched.jsonl created');
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one entry');
  const entry = JSON.parse(lines[0]) as Record<string, string>;
  assert.equal(entry.jobId, 'job-res-1');
  assert.equal(entry.target, '42');
  assert.equal(entry.finish, 'merge-ready', 'the finish rung replaced mode in the pointer (#36)');
  assert.equal(entry.mode, undefined, 'and mode is no longer written');
  assert.ok(typeof entry.daemonUrl === 'string' && entry.daemonUrl !== '', 'daemonUrl is a non-empty string');
  assert.ok(typeof entry.at === 'string' && entry.at !== '', 'at is a non-empty string');
  // Pointer only: no status fields.
  assert.equal(entry.state, undefined, 'state must not be stored in the ledger');
  assert.equal(entry.marker, undefined, 'marker must not be stored in the ledger');
});

test('delegate twice → dispatched.jsonl has exactly two pointer lines', async (t) => {
  const cwd = scaffold();
  let jobCounter = 0;
  const daemon = await startMockDaemon({
    'POST /jobs': (_req: MockRequest, res: ServerResponse) => {
      jobCounter += 1;
      sendJson(res, 201, { job: { id: `job-res-${jobCounter}`, state: 'queued' } });
    },
  });
  t.after(daemon.close);

  await runCli(['delegate', '10'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  await runCli(['delegate', '11'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });

  const ledgerPath = path.join(cwd, '.fleet', 'dispatched.jsonl');
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'two entries after two delegates');
  const [e1, e2] = lines.map((l) => JSON.parse(l) as { jobId: string; target: string });
  assert.equal(e1.jobId, 'job-res-1');
  assert.equal(e1.target, '10');
  assert.equal(e2.jobId, 'job-res-2');
  assert.equal(e2.target, '11');
});

// ── Daemon endpoint resolution via fleet-config.json ─────────────────────────

test('daemon resolved via fleet-config.json when FLEET_DAEMON_URL is absent', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'GET /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 200, { jobs: [] }),
  });
  t.after(daemon.close);

  // Write fleet-config.json with daemon_url pointing at the mock daemon.
  const infraDir = path.join(cwd, '.fleet', 'infra', 'aws');
  fs.mkdirSync(infraDir, { recursive: true });
  fs.writeFileSync(path.join(infraDir, 'fleet-config.json'), JSON.stringify({ daemon_url: daemon.url }));

  // Run fleet status without FLEET_DAEMON_URL — should pick up the config.
  const res = await runCli(['status'], { cwd, env: { FLEET_DAEMON_URL: undefined } });
  assert.equal(res.code, 0, `expected 0 but got ${res.code}: ${res.stderr}`);
  // daemon received the request, so resolution worked.
  assert.equal(daemon.requests.length, 1, 'request reached daemon via fleet-config.json');
});

// ── fleet resume output ordering ─────────────────────────────────────────────

/**
 * Seed the ledger in its PRE-#36 shape, carrying `mode` and no `finish`. Left
 * that way deliberately: `fleet resume` reads a ledger it did not write, and
 * every existing checkout's `dispatched.jsonl` looks like this.
 */
function seedLedger(cwd: string, entries: Array<{ jobId: string; target: string; mode?: string; daemonUrl: string }>): void {
  const ledgerPath = path.join(cwd, '.fleet', 'dispatched.jsonl');
  const lines = entries.map((e) =>
    JSON.stringify({ jobId: e.jobId, target: e.target, mode: e.mode ?? 'implement', daemonUrl: e.daemonUrl, at: '2026-01-01T00:00:00Z' }),
  );
  fs.writeFileSync(ledgerPath, lines.join('\n') + '\n');
}

test('resume: blocked job shown first with its decision rendered', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'GET /jobs/job-blk': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { job: { id: 'job-blk', state: 'blocked', workOrder: { mode: 'implement', target: '5' } } }),
    'GET /jobs/job-blk/events': (_req: MockRequest, res: ServerResponse) =>
      sendNdjson(res, [
        { seq: 0, type: 'state', state: 'blocked' },
        {
          seq: 1, type: 'decision', id: 'd1',
          question: 'Which DB engine?',
          options: [
            { id: 'pg', label: 'PostgreSQL', recommended: true },
            { id: 'sqlite', label: 'SQLite' },
          ],
        },
      ]),
    'GET /jobs/job-run': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { job: { id: 'job-run', state: 'running', workOrder: { mode: 'assess', target: '6' } } }),
  });
  t.after(daemon.close);

  seedLedger(cwd, [
    { jobId: 'job-run', target: '6', daemonUrl: daemon.url },
    { jobId: 'job-blk', target: '5', daemonUrl: daemon.url },
  ]);

  const res = await runCli(['resume'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);

  const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
  // Blocked job must appear before running.
  const blkIdx = lines.findIndex((l) => l.includes('job-blk'));
  const runIdx = lines.findIndex((l) => l.includes('job-run'));
  assert.ok(blkIdx !== -1, 'blocked job in output');
  assert.ok(runIdx !== -1, 'running job in output');
  assert.ok(blkIdx < runIdx, 'blocked before running');

  // Decision rendered below the blocked job.
  const decIdx = lines.findIndex((l) => l.includes('Which DB engine?'));
  assert.ok(decIdx !== -1, 'decision question rendered');
  assert.ok(decIdx > blkIdx, 'decision follows blocked job line');

  // Options present.
  assert.ok(lines.some((l) => l.includes('pg') && l.includes('recommended')), 'recommended option shown');
  assert.ok(lines.some((l) => l.includes('sqlite')), 'other option shown');
});

test('resume: stale-blocked shown before hot-blocked', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'GET /jobs/job-stale': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { job: { id: 'job-stale', state: 'blocked', marker: 'stale', workOrder: { mode: 'implement', target: '7' } } }),
    'GET /jobs/job-stale/events': (_req: MockRequest, res: ServerResponse) => sendNdjson(res, []),
    'GET /jobs/job-hot': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { job: { id: 'job-hot', state: 'blocked', workOrder: { mode: 'implement', target: '8' } } }),
    'GET /jobs/job-hot/events': (_req: MockRequest, res: ServerResponse) => sendNdjson(res, []),
  });
  t.after(daemon.close);

  seedLedger(cwd, [
    { jobId: 'job-hot', target: '8', daemonUrl: daemon.url },
    { jobId: 'job-stale', target: '7', daemonUrl: daemon.url },
  ]);

  const res = await runCli(['resume'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split('\n');
  const staleIdx = lines.findIndex((l) => l.includes('job-stale'));
  const hotIdx = lines.findIndex((l) => l.includes('job-hot'));
  assert.ok(staleIdx < hotIdx, 'stale appears before hot-blocked');
});

test('resume: unknown-to-daemon entries reported, not silently dropped', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'GET /jobs/job-gone': (_req: MockRequest, res: ServerResponse) => sendJson(res, 404, { error: 'not found' }),
  });
  t.after(daemon.close);

  seedLedger(cwd, [{ jobId: 'job-gone', target: '9', daemonUrl: daemon.url }]);

  const res = await runCli(['resume'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /job-gone/, 'unknown job appears in output');
  assert.match(res.stdout, /unknown to daemon/, 'labeled as unknown to daemon');
  assert.match(res.stdout, /daemon=/, 'daemon endpoint included in unknown-to-daemon line');
});

test('resume: non-200 non-404 daemon response is reported, job not silently dropped', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'GET /jobs/job-err': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 500, { error: 'internal server error' }),
  });
  t.after(daemon.close);

  seedLedger(cwd, [{ jobId: 'job-err', target: '12', daemonUrl: daemon.url }]);

  const res = await runCli(['resume'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /job-err/, 'errored job appears in output, not silently dropped');
  // Error reason surfaced in the output line.
  assert.ok(
    res.stdout.includes('error:') || res.stdout.includes('internal server error'),
    `error info in stdout: ${res.stdout}`,
  );
});

test('resume: exits 1 naming the endpoint when daemon is unreachable', async (t) => {
  const cwd = scaffold();
  seedLedger(cwd, [{ jobId: 'job-x', target: '1', daemonUrl: 'http://127.0.0.1:9' }]);

  const res = await runCli(['resume'], { cwd, env: { FLEET_DAEMON_URL: 'http://127.0.0.1:9' } });
  assert.equal(res.code, 1, 'should exit 1');
  assert.match(res.stderr, /cannot reach daemon at http:\/\/127\.0\.0\.1:9/, 'names the endpoint tried');
  assert.equal(res.stdout, '', 'no cached output printed to stdout');
});

test('resume with no ledger file: friendly empty-state message', async (t) => {
  const cwd = scaffold();
  const res = await runCli(['resume'], { cwd, env: { FLEET_DAEMON_URL: 'http://127.0.0.1:9' } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /no dispatched jobs/);
});

// ── resume --answer with fleet-config.json fixture ───────────────────────────

test('resume --answer via fleet-config.json: posts answer and follows to done', async (t) => {
  const cwd = scaffold();
  let phase: 'decision' | 'answered' = 'decision';
  const answers: unknown[] = [];

  // Build a mock daemon that mimics a real blocked→answered→done cycle.
  const daemon = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/jobs/job-ans') {
      sendJson(res, 200, { job: { id: 'job-ans', state: 'blocked', workOrder: { mode: 'implement', target: '20' } } });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/jobs/job-ans/events') {
      const after = Number(url.searchParams.get('after') ?? '-1');
      const follow = url.searchParams.get('follow') === '1';
      res.setHeader('content-type', 'application/x-ndjson');

      if (!follow) {
        // Plain events fetch (for decision lookup during resume list).
        res.end(JSON.stringify({ seq: 0, type: 'decision', id: 'd1', question: 'Merge strategy?', options: [{ id: 'squash', label: 'Squash', recommended: true }, { id: 'rebase', label: 'Rebase' }] }) + '\n');
        return;
      }

      if (phase === 'decision' && after < 1) {
        res.end([
          JSON.stringify({ seq: 0, type: 'state', state: 'blocked' }),
          JSON.stringify({ seq: 1, type: 'decision', id: 'd1', question: 'Merge strategy?', options: [{ id: 'squash', label: 'Squash', recommended: true }, { id: 'rebase', label: 'Rebase' }] }),
        ].join('\n') + '\n');
      } else if (phase === 'answered') {
        res.end([
          JSON.stringify({ seq: 2, type: 'answer', decision: 'd1', option: 'squash', by: 'operator' }),
          JSON.stringify({ seq: 3, type: 'settle', rung: 'merge-ready', report: { status: 'READY' } }),
          JSON.stringify({ seq: 4, type: 'state', state: 'done' }),
        ].join('\n') + '\n');
      } else {
        res.end('');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/jobs/job-ans/answer') {
      let body = '';
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        answers.push(JSON.parse(body));
        phase = 'answered';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    (res as ServerResponse).statusCode = 404;
    res.end();
  });

  daemon.listen(0, '127.0.0.1');
  await once(daemon, 'listening');
  t.after(() => {
    const closed = Promise.withResolvers<void>();
    daemon.close(() => closed.resolve());
    return closed.promise;
  });

  const addr = daemon.address();
  assert.ok(addr && typeof addr === 'object');
  const daemonUrl = `http://127.0.0.1:${addr.port}`;

  // Write fleet-config.json — this is how the test simulates a fresh shell with no FLEET_DAEMON_URL.
  const infraDir = path.join(cwd, '.fleet', 'infra', 'aws');
  fs.mkdirSync(infraDir, { recursive: true });
  fs.writeFileSync(path.join(infraDir, 'fleet-config.json'), JSON.stringify({ daemon_url: daemonUrl }));

  // Seed ledger (as if delegate was called earlier).
  seedLedger(cwd, [{ jobId: 'job-ans', target: '20', daemonUrl }]);

  const { CLI } = await import('./cli-helpers.ts');
  const child = spawn(process.execPath, [CLI, 'resume', '--answer'], {
    cwd,
    // No FLEET_DAEMON_URL — must resolve via fleet-config.json. FLEET_HOME is
    // pinned to a temp dir: the first-seen daemon_url record (#135) lives there,
    // and a test must never touch ~/.fleet.
    env: Object.fromEntries(
      Object.entries({ ...process.env, FLEET_DAEMON_URL: undefined, FLEET_HOME: makeTempDir('fleet-resume-home-') })
        .filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr.on('data', (c: Buffer) => (err += c.toString()));

  child.stderr.on('data', () => {
    if (err.includes('answer [squash | rebase]') && !child.stdin.destroyed) {
      child.stdin.write('squash\n');
      child.stdin.end();
    }
  });

  const [code] = (await once(child, 'exit')) as [number];
  assert.equal(code, 0, `exit ${code}; stderr:\n${err}\nstdout:\n${out}`);
  assert.deepStrictEqual(answers, [{ option: 'squash' }], 'answer posted with correct option');
  assert.match(out, /Merge strategy\?/, 'decision question shown');
  assert.match(out, /squash.*recommended/, 'recommended option shown');
  assert.match(out, /state → done/, 'followed to done');
});

// ── Ledger pruning and bounded fetch time (#125) ─────────────────────────────

test('resume prunes confirmed-terminal entries from the ledger; live and unknown entries stay', async (t) => {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'GET /jobs/job-done': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { job: { id: 'job-done', state: 'done', workOrder: { mode: 'implement', target: '1' } } }),
    'GET /jobs/job-live': (_req: MockRequest, res: ServerResponse) =>
      sendJson(res, 200, { job: { id: 'job-live', state: 'running', workOrder: { mode: 'implement', target: '2' } } }),
    'GET /jobs/job-gone': (_req: MockRequest, res: ServerResponse) => sendJson(res, 404, { error: 'not found' }),
  });
  t.after(daemon.close);

  seedLedger(cwd, [
    { jobId: 'job-done', target: '1', daemonUrl: daemon.url },
    { jobId: 'job-live', target: '2', daemonUrl: daemon.url },
    { jobId: 'job-gone', target: '3', daemonUrl: daemon.url },
  ]);

  const res = await runCli(['resume'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /job-done/, 'the settled job still appears in this run\'s summary');
  assert.match(res.stdout, /pruned 1 settled job/, 'the prune is reported');

  // The ledger is append-only at dispatch and nothing else prunes it: without
  // this rewrite, resume pays one round trip per job ever dispatched.
  const ledger = fs.readFileSync(path.join(cwd, '.fleet', 'dispatched.jsonl'), 'utf8');
  const ids = ledger.trim().split('\n').map((l) => (JSON.parse(l) as { jobId: string }).jobId);
  assert.deepEqual(ids, ['job-live', 'job-gone'], 'terminal entry gone; live and unknown kept, in ledger order');

  // A second resume no longer asks the daemon about the pruned job at all.
  const before = daemon.requests.length;
  const again = await runCli(['resume'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(again.code, 0, again.stderr);
  const asked = daemon.requests.slice(before).map((r) => r.url);
  assert.ok(!asked.some((u) => u.includes('job-done')), 'resume time is bounded by live jobs, not dispatch history');
});

test('resume fetches ledger entries concurrently, not one round trip at a time', async (t) => {
  // Structural, not stopwatch: each job GET is held open until answered, and
  // the daemon records how many were in flight at once. A serial resume never
  // has two open together, however fast or slow the machine is.
  let inFlight = 0;
  let maxInFlight = 0;
  const routes: Record<string, (req: MockRequest, res: ServerResponse) => void> = {};
  const jobIds = Array.from({ length: 6 }, (_, i) => `job-par-${i}`);
  for (const id of jobIds) {
    routes[`GET /jobs/${id}`] = (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        sendJson(res, 200, { job: { id, state: 'running', workOrder: { mode: 'implement', target: '1' } } });
      }, 150);
    };
  }
  const daemon = await startMockDaemon(routes);
  t.after(daemon.close);

  const cwd = scaffold();
  seedLedger(cwd, jobIds.map((jobId) => ({ jobId, target: '1', daemonUrl: daemon.url })));

  const res = await runCli(['resume'], { cwd, env: { FLEET_DAEMON_URL: daemon.url } });
  assert.equal(res.code, 0, res.stderr);
  for (const id of jobIds) assert.match(res.stdout, new RegExp(id));
  assert.ok(maxInFlight > 1, `never more than ${maxInFlight} fetch in flight — that is serial, not parallel`);
});
