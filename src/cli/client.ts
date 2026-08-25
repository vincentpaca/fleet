// Fleet daemon HTTP client: unix socket ($FLEET_HOME/daemon.sock) or FLEET_DAEMON_URL.
// A thin layer over ../shared/http.ts — the one http.request wrapper in the
// codebase, with connection pooling disabled there (a kept-alive socket to a
// restarted daemon's stale unix socket would EPIPE).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fleetHome, operatorTokenPath } from '../shared/home.ts';

import { request as httpRequest } from '../shared/http.ts';

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
  /**
   * Abort the call, closing the socket. A follow read is held open by the daemon
   * for its whole long-poll window, so a caller that stops caring — a cockpit
   * whose selection moved, or one that is closing — has to be able to hang up:
   * otherwise the socket outlives the reason for it.
   */
  signal?: AbortSignal;
  /** Extra request headers merged over the built-ins; caller keys win. */
  headers?: Record<string, string>;
};

export type Target =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'tcp'; host: string; port: number; basePath: string };

/**
 * The boot-generated operator secret gating /jobs/* (issue #133), read once
 * per process from $FLEET_HOME/operator-token. Undefined when the file is
 * absent — socket-only deployments from before the secret existed, and tests
 * against daemons constructed without operatorToken, keep working.
 */
const operatorTokenCache = new Map<string, string | undefined>();
export function readOperatorToken(env: Record<string, string | undefined> = process.env): string | undefined {
  const tokenPath = operatorTokenPath(fleetHome(env));
  if (operatorTokenCache.has(tokenPath)) return operatorTokenCache.get(tokenPath);
  let token: string | undefined;
  try {
    const raw = fs.readFileSync(tokenPath, 'utf8').trim();
    if (raw !== '') token = raw;
  } catch {
    // No token file: nothing to attach.
  }
  operatorTokenCache.set(tokenPath, token);
  return token;
}

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
/** Convert a URL object to a TCP target, stripping trailing slashes from the base path. */
function urlToTcpTarget(u: URL): Target {
  return {
    kind: 'tcp',
    host: u.hostname,
    port: u.port ? Number(u.port) : 80,
    basePath: u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''),
  };
}

export function daemonTarget(
  env: Record<string, string | undefined> = process.env,
  opts: { cwd?: string } = {},
): Target {
  // 1. Explicit env override.
  const url = env.FLEET_DAEMON_URL;
  if (url) return urlToTcpTarget(new URL(url));

  // 2. Per-deployment fleet-config.json (written by `fleet setup infra` (#13) or by hand).
  //    Scan .fleet/infra/<provider>/fleet-config.json for a daemon_url field; first wins.
  for (const { config } of fleetConfigFiles(opts.cwd ?? process.cwd())) {
    const u = configDaemonUrl(config);
    if (!u) continue;
    return urlToTcpTarget(u);
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

/**
 * Does the daemon answer at the address this checkout resolves — socket, port,
 * base path and all? `probeDaemonHealth` in ./connect.ts asks a narrower
 * question (is a forward on this local port serving), and both are needed: one
 * is about a tunnel, this one is about the daemon every command talks to.
 */
export async function daemonHealthy(
  env: Record<string, string | undefined> = process.env,
  cwd?: string,
  timeoutMs = 3_000,
): Promise<boolean> {
  try {
    const res = await request('GET', '/health', undefined, { env, cwd, timeoutMs });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function request(
  method: string,
  reqPath: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<DaemonResponse> {
  const target = daemonTarget(opts.env ?? process.env, { cwd: opts.cwd });
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // /jobs/* requires the operator secret (issue #133); attaching it to every
  // request is harmless for /health and /internal/*, which ignore it.
  const token = readOperatorToken(opts.env ?? process.env);
  const authHeaders: Record<string, string> = token !== undefined
    ? { 'x-fleet-operator-token': token }
    : {};
  const res = await httpRequest({
    method,
    path: target.kind === 'tcp' ? `${target.basePath}${reqPath}` : reqPath,
    ...(target.kind === 'tcp'
      ? { host: target.host, port: target.port }
      : { socketPath: target.socketPath }),
    headers: {
      accept: 'application/json',
      ...(payload === undefined
        ? {}
        : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
      ...authHeaders,
      ...opts.headers,
    },
    body: payload,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onLine: opts.onLine,
  });
  let json: unknown;
  try {
    json = res.body === '' ? undefined : JSON.parse(res.body);
  } catch {
    json = undefined; // non-JSON body (e.g. an ndjson dump); caller reads body directly
  }
  return { status: res.status, body: res.body, json };
}
