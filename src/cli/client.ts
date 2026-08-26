// Fleet daemon HTTP client: unix socket ($FLEET_HOME/daemon.sock) or FLEET_DAEMON_URL.
// A thin layer over ../shared/http.ts — the one http.request wrapper in the
// codebase, with connection pooling disabled there (a kept-alive socket to a
// restarted daemon's stale unix socket would EPIPE).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fleetHome, operatorTokenPath } from '../shared/home.ts';

import { request as httpRequest } from '../shared/http.ts';
import { fetchDeploymentOperatorToken } from './tunnel-openers.ts';

export type DaemonResponse = {
  status: number;
  body: string;
  json: unknown;
};

type RequestOptions = {
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

type Target =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'tcp'; host: string; port: number; basePath: string };

/**
 * A daemon address that cannot be used: unparseable, a scheme this client
 * cannot speak, or a repo-named target the trust check refuses (#135). Its
 * message is the whole story — main.ts prints it and exits 1 instead of
 * letting a raw TypeError stack out of `new URL` (#125).
 */
export class DaemonTargetError extends Error {}

/** Hosts that are this machine. Loopback is the daemon-target trust boundary (#135). */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The boot-generated operator secret gating /jobs/* (issue #133), read once
 * per process from $FLEET_HOME/operator-token. Undefined when the file is
 * absent — socket-only deployments from before the secret existed, and tests
 * against daemons constructed without operatorToken, keep working.
 */
