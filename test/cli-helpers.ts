// Shared helpers for CLI tests (not a test file itself: no .test suffix).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

/**
 * One event of every type the renderers know, plus an unknown one ('pair').
 * Shared by the characterization tests that pin `formatEvent` (cli-ops) and
 * `renderEventLines` (cli-board) byte-for-byte: both switches cover the same
 * vocabulary, so both are pinned against the same battery (#128).
 */
export const EVENT_BATTERY = [
  { seq: 1, type: 'state', state: 'running' },
  { seq: 2, type: 'state', state: 'blocked', reason: 'decision', marker: 'parked' },
  { seq: 3, type: 'phase', text: 'setup' },
  { seq: 4, type: 'think', text: 'planning the change' },
  { seq: 5, type: 'log', text: 'tool_use Read: {"file_path":"/p/a.ts","limit":5}' },
  { seq: 6, type: 'log', text: 'plain line' },
  { seq: 7, type: 'progress', value: 0.42 },
  {
    seq: 8, type: 'decision', id: 'd1', question: 'Which way?',
    options: [
      { id: 'a', label: 'Left', recommended: true },
      { id: 'b', label: 'Right' },
      { id: 'c' },
    ],
  },
  { seq: 9, type: 'answer', decision: 'd1', option: 'a', text: 'go left', by: 'vince' },
  { seq: 10, type: 'answer', decision: 'd9', text: 'freeform' },
  { seq: 11, type: 'answer' },
  { seq: 12, type: 'settle', rung: 'pr-open', report: { status: 'READY', next_action: 'review it' } },
  { seq: 13, type: 'settle', report: { status: 'PARTIAL' } },
  { seq: 14, type: 'pair', minutes: 3 },
  // A settle that delivered artifacts (#195): path-carrying produced[] entries
  // render a fetch command each; the URL-lane entry has no path and none.
  {
    seq: 15, type: 'settle', rung: 'inspected',
    report: { status: 'READY', next_action: 'fetch the artifacts' },
    outcome: {
      produced: [
        { id: 'a1', type: 'file', title: 'report', path: 'dist/report.pdf' },
        { id: 'a2', type: 'file', title: 'figure', path: 'charts/fig1.png' },
        { id: 'a3', type: 'page', title: 'notes', url: 'https://wiki.invalid/notes' },
      ],
      findings: 0,
      decisions: 0,
    },
  },
];

export type CliResult = { code: number; stdout: string; stderr: string };

export function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string } = {},
): Promise<CliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const env: Record<string, string | undefined> = {
    ...process.env,
    FLEET_DAEMON_URL: undefined,
    // Tests own their state (#136): default FLEET_HOME to a fresh dir unless
    // the caller pins one — same structural isolation as the URL scrub above
    // and the cwd choice below, so no runCli call can ever touch ~/.fleet.
    FLEET_HOME: opts.env?.FLEET_HOME ?? makeTempDir('fleet-cli-home-'),
    ...opts.env,
  };
  const child = spawn(process.execPath, [CLI, ...args], {
    // Never inherit the checkout as cwd: daemon resolution scans
    // .fleet/infra/*/fleet-config.json under cwd (#15), so a test run from a
    // checkout with a live deployment would silently query — or dispatch to —
    // production. Same isolation the FLEET_DAEMON_URL scrub above provides
    // for resolution step 1.
    cwd: opts.cwd ?? makeTempDir('fleet-cli-cwd-'),
    env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    // Piped stdin is how the interactive wizards are driven headlessly (#13);
    // without it, stdin stays closed, which is what a real non-terminal run has.
    stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
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

export type MockRequest = { method: string; url: string; body: string; headers: http.IncomingHttpHeaders };

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
      const record: MockRequest = { method: req.method ?? '', url: req.url ?? '', body, headers: req.headers };
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

// ---------- waiting on live processes ----------

/** Poll a predicate to true, or fail with what it was waiting for. */
export async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Resolve once the collected output contains `needle`, or reject when the process dies first. */
export function waitForLine(
  chunks: () => string,
  child: ChildProcess,
  needle: string,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setInterval(() => {
    if (chunks().includes(needle)) {
      clearInterval(timer);
      resolve();
    }
  }, 25);
  const deadline = setTimeout(() => {
    clearInterval(timer);
    reject(new Error(`timed out waiting for ${label}; output so far:\n${chunks()}`));
  }, timeoutMs);
  void promise.finally(() => {
    clearInterval(timer);
    clearTimeout(deadline);
  });
  child.on('close', () => {
    clearInterval(timer);
    if (!chunks().includes(needle)) reject(new Error(`the process exited before ${label}:\n${chunks()}`));
  });
  return promise;
}

// ---------- tunnel fixtures (shared by connect and cockpit tests) ----------

/** A port nothing is listening on: bind one, then let it go. */
export async function closedPort(): Promise<number> {
  const daemon = await startMockDaemon({});
  const port = Number(new URL(daemon.url).port);
  await daemon.close();
  return port;
}

/** A project dir with .fleet/infra/<provider>/fleet-config.json. */
export function projectWithConfig(config: unknown, provider = 'aws'): string {
  const cwd = makeTempDir('fleet-deployment-');
  const dir = path.join(cwd, '.fleet', 'infra', provider);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleet-config.json'), JSON.stringify(config, null, 2));
  return cwd;
}

/** A directory holding an `aws` that routes to fixtures/fake-aws.mjs. */
export function fakeAwsBin(stateDir: string): string {
  const bin = makeTempDir('fleet-fake-aws-');
  fakeBin(bin, 'aws', 'fake-aws.mjs');
  fs.mkdirSync(stateDir, { recursive: true });
  return bin;
}

/**
 * A directory holding a `terraform` (and an `aws` for the credential preflight)
 * that route to the fixtures. `fleet setup infra` shells out to both, and a
 * test that let either real binary run would be testing HashiCorp and AWS.
 */
export function fakeCloudBin(stateDir: string): string {
  const bin = makeTempDir('fleet-fake-cloud-');
  fakeBin(bin, 'terraform', 'fake-terraform.mjs');
  fakeBin(bin, 'aws', 'fake-aws.mjs');
  fs.mkdirSync(stateDir, { recursive: true });
  return bin;
}

/** Write a shim that execs a fixture under a binary's name. */
function fakeBin(bin: string, name: string, fixtureFile: string): void {
  const fixture = fileURLToPath(new URL(`../fixtures/${fixtureFile}`, import.meta.url));
  // exec, so a signal reaches node rather than the shell.
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, {
    mode: 0o755,
  });
}
