// Fleet daemon HTTP client: unix socket ($FLEET_HOME/daemon.sock) or FLEET_DAEMON_URL.
// node:http because fetch() cannot speak unix sockets.
import http from 'node:http';
import fs from 'node:fs';
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
  /** Working directory for fleet-config.json lookup; defaults to process.cwd(). */
  cwd?: string;
};

export type Target =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'tcp'; host: string; port: number; basePath: string };

/** One captured deployment description: the file it came from, and its contents. */
export type FleetConfigFile = { path: string; config: Record<string, unknown> };

/**
 * Every parseable `.fleet/infra/<provider>/fleet-config.json` under cwd, in
 * directory order. One reader for both consumers — `daemonTarget` takes the
 * first config carrying a usable daemon_url, `fleet connect` prefers that same
 * one — so neither can drift on where a deployment description lives.
 * Unreadable and malformed files are skipped, never fatal: a half-captured
 * config for one provider must not hide a good one for another.
 */
export function* fleetConfigFiles(cwd: string = process.cwd()): Generator<FleetConfigFile> {
  const infraDir = path.join(cwd, '.fleet', 'infra');
  let providers: string[];
  try {
    providers = fs.readdirSync(infraDir);
  } catch {
    return; // .fleet/infra/ does not exist
  }
  for (const provider of providers) {
    if (!fs.statSync(path.join(infraDir, provider), { throwIfNoEntry: false })?.isDirectory()) continue;
    const configPath = path.join(infraDir, provider, 'fleet-config.json');
    let config: unknown;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      continue; // missing or malformed — try the next provider
    }
    if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
      yield { path: configPath, config: config as Record<string, unknown> };
    }
  }
}

/**
 * The usable `daemon_url` in a captured config, or undefined. One predicate, so
 * `fleet connect` cannot tunnel for the capture in one provider directory while
 * every other command talks to another's daemon — an empty string or a
 * non-URL has to disqualify a file for both of them identically.
 */
export function configDaemonUrl(config: Record<string, unknown>): URL | undefined {
  const value = config.daemon_url;
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the daemon address from (highest priority first):
 *   1. FLEET_DAEMON_URL env var
 *   2. .fleet/infra/<provider>/fleet-config.json — daemon_url field
 *   3. Unix socket at $FLEET_HOME/daemon.sock
 */
export function daemonTarget(
  env: Record<string, string | undefined> = process.env,
  opts: { cwd?: string } = {},
): Target {
  // 1. Explicit env override.
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

  // 2. Per-deployment fleet-config.json (written by `fleet setup infra` (#13) or by hand).
  //    Scan .fleet/infra/<provider>/fleet-config.json for a daemon_url field; first wins.
  for (const { config } of fleetConfigFiles(opts.cwd ?? process.cwd())) {
    const u = configDaemonUrl(config);
    if (!u) continue;
    return {
      kind: 'tcp',
      host: u.hostname,
      port: u.port ? Number(u.port) : 80,
      basePath: u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''),
    };
  }

  // 3. Unix socket at $FLEET_HOME.
  const home = env.FLEET_HOME ?? path.join(os.homedir(), '.fleet');
  return { kind: 'socket', socketPath: path.join(home, 'daemon.sock') };
}

export function describeTarget(
  env: Record<string, string | undefined> = process.env,
  opts: { cwd?: string } = {},
): string {
  const target = daemonTarget(env, opts);
  return target.kind === 'tcp' ? `http://${target.host}:${target.port}${target.basePath}` : target.socketPath;
}

export function request(
  method: string,
  reqPath: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<DaemonResponse> {
  const target = daemonTarget(opts.env ?? process.env, { cwd: opts.cwd });
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