const operatorTokenCache = new Map<string, string | undefined>();
function readOperatorToken(env: Record<string, string | undefined> = process.env): string | undefined {
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

/**
 * The operator token could not be settled with the daemon even after fetching
 * the copy its deployment published (#188). Like DaemonTargetError, its
 * message is the whole story — a caller prints it and exits 1 rather than
 * surfacing a bare 401 the operator has to decode into "stale token".
 */
export class OperatorTokenError extends Error {}

/**
 * One fetch of the deployment-published token per process and cwd — the
 * memoization bargain daemonTarget strikes, for the same resident-loop reason:
 * a cockpit polling every 2s against a deployment whose fetch fails must not
 * shell out to `aws` on every tick. `refetched` spends the single
 * 401-triggered retry the same way.
 */
const deploymentTokenFetch = new Map<string, { token?: string; error?: string }>();
const refetched = new Set<string>();

function tokenFetchKey(tokenPath: string, cwd: string): string {
  return [tokenPath, cwd].join('\u0000');
}

/** Write a fetched token where readOperatorToken looks — 0600, like the daemon's own copy. */
function cacheFetchedToken(tokenPath: string, token: string): void {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies on create; a stale file keeps its own.
  fs.chmodSync(tokenPath, 0o600);
  operatorTokenCache.set(tokenPath, token);
}

/**
 * Fetch the operator token from the deployment this checkout captured (#188):
 * the first `.fleet/infra/<provider>/fleet-config.json` whose provider offers
 * a token source — the same first-wins walk daemonTarget does for daemon_url.
 * Resolves to undefined when no captured config offers one (a local socket
 * daemon shares $FLEET_HOME with the CLI, so its token file is already ours).
 */
async function fetchDeploymentToken(cwd: string): Promise<{ token?: string; error?: string } | undefined> {
  for (const { config } of fleetConfigFiles(cwd)) {
    const fetch = fetchDeploymentOperatorToken(config);
    if (fetch === undefined) continue;
    try {
      return { token: await fetch };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return undefined;
}

/**
 * The token to attach: the local file first; when there is none, the copy the
 * deployment's daemon published at boot — fetched once, cached to the local
 * file at 0600, and used from there on (#188). A failed fetch resolves to
 * undefined so the request proceeds tokenless: the daemon's 401 then carries
 * the story through the refetch path below.
 */
async function resolveOperatorToken(env: Record<string, string | undefined>, cwd: string): Promise<string | undefined> {
  const local = readOperatorToken(env);
  if (local !== undefined) return local;
  const tokenPath = operatorTokenPath(fleetHome(env));
  const key = tokenFetchKey(tokenPath, cwd);
  let attempt = deploymentTokenFetch.get(key);
  if (attempt === undefined) {
    attempt = (await fetchDeploymentToken(cwd)) ?? {};
    deploymentTokenFetch.set(key, attempt);
    if (attempt.token !== undefined) cacheFetchedToken(tokenPath, attempt.token);
  }
  return attempt.token;
}

/** One captured deployment description: the file it came from, and its contents. */
type FleetConfigFile = { path: string; config: Record<string, unknown> };

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

/**
 * Parse an operator-supplied daemon URL, failing readably instead of letting
 * `new URL` throw a raw TypeError (#125). http only: src/shared/http.ts is
 * node:http — an https:// value used to be silently spoken as plain HTTP to
 * port 80, which is worse than a refusal.
 */
function parseHttpUrl(raw: string, source: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new DaemonTargetError(`${source} is not a valid URL: "${raw}"`);
  }
  if (u.protocol !== 'http:') {
    throw new DaemonTargetError(
      `${source} must be an http:// URL — Fleet's client speaks plain HTTP over loopback or a tunnel (got "${raw}")`,
    );
  }
  return u;
}

/**
 * The trust check on a repo-named daemon address (#135, item 1). The config
 * file travels with the checkout, so a cloned malicious repo chooses where
 * `fleet delegate` POSTs its secret-bearing payload (env vars, synced files).
 * Loopback is safe — the only way off this machine from there is a tunnel the
 * operator opened. Anything else is refused unless the operator explicitly
 * takes responsibility with FLEET_ALLOW_REMOTE_DAEMON=1. https is refused
 * outright: this client cannot speak it (src/shared/http.ts is node:http).
 */
function assertTrustedDaemonUrl(u: URL, configPath: string, env: Record<string, string | undefined>): void {
  if (u.protocol !== 'http:') {
    throw new DaemonTargetError(
      `daemon_url in ${configPath} is ${u.protocol}// — Fleet's client speaks plain HTTP only; point it at a loopback tunnel (http://127.0.0.1:<port>)`,
    );
  }
  if (LOOPBACK_HOSTS.has(u.hostname)) return;
  if (env.FLEET_ALLOW_REMOTE_DAEMON === '1') return;
  throw new DaemonTargetError(
    `refusing daemon_url ${u.origin} from ${configPath}: it is not loopback, and dispatch sends secrets `
    + `(env vars, synced files) over plain HTTP to whatever daemon this repo-controlled file names. `
    + `If you trust that address, set FLEET_ALLOW_REMOTE_DAEMON=1.`,
  );
}

/**
 * Say — loudly, once — when a checkout's config names a daemon_url this
 * machine has never used for it (#135). The record lives under FLEET_HOME,
 * never under .fleet/: the repo is the untrusted party here, and a state file
 * it can rewrite is no state at all. Read/write failures fail open to warning
 * again next run — the safe direction.
 */
function warnFirstSeenDaemonUrl(
  u: URL,
  configPath: string,
  cwd: string,
  env: Record<string, string | undefined>,
): void {
  const file = path.join(fleetHome(env), 'seen-daemon-urls.json');
  let seen: Record<string, string[]> = {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) seen = raw as Record<string, string[]>;
  } catch {
    // first run, or an unreadable record: treat everything as unseen
  }
  const urls = Array.isArray(seen[cwd]) ? seen[cwd] : [];
  if (urls.includes(u.href)) return;
  console.error(
    `fleet: NOTE: first use of daemon_url ${u.href} (from ${configPath}) in this checkout — `
    + `fleet commands will talk to it, and dispatch sends secrets to it.`,
  );
  seen[cwd] = [...urls, u.href];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(seen, null, 2)}\n`);
  } catch {
    // unrecordable: warn again next run rather than never again
  }
}

/** The uncached resolution behind {@link daemonTarget}. */
function resolveDaemonTarget(env: Record<string, string | undefined>, cwd: string): Target {
  // 1. Explicit env override — the operator's own environment, so it is the
  //    override channel: validated for shape and scheme, not for loopback.
  const url = env.FLEET_DAEMON_URL;
  if (url) return urlToTcpTarget(parseHttpUrl(url, 'FLEET_DAEMON_URL'));

  // 2. Per-deployment fleet-config.json (written by `fleet setup infra` (#13) or by hand).
  //    Scan .fleet/infra/<provider>/fleet-config.json for a daemon_url field; first wins.
  //    This file arrives with the checkout, so it gets the trust check (#135).
  for (const { path: configPath, config } of fleetConfigFiles(cwd)) {
    const u = configDaemonUrl(config);
    if (!u) continue;
    assertTrustedDaemonUrl(u, configPath, env);
    warnFirstSeenDaemonUrl(u, configPath, cwd, env);
    return urlToTcpTarget(u);
  }

  // 3. Unix socket at $FLEET_HOME.
  const home = env.FLEET_HOME ?? path.join(os.homedir(), '.fleet');
  return { kind: 'socket', socketPath: path.join(home, 'daemon.sock') };
}

/**
 * Memoized for the life of the process, the same bargain as the operator
 * token above (#125): `request` resolves the target on every call, and the
 * cockpit's 2-second poll was re-walking `.fleet/infra/*` with sync fs reads
 * on its resident loop. Safe because nothing changes a resolution mid-process:
 * `fleet setup infra` writes fleet-config.json and exits without resolving
 * again, and the cockpit deliberately holds one address for its lifetime — its
 * tunnel is bound to it. Keyed on every input resolution reads (env vars and
 * cwd), so a test or caller with a different environment gets its own entry.
 * Failed resolutions are not cached: a refusal must repeat, not vanish.
 */
const targetCache = new Map<string, Target>();

export function daemonTarget(
  env: Record<string, string | undefined> = process.env,
  opts: { cwd?: string } = {},
): Target {
  const cwd = opts.cwd ?? process.cwd();
  const key = [env.FLEET_DAEMON_URL ?? '', env.FLEET_HOME ?? '', env.FLEET_ALLOW_REMOTE_DAEMON ?? '', cwd]
    .join('\u0000');
  const cached = targetCache.get(key);
  if (cached !== undefined) return cached;
  const target = resolveDaemonTarget(env, cwd);
  targetCache.set(key, target);
  return target;
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
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const target = daemonTarget(env, { cwd: opts.cwd });
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // /jobs/* requires the operator secret (issue #133); attaching it to every
  // request is harmless for /health and /internal/*, which ignore it.
  const token = await resolveOperatorToken(env, cwd);
  const res = await perform(target, method, reqPath, payload, token, opts);
  if (res.status !== 401) return res;
  return retryWithFreshToken(res, token, { env, cwd, target, method, reqPath, payload, opts });
}

/**
 * The 401 path (#188): the daemon refused the token we hold — a fresh apply
 * regenerates the daemon's token on a new EFS volume, so a locally cached
 * copy going stale is the expected shape of this failure, not a corner case.
 * Refetch the deployment-published copy once per process, retry once with it,
 * and when even that is refused, say the whole story instead of the bare 401.
 * Deployments with no token source (a local socket daemon shares its token
 * file with the CLI already) keep today's behavior: the 401 goes to the caller.
 */
async function retryWithFreshToken(
  res: DaemonResponse,
  usedToken: string | undefined,
  ctx: {
    env: Record<string, string | undefined>;
    cwd: string;
    target: Target;
    method: string;
    reqPath: string;
    payload: string | undefined;
    opts: RequestOptions;
  },
): Promise<DaemonResponse> {
  const tokenPath = operatorTokenPath(fleetHome(ctx.env));
  const key = tokenFetchKey(tokenPath, ctx.cwd);
  if (refetched.has(key)) return res; // the one retry is spent — repeat 401s are the caller's
  refetched.add(key);
  const attempt = await fetchDeploymentToken(ctx.cwd);
  if (attempt === undefined) return res;
  if (attempt.error !== undefined || attempt.token === undefined) {
    throw new OperatorTokenError(
      `the daemon refused the operator token (401), and refetching the deployment's copy failed: ${attempt.error ?? 'no token published'} — `
      + `copy $FLEET_HOME/operator-token from the daemon into ${tokenPath}`,
    );
  }
  cacheFetchedToken(tokenPath, attempt.token);
  if (attempt.token === usedToken) {
    throw new OperatorTokenError(
      `the daemon refused the operator token (401), and the deployment's published copy is the same value — `
      + `the daemon and its SSM parameter disagree; restart the daemon task (it republishes its token at boot)`,
    );
  }
  const retry = await perform(ctx.target, ctx.method, ctx.reqPath, ctx.payload, attempt.token, ctx.opts);
  if (retry.status === 401) {
    throw new OperatorTokenError(
      `the daemon refused both the local operator token and the one refetched from the deployment — `
      + `restart the daemon task (it republishes its token at boot), or copy $FLEET_HOME/operator-token from it into ${tokenPath}`,
    );
  }
  return retry;
}

/** One HTTP exchange with the daemon — the transport half of {@link request}. */
async function perform(
  target: Target,
  method: string,
  reqPath: string,
  payload: string | undefined,
  token: string | undefined,
  opts: RequestOptions,
): Promise<DaemonResponse> {
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
