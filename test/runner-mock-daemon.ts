/**
 * Tiny in-test daemon implementing the two runner-facing endpoints:
 *   POST /internal/jobs/:id/events   (single JSON or ndjson batch)
 *   GET  /internal/jobs/:id/answer?decision=<id>
 *
 * Every incoming event is validated against events.schema.json and seq is
 * checked strictly monotonic; invalid input → 422 and NOT recorded, exactly
 * like the real daemon. Not a test file itself — shared by runner-*.test.ts.
 */

import { createServer } from 'node:http';
// @ts-ignore -- plain-JS module, no type declarations
import { validateEvent } from '../src/validate.mjs';

export type PostedEvent = Record<string, unknown>;

export type MockDaemon = {
  url: string;
  /** Accepted (schema-valid) events in arrival order. */
  events: PostedEvent[];
  /** Rejected posts: schema failures or seq regressions. */
  rejected: { event: unknown; errors: unknown }[];
  /** Requests carrying a wrong/missing runner token. */
  badTokenCount: number;
  /** Stage an operator answer for a decision id. */
  answer(decisionId: string, answer: { option?: string; text?: string }): void;
  close(): Promise<void>;
};

export async function startMockDaemon(opts: { token: string }): Promise<MockDaemon> {
  const events: PostedEvent[] = [];
  const rejected: { event: unknown; errors: unknown }[] = [];
  const answers = new Map<string, { option?: string; text?: string }>();
  let badTokenCount = 0;
  let lastSeq = -1;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers['x-fleet-runner-token'] !== opts.token) {
      badTokenCount += 1;
      res.writeHead(401).end(JSON.stringify({ error: 'bad token' }));
      return;
    }

    if (req.method === 'POST' && /^\/internal\/jobs\/[^/]+\/events$/.test(url.pathname)) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const lines = body.split('\n').filter((line) => line.trim() !== '');
      const parsed: unknown[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line));
        } catch (err) {
          rejected.push({ event: line, errors: [String(err)] });
          res.writeHead(422).end(JSON.stringify({ errors: ['bad json'] }));
          return;
        }
      }
      for (const event of parsed) {
        const { ok, errors } = validateEvent(event);
        const seq = (event as PostedEvent).seq;
        if (!ok || typeof seq !== 'number' || seq <= lastSeq) {
          rejected.push({ event, errors: ok ? ['seq not monotonic'] : errors });
          res.writeHead(422).end(JSON.stringify({ errors }));
          return;
        }
        lastSeq = seq;
        events.push(event as PostedEvent);
      }
      res.writeHead(200).end('{}');
      return;
    }

    if (req.method === 'GET' && /^\/internal\/jobs\/[^/]+\/answer$/.test(url.pathname)) {
      const decision = url.searchParams.get('decision') ?? '';
      const answer = answers.get(decision);
      if (answer) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      } else {
        // Real daemon holds up to 25s; the mock returns an empty cycle
        // immediately and lets the runner re-poll.
        res.writeHead(204).end();
      }
      return;
    }

    res.writeHead(404).end();
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('mock daemon failed to bind');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    events,
    rejected,
    get badTokenCount() {
      return badTokenCount;
    },
    answer: (decisionId, answer) => {
      answers.set(decisionId, answer);
    },
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}
