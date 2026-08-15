// attach --answer: the CLI holds the wait, renders the decision, reads the
// answer from stdin, posts it, and exits when the job settles. This is the
// loop a calling harness (or a human terminal) runs; watching is a view,
// never a lifeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli', 'main.ts');

type Phase = 'decision' | 'answered';

const ndjson = (events: object[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('attach --answer posts the stdin answer and exits on done', async (t) => {
  let phase: Phase = 'decision';
  const answers: unknown[] = [];

  const daemon = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/jobs/job-1/events') {
      const after = Number(url.searchParams.get('after') ?? '-1');
      res.setHeader('content-type', 'application/x-ndjson');
      if (phase === 'decision' && after < 2) {
        res.end(ndjson([
          { job: 'job-1', seq: 0, type: 'state', state: 'running' },
          {
            job: 'job-1', seq: 1, type: 'decision', id: 'd1',
            question: 'Rebase or wait?',
            options: [
              { id: 'rebase', label: 'Rebase now', recommended: true },
              { id: 'wait', label: 'Park until merge' },
            ],
          },
          { job: 'job-1', seq: 2, type: 'state', state: 'blocked' },
        ]));
      } else if (phase === 'answered') {
        res.end(ndjson([
          { job: 'job-1', seq: 3, type: 'answer', decision: 'd1', option: 'rebase', by: 'operator' },
          {
            job: 'job-1', seq: 4, type: 'settle', rung: 'implemented', minutes: 1,
            outcome: { produced: [], findings: 0, decisions: 1 },
            report: { status: 'READY', next_action: 'open the pull request' },
          },
          { job: 'job-1', seq: 5, type: 'state', state: 'done' },
        ]));
      } else {
        res.end(''); // empty long-poll cycle while the CLI is prompting
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/jobs/job-1/answer') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        answers.push(JSON.parse(body));
        phase = 'answered';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  daemon.listen(0, '127.0.0.1');
  await once(daemon, 'listening');
  t.after(() => daemon.close());
  const address = daemon.address();
  assert.ok(address && typeof address === 'object');

  const child = spawn('node', [cli, 'attach', 'job-1', '--answer'], {
    env: { ...process.env, FLEET_DAEMON_URL: `http://127.0.0.1:${address.port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  let err = '';
  child.stderr.on('data', (c) => (err += c));

  // Feed the answer as soon as the prompt appears on stderr.
  child.stderr.on('data', () => {
    if (err.includes('answer [rebase | wait]') && !child.stdin.destroyed) {
      child.stdin.write('rebase go ahead\n');
      child.stdin.end();
    }
  });

  const [code] = (await once(child, 'exit')) as [number];
  assert.equal(code, 0, `stderr:\n${err}\nstdout:\n${out}`);
  assert.deepStrictEqual(answers, [{ option: 'rebase', text: 'go ahead' }]);
  assert.match(out, /decision d1: Rebase or wait\?/);
  assert.match(out, /rebase \(recommended\)/);
  assert.match(out, /settle rung=implemented status=READY next: open the pull request/);
  assert.match(out, /state done/);
});
