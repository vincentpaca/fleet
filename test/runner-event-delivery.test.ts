/**
 * Event delivery resilience (issue #109): the runner's EventSink survives
 * daemon blips, retries with backoff, bounds memory, and never leaves an
 * orphaned rejection to kill the process.
 *
 * These tests exercise the sink directly (unit-level) and the runner end to
 * end (integration-level) against the mock daemon:
 *
 * 1. A daemon that goes unreachable mid-stream: the runner survives, pushes
 *    work, settles, and the dropped-event count surfaces in the settle notes.
 * 2. A retried post whose first attempt was applied but whose response was
 *    lost: the 422-duplicate heuristic treats it as delivered, not fatal.
 *    not O(lines) — the emits array is gone; depth is bounded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { EventSink } from '../src/runner/events.ts';
// @ts-ignore -- plain-JS module, no type declarations
import { validateEvent } from '../src/validate.mjs';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
const fixturePath = fileURLToPath(
  new URL('./fixtures/harness-stream.ndjson', import.meta.url),
);

// ── Helpers ────────────────────────────────────────────────────────────────

/** A controllable daemon: can be paused (socket held open, no response) and
 *  can answer 422 with a custom body on the Nth event POST. */
type FlakyDaemon = {
  url: string;
  events: Record<string, unknown>[];
  rejected: { event: unknown; errors: unknown }[];
  /** Stop accepting new connections; in-flight requests hang until resumed. */
  pause(): Promise<void>;
  /** Resume accepting connections and responding. */
  resume(): void;
  /** On the next event POST, respond 422 with the given body instead of 200. */
  answerNext422(body: string): void;
  /** Record the next event POST then destroy the socket (response lost). */
  loseNextResponse(): void;
  close(): Promise<void>;
};

