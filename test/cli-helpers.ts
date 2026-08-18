// Shared helpers for CLI tests (not a test file itself: no .test suffix).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

export type CliResult = { code: number; stdout: string; stderr: string };

export function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<CliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const env: Record<string, string | undefined> = { ...process.env, FLEET_DAEMON_URL: undefined, ...opts.env };
  const child = spawn(process.execPath, [CLI, ...args], {
    // Never inherit the checkout as cwd: daemon resolution scans
    // .fleet/infra/*/fleet-config.json under cwd (#15), so a test run from a
    // checkout with a live deployment would silently query — or dispatch to —
    // production. Same isolation the FLEET_DAEMON_URL scrub above provides
    // for resolution step 1.
    cwd: opts.cwd ?? makeTempDir('fleet-cli-cwd-'),
    env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  return promise;
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export type MockRequest = { method: string; url: string; body: string };

export type MockDaemon = {
  url: string;
  requests: MockRequest[];
  close: () => Promise<void>;
};

/** Tiny in-test daemon: routes "METHOD pathname" → handler. Unmatched routes get 404. */
export function startMockDaemon(
  routes: Record<string, (req: MockRequest, res: http.ServerResponse) => void>,
  listenOn?: { socketPath: string },
): Promise<MockDaemon> {
  const { promise, resolve, reject } = Promise.withResolvers<MockDaemon>();
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const record: MockRequest = { method: req.method ?? '', url: req.url ?? '', body };
      requests.push(record);
      const pathname = record.url.split('?')[0];
      const handler = routes[`${record.method} ${pathname}`];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ instancePath: '/', message: 'not found' }] }));
        return;
      }
      handler(record, res);
    });
  });
  server.on('error', reject);
  const done = () => {
    const address = server.address();
    const url =
      address !== null && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : String(address);
    resolve({
      url,
      requests,
      close: () => {
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        return closed.promise;
      },
    });
  };
  if (listenOn) server.listen(listenOn.socketPath, done);
  else server.listen(0, '127.0.0.1', done);
  return promise;
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function sendNdjson(res: http.ServerResponse, events: unknown[]): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.end(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}
