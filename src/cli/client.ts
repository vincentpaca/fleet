// Fleet daemon HTTP client: unix socket ($FLEET_HOME/daemon.sock) or FLEET_DAEMON_URL.
// node:http because fetch() cannot speak unix sockets.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export type DaemonResponse = {
  status: number;
  body: string;
  json: unknown;
};

export type RequestOptions = {
  /** Called once per complete NDJSON line as chunks arrive (streaming reads). */
  onLine?: (line: string) => void;
  /** Env to resolve the daemon address from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Socket-level timeout in milliseconds (long polls need > 25s). */
  timeoutMs?: number;
};

type Target =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'tcp'; host: string; port: number; basePath: string };

export function daemonTarget(env: Record<string, string | undefined> = process.env): Target {
  const url = env.FLEET_DAEMON_URL;
  if (url) {
    const u = new URL(url);
    return {
      kind: 'tcp',
      host: u.hostname,
      port: u.port ? Number(u.port) : 80,
      basePath: u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''),
    };
  }
  const home = env.FLEET_HOME ?? path.join(os.homedir(), '.fleet');
  return { kind: 'socket', socketPath: path.join(home, 'daemon.sock') };
}

export function describeTarget(env: Record<string, string | undefined> = process.env): string {
  const target = daemonTarget(env);
  return target.kind === 'tcp' ? `http://${target.host}:${target.port}${target.basePath}` : target.socketPath;
}

export function request(
  method: string,
  reqPath: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<DaemonResponse> {
  const target = daemonTarget(opts.env ?? process.env);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const requestOptions: http.RequestOptions = {
    method,
    path: target.kind === 'tcp' ? `${target.basePath}${reqPath}` : reqPath,
    headers: payload === undefined
      ? { accept: 'application/json' }
      : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
  };
  if (target.kind === 'tcp') {
    requestOptions.host = target.host;
    requestOptions.port = target.port;
  } else {
    requestOptions.socketPath = target.socketPath;
  }

  const { promise, resolve, reject } = Promise.withResolvers<DaemonResponse>();
  const req = http.request(requestOptions, (res) => {
    let full = '';
    let pending = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      full += chunk;
      if (!opts.onLine) return;
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line !== '') opts.onLine(line);
        nl = pending.indexOf('\n');
      }
    });
    res.on('end', () => {
      const tail = pending.trim();
      if (opts.onLine && tail !== '') opts.onLine(tail);
      let json: unknown;
      try {
        json = full === '' ? undefined : JSON.parse(full);
      } catch {
        json = undefined;
      }
      resolve({ status: res.statusCode ?? 0, body: full, json });
    });
    res.on('error', reject);
  });
  req.setTimeout(opts.timeoutMs ?? 60_000, () => {
    req.destroy(new Error('daemon request timed out'));
  });
  req.on('error', reject);
  if (payload !== undefined) req.write(payload);
  req.end();
  return promise;
}