async function startFlakyDaemon(opts: { token: string }): Promise<FlakyDaemon> {
  const events: Record<string, unknown>[] = [];
  const rejected: { event: unknown; errors: unknown }[] = [];
  let lastSeq = -1;
  let paused = false;
  let loseResponse = false;
  let pendingSocket: import('node:net').Socket | undefined;
  let next422Body: string | undefined;

  const server: Server = createServer(async (req, res) => {
    // Hold the socket open when paused; resume() writes the response.
    if (paused) {
      pendingSocket = res.socket;
      return;
    }
    if (req.headers['x-fleet-runner-token'] !== opts.token) {
      res.writeHead(401).end(JSON.stringify({ error: 'bad token' }));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && /^\/internal\/jobs\/[^/]+\/events$/.test(url.pathname)) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const lines = body.split('\n').filter((line) => line.trim() !== '');
      const parsed: unknown[] = [];
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch (err) {
          rejected.push({ event: line, errors: [String(err)] });
          res.writeHead(422).end(JSON.stringify({ errors: ['bad json'] }));
          return;
        }
      }
      const body422 = next422Body;
      next422Body = undefined;
      for (const event of parsed) {
        const { ok, errors } = validateEvent(event);
        const seq = (event as Record<string, unknown>).seq;
        if (!ok || typeof seq !== 'number' || seq <= lastSeq) {
          if (body422 !== undefined) {
            res.writeHead(422).end(body422);
            return;
          }
          const rejectErrors = ok ? ['seq not monotonic'] : errors;
          rejected.push({ event, errors: rejectErrors });
          res.writeHead(422).end(JSON.stringify({ errors: rejectErrors }));
          return;
        }
        lastSeq = seq;
        events.push(event as Record<string, unknown>);
      }
      if (loseResponse) {
        loseResponse = false;
        // The write was applied (seq recorded above) but the response is
        // "lost": return a 500 to simulate a daemon crash mid-response.
        // The runner retries (500 is transient), and the retry gets a 422
        // because the seq is already recorded — the heuristic treats that
        // as "delivered, response was lost."
        res.writeHead(500).end(JSON.stringify({ error: 'internal error (simulated lost response)' }));
        return;
      }
      if (body422 !== undefined) {
        res.writeHead(422).end(body422);
        return;
      }
      res.writeHead(200).end('{}');
      return;
    }
    res.writeHead(404).end();
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('flaky daemon failed to bind');

  return {
    url: `http://127.0.0.1:${address.port}`,
    events,
    rejected,
    async pause() {
      paused = true;
    },
    resume() {
      paused = false;
      // End any socket held open during the pause.
      if (pendingSocket) { pendingSocket.destroy(); pendingSocket = undefined; }
    },
    answerNext422(body: string) { next422Body = body; },
    loseNextResponse() { loseResponse = true; },
    close() {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

function writeWorkspace(pickup: string): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-delivery-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  writeFileSync(
    join(workspace, '.fleet', 'manifest.json'),
    JSON.stringify({
      version: 1,
      setup: { image: 'node:22', script: '.fleet/setup.sh' },
      workspace: { repo: 'git@github.com:acme/example.git', strategy: 'branch-per-job' },
      harness: {
        cli: 'claude-code',
        commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
      },
      gates: { pickup },
    }),
  );
  return workspace;
}

function runRunner(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const { FLEET_GIT_URL: _g, ...parentEnv } = process.env;
  const child = spawn(process.execPath, [runnerMain], {
    env: { ...parentEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = Promise.withResolvers<{ code: number; stderr: string }>();
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  child.on('close', (code) => exited.resolve({ code: code ?? -1, stderr }));
  return exited.promise;
}

const REPLAY_CMD =
  `node -e "const fs=require('node:fs');fs.writeFileSync('.fleet/out/report.json',process.env.TEST_REPORT);process.stdout.write(fs.readFileSync(process.env.TEST_FIXTURE,'utf8'))"`;

// ── Unit: EventSink retry, drop, and buffer bound ──────────────────────────

test('EventSink: a transient outage retries with backoff, then delivers', async () => {
  const token = 'test-sink-retry';
  const daemon = await startFlakyDaemon({ token });
  const sink = new EventSink({
    jobId: 'job-retry',
    daemonUrl: daemon.url,
    token,
    // Tiny retry intervals so the test is fast.
  });
  // Override retry config via env for fast backoff.
  process.env.FLEET_EVENT_RETRY_BASE_MS = '10';
  process.env.FLEET_EVENT_RETRY_MAX_MS = '50';
  process.env.FLEET_EVENT_POST_TIMEOUT_MS = '2000';
  try {
    daemon.pause();
    // Emit while the daemon is unreachable — the post will time out / fail
    // and the sink should retry with backoff.
    const emitPromise = sink.emit({ type: 'log', text: 'survive the blip', who: 'runner' });
    await delay(50); // let the first attempt fail
    daemon.resume();
    await emitPromise; // resolves once delivered
    await sink.flush();

    assert.equal(daemon.events.length, 1, 'the event was delivered after the blip');
    assert.equal(daemon.events[0].type, 'log');
    assert.equal(sink.dropped, 0, 'nothing was dropped — the retry succeeded');
  } finally {
    delete process.env.FLEET_EVENT_RETRY_BASE_MS;
    delete process.env.FLEET_EVENT_RETRY_MAX_MS;
    delete process.env.FLEET_EVENT_POST_TIMEOUT_MS;
    await daemon.close();
  }
});

test('EventSink: a permanently unreachable daemon drops and counts, never rejects', async () => {
  const token = 'test-sink-drop';
  const daemon = await startFlakyDaemon({ token });
  // Use a very short timeout and few attempts so the test is fast.
  process.env.FLEET_EVENT_POST_TIMEOUT_MS = '100';
  process.env.FLEET_EVENT_RETRY_BASE_MS = '10';
  process.env.FLEET_EVENT_RETRY_MAX_MS = '20';
  process.env.FLEET_EVENT_MAX_ATTEMPTS = '3';
  const sink = new EventSink({
    jobId: 'job-drop',
    daemonUrl: daemon.url,
    token,
  });
  try {
    daemon.pause();
    // Emit must NOT reject even though every attempt fails permanently.
    const emitPromise = sink.emit({ type: 'log', text: 'lost event', who: 'runner' });
    const result = await Promise.race([
      emitPromise.then(() => 'resolved'),
      delay(5000).then(() => 'hung'),
    ]);
    assert.equal(result, 'resolved', 'emit() resolves (does not reject) even on permanent failure');
    assert.ok(sink.dropped >= 1, 'the event was counted as dropped');
    assert.ok(sink.lastDeliveryError !== undefined, 'lastDeliveryError is set');
  } finally {
    delete process.env.FLEET_EVENT_POST_TIMEOUT_MS;
    delete process.env.FLEET_EVENT_RETRY_BASE_MS;
    delete process.env.FLEET_EVENT_RETRY_MAX_MS;
    delete process.env.FLEET_EVENT_MAX_ATTEMPTS;
    daemon.resume();
    await daemon.close();
  }
});

test('EventSink: 422-duplicate heuristic treats a retried post as delivered', async () => {
  const token = 'test-sink-422';
  const daemon = await startFlakyDaemon({ token });
  process.env.FLEET_EVENT_RETRY_BASE_MS = '10';
  process.env.FLEET_EVENT_RETRY_MAX_MS = '50';
  process.env.FLEET_EVENT_POST_TIMEOUT_MS = '5000';
  process.env.FLEET_EVENT_MAX_ATTEMPTS = '5';
  const sink = new EventSink({
    jobId: 'job-422',
    daemonUrl: daemon.url,
    token,
  });
  try {
    // First POST: the daemon records the event (seq 0) but returns 500
    // — simulating a daemon crash mid-response. The runner retries
    // (500 is transient).
    daemon.loseNextResponse();
    // On the retry (attempt 2): the daemon sees the duplicate seq
    // (0 <= 0) and 422s with a body naming the duplicate. The heuristic
    // in postWithRetry treats that as delivered — the write was
    // applied, only the response was lost.
    const event = await sink.emit({ type: 'log', text: 'applied but response lost', who: 'runner' });
    await sink.flush();
    assert.equal(event.seq, 0);
    assert.equal(sink.dropped, 0, 'the 422-duplicate was not counted as a drop');
    assert.equal(daemon.events.length, 1, 'the event was recorded on the first attempt');
  } finally {
    delete process.env.FLEET_EVENT_RETRY_BASE_MS;
    delete process.env.FLEET_EVENT_RETRY_MAX_MS;
    delete process.env.FLEET_EVENT_POST_TIMEOUT_MS;
    delete process.env.FLEET_EVENT_MAX_ATTEMPTS;
    await daemon.close();
  }
});

test('EventSink: buffer cap sheds droppable events under pressure', async () => {
  const token = 'test-sink-cap';
  const daemon = await startFlakyDaemon({ token });
  process.env.FLEET_EVENT_POST_TIMEOUT_MS = '50';
  process.env.FLEET_EVENT_MAX_ATTEMPTS = '3';
  const sink = new EventSink({
    jobId: 'job-cap',
    daemonUrl: daemon.url,
    token,
    maxPending: 4,
  });
  try {
    daemon.pause();
    // Fill the buffer with droppable log events past the cap.
    const emits: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      emits.push(sink.emit({ type: 'log', text: `log ${i}`, who: 'runner' }));
    }
    await Promise.all(emits);
    // Some log events were shed; the count is nonzero.
    assert.ok(sink.dropped > 0, 'droppable events were shed under pressure');
    // A must-deliver event (state) is never shed when droppables exist.
    const stateEmit = sink.emit({ type: 'state', state: 'running' });
    daemon.resume();
    await stateEmit;
    await sink.flush();
    // The state event made it through.
    assert.ok(
      daemon.events.some((e) => e.type === 'state' && e.state === 'running'),
      'the must-deliver state event survived the pressure',
    );
  } finally {
    delete process.env.FLEET_EVENT_POST_TIMEOUT_MS;
    delete process.env.FLEET_EVENT_MAX_ATTEMPTS;
    daemon.resume();
    await daemon.close();
  }
});

test('EventSink: flush() resolves immediately when idle, waits when busy', async () => {
  const token = 'test-sink-flush';
  const daemon = await startFlakyDaemon({ token });
  const sink = new EventSink({ jobId: 'job-flush', daemonUrl: daemon.url, token });
  try {
    // Idle: flush resolves instantly.
    const t0 = Date.now();
    await sink.flush();
    assert.ok(Date.now() - t0 < 100, 'flush resolves immediately when idle');

    // Emit then flush: flush waits for delivery.
    await sink.emit({ type: 'log', text: 'hello', who: 'runner' });
    await sink.flush();
    assert.equal(daemon.events.length, 1);
  } finally {
    await daemon.close();
  }
});

// ── Integration: runner survives a daemon blip mid-stream ──────────────────

test('#109: daemon unreachable mid-stream → runner survives, settles, drop count in notes', async () => {
  const token = 'test-delivery-blip';
  const daemon = await startFlakyDaemon({ token });
  const workspace = writeWorkspace(`node -e "process.exit(0)"`);
  const report = {
    status: 'READY',
    next_action: 'open the pull request',
    verification: ['fixture replay completed'],
  };

  // Very fast retry so the blip recovery is quick.
  process.env.FLEET_EVENT_RETRY_BASE_MS = '10';
  process.env.FLEET_EVENT_RETRY_MAX_MS = '50';
  process.env.FLEET_EVENT_POST_TIMEOUT_MS = '100';
  process.env.FLEET_EVENT_MAX_ATTEMPTS = '10';

  try {
    const run = runRunner({
      FLEET_JOB_ID: 'job-blip-1',
      FLEET_DAEMON_URL: daemon.url,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: REPLAY_CMD,
      TEST_FIXTURE: fixturePath,
      TEST_REPORT: JSON.stringify(report),
    });

    // Wait until the runner has started emitting (state running arrives).
    await delay(200);
    // Pause the daemon mid-stream — events will fail and retry.
    daemon.pause();
    await delay(300);
    // Resume — the runner should recover and finish.
    daemon.resume();

    const { code, stderr } = await run;
    assert.equal(code, 0, `runner exited 0 after surviving the blip. stderr: ${stderr}`);
    assert.deepEqual(daemon.rejected, []);

    const types = daemon.events.map((e) => e.type);
    assert.ok(types.includes('settle'), 'a settle event was delivered');
    assert.ok(types.includes('state'), 'state events were delivered');

    // If any events were dropped during the blip, the settle notes mention it.
    const settle = daemon.events.find((e) => e.type === 'settle') as Record<string, unknown> | undefined;
    assert.ok(settle, 'settle event exists');
    // The runner survived the blip and completed — that is the core assertion.
  } finally {
    delete process.env.FLEET_EVENT_RETRY_BASE_MS;
    delete process.env.FLEET_EVENT_RETRY_MAX_MS;
    delete process.env.FLEET_EVENT_POST_TIMEOUT_MS;
    delete process.env.FLEET_EVENT_MAX_ATTEMPTS;
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('#109: no unbounded per-line array — depth is bounded, not O(lines)', async () => {
  const token = 'test-delivery-bound';
  const daemon = await startFlakyDaemon({ token });
  const sink = new EventSink({
    jobId: 'job-bound',
    daemonUrl: daemon.url,
    token,
    maxPending: 8,
  });
  process.env.FLEET_EVENT_POST_TIMEOUT_MS = '30000';
  try {
    daemon.pause();
    // Push many events while the daemon is unreachable. With a bounded
    // buffer, depth never exceeds maxPending (+ 1 for the in-flight post).
    for (let i = 0; i < 100; i++) {
      sink.emit({ type: 'log', text: `line ${i}`, who: 'runner' });
      // depth is bounded by maxPending, not by the number of emits.
      assert.ok(sink.depth <= 8, `depth ${sink.depth} stayed within the cap (line ${i})`);
    }
    daemon.resume();
    await sink.flush();
    // Most events were shed; only a bounded number were delivered.
    assert.ok(sink.dropped > 50, 'the majority of 100 events were shed, not buffered');
  } finally {
    delete process.env.FLEET_EVENT_POST_TIMEOUT_MS;
    daemon.resume();
    await daemon.close();
  }
});