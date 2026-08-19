/**
 * `fleet connect` — own the daemon tunnel (issue #57).
 *
 * The daemon has no public ingress (docs/decisions.md#d12), so every operator
 * command reaches it through a port-forward the operator opened by hand: list
 * the daemon task, describe it for a container runtime id, assemble a four-part
 * SSM target, and remember which local port `fleet-config.json` points at. The
 * session then dies quietly — SSM idle timeout, a sleeping laptop, a plugin
 * crash — and every death resurfaces as `ECONNREFUSED` at the next dispatch.
 *
 * So Fleet owns the tunnel: resolve the deployment, open the forward, verify
 * /health, and reopen on exit with backoff — re-resolving the task every time,
 * because a service deployment replaces it. `connect_hint` stays in the infra
 * unit as the documented manual fallback.
 *
 * Nothing here is cloud-specific: the provider dispatch lives next door in
 * ./tunnel-openers.ts, the composition root core's cloud-agnostic gate exempts.
 * This file knows only the fleet_config vocabulary every infra unit owes
 * (test/cloud-agnostic.test.ts) and how to hold a command open.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { TunnelEndpoint, TunnelOpener } from '../providers/provider.ts';
import { request } from '../shared/http.ts';
import { killTree } from '../shared/process.ts';
import { configDaemonUrl, describeTarget, daemonTarget, fleetConfigFiles } from './client.ts';
import { refreshDeployment, tunnelOpenerFor, type CloudRunner, type Deployment } from './tunnel-openers.ts';

/** Reopen delays, in order; the last one repeats. A dead session is retried fast, then patiently. */
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** A session that survived this long counts as good: the next failure starts the backoff over. */
export const HEALTHY_SESSION_MS = 30_000;

/** How long /health may take to answer after the forward starts (SSM handshake included). */
export const HEALTH_TIMEOUT_MS = 20_000;

/** Poll interval while waiting for /health. */
export const HEALTH_INTERVAL_MS = 500;

/** How long an interrupted connect waits for its forward to die before leaving anyway. */
export const FORWARD_SHUTDOWN_MS = 3_000;

// ---------- deployment resolution ----------

/**
 * Daemon-access fields every infra unit's fleet_config owes (enforced by
 * test/cloud-agnostic.test.ts). Core reads them; only the provider knows what
 * to do with them.
 */
function hasDaemonAccess(config: Record<string, unknown>): boolean {
  return (
    typeof config.daemon_service === 'string' &&
    typeof config.daemon_container_name === 'string' &&
    typeof config.daemon_port === 'number'
  );
}

/**
 * Resolve the deployment from `.fleet/infra/<provider>/fleet-config.json`, and
 * — when the captured file predates the unit's daemon-access fields — from the
 * live source that file names (for AWS, the SSM parameter the daemon itself
 * reads at boot). That covers the ordinary case of an operator who re-applied
 * the unit but never re-captured the file, which is a manual step; it cannot
 * help before the unit is re-applied, and says so rather than guessing. The
 * local file stays authoritative for daemon_url, which is the operator's own
 * choice of local port and lives nowhere else.
 *
 * The chosen file is the one `daemonTarget` would resolve daemon_url from, so
 * connect cannot end up tunnelling for a different deployment than every other
 * command talks to.
 */
export async function resolveDeployment(cwd: string, run?: CloudRunner): Promise<Deployment> {
  const described = [...fleetConfigFiles(cwd)].filter(
    (file) => typeof file.config.provider === 'string' && file.config.provider !== '',
  );
  const found = described.find((file) => configDaemonUrl(file.config) !== undefined) ?? described[0];
  if (!found) {
    throw new Error(
      'no deployment found: capture your infra unit\'s fleet_config output as .fleet/infra/<provider>/fleet-config.json\n' +
        '  terraform -chdir=<fleet-checkout>/infra/aws/examples/basic output -json fleet_config > .fleet/infra/aws/fleet-config.json',
    );
  }
  // The operator's own text, not the normalised href: it goes into messages.
  const daemonUrl = configDaemonUrl(found.config) ? (found.config.daemon_url as string) : undefined;
  if (hasDaemonAccess(found.config)) {
    return { source: found.path, config: found.config, daemonUrl };
  }

  const refreshed = refreshDeployment(found.config, run);
  if (!refreshed) {
    throw new Error(
      `${found.path} describes no daemon access (daemon_service, daemon_container_name, daemon_port) and names no live source to re-read it from — re-capture it from a current terraform apply`,
    );
  }
  const fresh = await refreshed;
  if (!hasDaemonAccess(fresh.config)) {
    throw new Error(
      `${fresh.source} describes no daemon access either (daemon_service, daemon_container_name, daemon_port) — apply a current version of the infra unit, then re-capture ${found.path}`,
    );
  }
  return { source: `${fresh.source} (via ${found.path})`, config: fresh.config, daemonUrl };
}

/**
 * Local port to forward to, most authoritative first: the flag, then the port
 * the CLI already talks to (daemon_url), then the connect_hint convention of
 * prefixing the remote port with 1. Defaulting to daemon_url's port is the
 * point: connect and delegate must agree without the operator remembering.
 */
export function chooseLocalPort(
  flagPort: number | undefined,
  daemonUrl: string | undefined,
  remotePort: number,
): number {
  if (flagPort !== undefined) return flagPort;
  // A daemon_url naming no port names port 80 — an address, not a tunnel.
  const configured = daemonUrl === undefined ? undefined : configDaemonUrl({ daemon_url: daemonUrl })?.port;
  if (configured) return Number(configured);
  return Number(`1${remotePort}`);
}

// ---------- tunnel record ----------

/**
 * Host-local bookkeeping, same shape of thing as retained-workspace records
 * (src/shared/retained.ts): `fleet doctor` reads it to say *why* the daemon is
 * unreachable instead of relaying ECONNREFUSED. Tolerant reads, no schema —
 * this never crosses a wire.
 */
export type TunnelRecord = {
  port: number;
  /** pid of the supervising `fleet connect`, so doctor can say the session is gone. */
  pid: number;
  /** Endpoint the live session forwards to; compared against the current one. */
  endpointId: string;
  /** Where the deployment was resolved from. */
  source: string;
  at: string;
};

export function tunnelRecordPath(home: string, port: number): string {
  return path.join(home, 'tunnels', `${port}.json`);
}

export function writeTunnelRecord(home: string, record: TunnelRecord): void {
  const file = tunnelRecordPath(home, record.port);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

export function readTunnelRecord(home: string, port: number): TunnelRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(tunnelRecordPath(home, port), 'utf8')) as TunnelRecord;
    if (typeof parsed?.port !== 'number' || typeof parsed?.endpointId !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined; // absent or malformed — the same as no session on record
  }
}

/**
 * Drop the record for a port, but only if it is ours. A second `fleet connect`
 * on a port someone else already holds must not delete the live session's
 * record on its way out — that is precisely when doctor needs it.
 */
export function clearTunnelRecord(home: string, port: number, pid = process.pid): void {
  const record = readTunnelRecord(home, port);
  if (record !== undefined && record.pid !== pid) return;
  fs.rmSync(tunnelRecordPath(home, port), { force: true });
}

/** Every tunnel session on record for this FLEET_HOME, in port order. */
export function listTunnelRecords(home: string): TunnelRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(home, 'tunnels'));
  } catch {
    return []; // no tunnels directory — no sessions have ever been supervised here
  }
  const records: TunnelRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const record = readTunnelRecord(home, Number(name.slice(0, -'.json'.length)));
    if (record) records.push(record);
  }
  return records;
}

/** Is a recorded supervisor still alive? signal 0 probes without delivering. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------- supervision ----------

/** A running forward process, as the supervisor sees it. */
export type ForwardHandle = {
  /** Resolves — never rejects — when the forward exits, with a short description of how. */
  exited: Promise<ForwardExit>;
  /** Kill it (operator interrupt, or shutdown). */
  stop: () => void;
  pid?: number;
};

/** How a forward ended. */
export type ForwardExit = {
  /** One line, for the operator: exit code or signal, plus the last thing it said. */
  how: string;
  /**
   * True when the command never ran at all (not installed, not executable).
   * Reopening cannot fix that, so the supervisor stops instead of looping.
   */
  startFailed?: boolean;
};

export type SuperviseDeps = {
  /** Re-resolves the deployment's endpoint; called once per session. */
  open: TunnelOpener;
  spawnForward: (argv: string[]) => ForwardHandle;
  /** GET /health through the forward; true only on a 200. */
  probeHealth: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  /** True once the operator asked to stop; checked between sessions. */
  stopped: () => boolean;
  /** Called with the endpoint each time a session starts, for the tunnel record. */
  onSession?: (endpoint: TunnelEndpoint) => void;
};

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

/**
 * Poll /health until it answers, the forward dies, or the deadline passes.
 * The three outcomes are different things to say: `gone` means the forward
 * never got going, `silent` means it is up but nothing is serving behind it.
 */
async function waitForHealth(deps: SuperviseDeps, handle: ForwardHandle): Promise<'ok' | 'silent' | 'gone'> {
  let dead = false;
  const died = (): void => {
    dead = true;
  };
  void handle.exited.then(died, died);
  const deadline = deps.now() + HEALTH_TIMEOUT_MS;
  while (!dead && !deps.stopped() && deps.now() < deadline) {
    if (await deps.probeHealth()) return 'ok';
    await deps.sleep(HEALTH_INTERVAL_MS);
  }
  return dead ? 'gone' : 'silent';
}

/**
 * Hold the tunnel open until the operator stops it.
 *
 * One session per iteration, and every iteration re-resolves the endpoint: the
 * daemon task id changes on each service deployment, so a supervisor that
 * cached the first target would reopen forever against a container that no
 * longer exists. Backoff grows across consecutive failures and resets after a
 * session that stayed up, so a rolling deployment recovers on its own while a
 * genuinely broken deployment is not hammered.
 */
export async function superviseTunnel(localPort: number, deps: SuperviseDeps): Promise<void> {
  // Consecutive attempts that failed or died young. A session that stayed up
  // clears it, so the delay tracks "is this deployment broken right now",
  // not "how long has this tunnel been running".
  let failures = 0;
  const wait = (): number =>
    RECONNECT_BACKOFF_MS[Math.min(Math.max(failures - 1, 0), RECONNECT_BACKOFF_MS.length - 1)];

  while (!deps.stopped()) {
    let endpoint: TunnelEndpoint;
    try {
      endpoint = await deps.open(localPort);
    } catch (err) {
      failures += 1;
      deps.log(`cannot resolve the daemon endpoint: ${err instanceof Error ? err.message : String(err)}`);
      deps.log(`retrying in ${seconds(wait())}`);
      await deps.sleep(wait());
      continue;
    }

    // Resolving an endpoint is seconds of cloud calls, and the owner may have
    // quit during them. Spawning now would write a session record over the one
    // the stop just cleared, leave a detached forward holding the local port,
    // and then block on a handle nobody is left to kill.
    if (deps.stopped()) return;

    deps.log(`forwarding http://127.0.0.1:${localPort} → ${endpoint.id}`);
    deps.onSession?.(endpoint);
    const startedAt = deps.now();
    const handle = deps.spawnForward(endpoint.argv);
    const health = await waitForHealth(deps, handle);
    if (health === 'ok') {
      deps.log(`daemon /health ok on http://127.0.0.1:${localPort}`);
    } else if (health === 'silent' && !deps.stopped()) {
      deps.log(`warning: /health did not answer within ${seconds(HEALTH_TIMEOUT_MS)} — holding the session open anyway`);
    }

    const exit = await handle.exited;
    if (deps.stopped()) return;
    // Waiting cannot install a missing binary. Retrying to the 30s ceiling
    // forever would look like a flaky tunnel instead of a missing tool.
    if (exit.startFailed) throw new Error(exit.how);
    const lasted = deps.now() - startedAt;
    // A session that ran long enough to be useful is not evidence of a broken
    // deployment: only consecutive short-lived ones escalate the delay.
    failures = lasted >= HEALTHY_SESSION_MS ? 0 : failures + 1;
    deps.log(`session ended after ${seconds(lasted)} (${exit.how}) — reopening in ${seconds(wait())}`);
    await deps.sleep(wait());
  }
}

// ---------- live probes ----------

/**
 * Spawn the forward command, inheriting nothing: its chatter is ours to
 * summarise. Its own process group (`detached`), because the command is a
 * launcher — `aws ssm start-session` runs session-manager-plugin as a child, and
 * that plugin is what actually holds the local port. Signalling only the parent
 * orphans it, the port stays bound, and the next connect appears to work while
 * forwarding into a container that is gone.
 */
export function spawnForward(argv: string[]): ForwardHandle {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-500);
  });
  const { promise, resolve } = Promise.withResolvers<ForwardExit>();
  // Set on 'exit', not only 'close': the pid is reaped at 'exit', and 'close'
  // waits for stderr to drain after it. A stop() in between would signal a
  // process group id the kernel is already free to reuse.
  let closed = false;
  child.on('exit', () => {
    closed = true;
  });
  // 'close' rather than 'exit' for the result: stderr must be drained first.
  child.on('close', (code, signal) => {
    closed = true;
    const how = signal ? `killed by ${signal}` : `exit ${code ?? '?'}`;
    const detail = stderrTail.trim().split('\n').filter(Boolean).pop();
    resolve({ how: detail ? `${how}: ${detail}` : how });
  });
  child.on('error', (err) => {
    closed = true;
    resolve({ how: `could not start ${argv[0]}: ${err.message}`, startFailed: true });
  });
  // A stop after close must do nothing: the supervisor still holds the last
  // handle during a backoff wait, and by then the pid can belong to somebody
  // else — signalling a recycled process group is worse than doing nothing.
  const stop = (): void => {
    if (!closed) killTree(child, 'SIGTERM');
  };
  return { exited: promise, stop, pid: child.pid };
}

/** GET /health on the forwarded local port. True only on a 200. */
export async function probeDaemonHealth(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  try {
    const res = await request({ host, port, path: '/health', timeoutMs });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Does anything accept a TCP connection here? Distinguishes "no tunnel" from "dead far end". */
export function portAccepts(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = net.connect({ host, port });
  const finish = (open: boolean): void => {
    socket.destroy();
    resolve(open);
  };
  socket.setTimeout(timeoutMs, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  return promise;
}

// ---------- holding a tunnel, for whoever needs one ----------

/** A deployment resolved to the one thing a supervisor needs: how to open a forward, and where. */
export type ResolvedTunnel = {
  /** Re-resolves the endpoint and builds the forward command; called once per session. */
  open: TunnelOpener;
  /** The local port the forward binds — the one every other command must talk to. */
  localPort: number;
  /** Where the deployment description was read from, for messages and the record. */
  source: string;
};

/**
 * Resolve the deployment and decide which local port to forward. Split out
 * because two surfaces need it and neither may resolve twice: `fleet connect`
 * warns and refuses before binding, and the cockpit holds a tunnel for as long
 * as its view is open (#61). Resolution can cost cloud calls, so it happens once.
 */
export async function resolveTunnel(cwd: string, port?: number): Promise<ResolvedTunnel> {
  const deployment = await resolveDeployment(cwd);
  const { open, remotePort } = tunnelOpenerFor(deployment);
  return { open, localPort: chooseLocalPort(port, deployment.daemonUrl, remotePort), source: deployment.source };
}

/** A supervised tunnel someone else owns the lifetime of. */
export type HeldTunnel = {
  port: number;
  /** Resolves when supervision ends: the Error it died of, or undefined if it was stopped. */
  ended: Promise<Error | undefined>;
  /**
   * Close the forward and drop the record, then wait for the child to actually
   * die. Idempotent, and safe to await more than once.
   */
  stop: () => Promise<void>;
};

/**
 * Hold a tunnel open without owning the process. The caller decides when it
 * ends — a signal for `fleet connect`, a closed view for the cockpit — which is
 * the whole difference between the two: the supervision, the tunnel record, and
 * the guarantee that the forward dies with its owner are identical, and live here.
 */
export function holdTunnel(
  tunnel: ResolvedTunnel,
  home: string,
  log: (line: string) => void,
): HeldTunnel {
  const localPort = tunnel.localPort;
  let stopping = false;
  let current: ForwardHandle | undefined;

  // The supervisor spends most of its life asleep in a backoff, and that timer
  // is deliberately not unref'd — for `fleet connect` it is the only thing
  // keeping the process alive. So stopping has to wake it: an owner that quits
  // during a 30s backoff would otherwise sit there until the timer fired.
  const waking = new Map<NodeJS.Timeout, () => void>();
  const wakeableSleep = (ms: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      waking.delete(timer);
      resolve();
    }, ms);
    waking.set(timer, resolve);
    return promise;
  };
  const wakeAll = (): void => {
    for (const [timer, resolve] of waking) {
      clearTimeout(timer);
      resolve();
    }
    waking.clear();
  };

  const ended = superviseTunnel(localPort, {
    open: tunnel.open,
    spawnForward: (argv) => {
      current = spawnForward(argv);
      return current;
    },
    probeHealth: () => probeDaemonHealth('127.0.0.1', localPort),
    sleep: wakeableSleep,
    now: () => Date.now(),
    log,
    stopped: () => stopping,
    onSession: (endpoint) =>
      writeTunnelRecord(home, {
        port: localPort,
        pid: process.pid,
        endpointId: endpoint.id,
        source: tunnel.source,
        at: new Date().toISOString(),
      }),
  }).then(
    () => undefined,
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  ).finally(() => {
    // Whatever ended it, the forward is a child process and the record claims a
    // live session: leaving either behind is what makes the next attempt look
    // like it worked while forwarding into nothing.
    current?.stop();
    clearTunnelRecord(home, localPort);
  });

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      stopping = true;
      wakeAll();
      const handle = current;
      handle?.stop();
      clearTunnelRecord(home, localPort);
      // Exiting before the forward dies orphans it, and an orphan is exactly
      // the thing that keeps the local port bound. Give it a bounded moment —
      // and drop the grace timer once it is done, so the wait cannot be the
      // slowest part of closing a view.
      if (handle) {
        await Promise.race([handle.exited, wakeableSleep(FORWARD_SHUTDOWN_MS)]);
        wakeAll();
      }
    })();
    return stopped;
  };

  return { port: localPort, ended, stop };
}

// ---------- the command ----------

export type ConnectOptions = {
  cwd: string;
  home: string;
  /** --port: force the local port instead of following daemon_url. */
  port?: number;
  /** --detach: hand the supervision loop to a background process and return. */
  detach: boolean;
  /** argv[0]-equivalent for re-spawning ourselves detached. */
  selfPath: string;
  log: (line: string) => void;
  warn: (line: string) => void;
};

/**
 * Open and hold the daemon tunnel. Foreground by default: the process is the
 * session, and Ctrl-C ends it. --detach re-spawns this same command in the
 * background so a shell can be closed without taking the tunnel with it.
 */
export async function runConnect(opts: ConnectOptions): Promise<number> {
  const tunnel = await resolveTunnel(opts.cwd, opts.port);
  const localPort = tunnel.localPort;

  // Forwarding somewhere other than where the rest of the CLI looks is a
  // legitimate thing to ask for and a silent way to strand every other command.
  // Compare against what `fleet status` would actually resolve — not against
  // this capture's own daemon_url — so FLEET_DAEMON_URL, and a daemon_url in a
  // different provider directory, are both caught.
  const target = daemonTarget(process.env, { cwd: opts.cwd });
  if (target.kind !== 'tcp') {
    opts.warn(
      `note: other fleet commands resolve the daemon at ${describeTarget(process.env, { cwd: opts.cwd })} — add "daemon_url": "http://127.0.0.1:${localPort}" to ${tunnel.source} so they use this tunnel`,
    );
  } else if (target.port !== localPort) {
    opts.warn(
      `warning: forwarding to port ${localPort}, but other fleet commands resolve the daemon at ${describeTarget(process.env, { cwd: opts.cwd })} — they will not use this tunnel`,
    );
  }

  // Something already holds this port. Our forward could not bind anyway: it
  // would die in milliseconds, and the health probe would then answer from
  // whatever is already there — so the supervisor would report green forever,
  // reopen on a loop, and rewrite the live session's record with its own pid.
  // The test is the port accepting connections, never the record: a
  // connect_hint tunnel opened by hand writes none, a SIGKILLed supervisor
  // leaves a serving orphan behind a dead one, and an orphan pointed at a
  // replaced task holds the port without answering /health at all.
  if (await portAccepts('127.0.0.1', localPort)) {
    const holder = readTunnelRecord(opts.home, localPort);
    const serving = (await probeDaemonHealth('127.0.0.1', localPort)) ? 'and answers /health' : 'but does not answer /health';
    const whose =
      holder && pidAlive(holder.pid)
        ? `a fleet connect session (pid ${holder.pid}, forwarding to ${holder.endpointId}) — stop it with \`kill ${holder.pid}\``
        : 'something else — `fleet doctor` reports what is there';
    throw new Error(`port ${localPort} is already taken ${serving}, by ${whose}; or pick another port with --port`);
  }

  if (opts.detach) {
    const logPath = path.join(opts.home, `connect-${localPort}.log`);
    fs.mkdirSync(opts.home, { recursive: true });
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [opts.selfPath, 'connect', '--port', String(localPort)], {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
    opts.log(`fleet connect: supervising in the background (pid ${child.pid}) — log: ${logPath}`);
    opts.log(`fleet connect: stop it with: kill ${child.pid}`);
    return 0;
  }

  opts.log(`fleet connect: deployment from ${tunnel.source}`);
  const held = holdTunnel(tunnel, opts.home, (line) => opts.log(`fleet connect: ${line}`));

  let closing = false;
  const stop = (): void => {
    if (closing) process.exit(0); // a second interrupt means now, not politely
    closing = true;
    opts.log('fleet connect: closing the tunnel');
    void held.stop().then(() => process.exit(0));
  };
  // SIGHUP matters for --detach: a closed terminal is how that supervisor most
  // often dies, and it must take its forward with it.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);

  // Waiting cannot install a missing binary: superviseTunnel gives up on a
  // forward command that never ran, and this is the process that reports it.
  const failure = await held.ended;
  if (failure) throw failure;
  return 0;
}

// ---------- doctor: tunnel state ----------

export type TunnelReport = {
  /** Lines for stdout: the tunnel is fine and this says so. */
  notes: string[];
  /** Lines for stderr: doctor findings. */
  findings: string[];
};

/**
 * What doctor says about the tunnel. Three questions, in the order that
 * distinguishes the causes an operator would otherwise have to guess between:
 * is anything listening on the local port, does the daemon answer /health
 * through it, and is the endpoint it forwards to still the current one.
 *
 * `resolveEndpoint` is best-effort — it costs cloud API calls, so it runs only
 * once something is already wrong. A failure to answer the third question is a
 * note, never a finding: not knowing is not a defect. It is asked with or
 * without a session on record, because a `connect_hint` tunnel opened by hand
 * writes no record and is exactly the one that silently outlives a redeployment.
 */
export async function tunnelReport(opts: {
  host: string;
  port: number;
  url: string;
  home: string;
  resolveEndpoint?: () => Promise<string>;
}): Promise<TunnelReport> {
  const notes: string[] = [];
  const findings: string[] = [];
  const record = readTunnelRecord(opts.home, opts.port);

  if (await probeDaemonHealth(opts.host, opts.port)) {
    notes.push(`tunnel: daemon /health ok at ${opts.url}`);
    if (record) notes.push(`tunnel: session pid ${record.pid} forwards to ${record.endpointId}`);
    return { notes, findings };
  }

  const listening = await portAccepts(opts.host, opts.port);
  if (listening) {
    findings.push(
      `tunnel: port ${opts.port} accepts connections but the daemon did not answer /health at ${opts.url} — the forward is open onto a task that is gone or not serving`,
    );
  } else {
    findings.push(`tunnel: nothing is listening on ${opts.url} — open it with: fleet connect`);
  }

  if (record) {
    findings.push(
      pidAlive(record.pid)
        ? `tunnel: a fleet connect session is running (pid ${record.pid}, opened ${record.at}) but is not serving — check its output`
        : `tunnel: the last fleet connect session (pid ${record.pid}, opened ${record.at}) is gone — reopen it with: fleet connect`,
    );
  } else {
    // A supervisor on another port is not this port's problem, but it is the
    // difference between "no tunnel" and "you connected to the wrong one".
    for (const other of listTunnelRecords(opts.home)) {
      if (other.port !== opts.port && pidAlive(other.pid)) {
        notes.push(
          `tunnel: a fleet connect session is running on port ${other.port} (pid ${other.pid}) — this checkout's daemon_url points at ${opts.port}`,
        );
      }
    }
  }

  if (opts.resolveEndpoint) {
    try {
      const current = await opts.resolveEndpoint();
      if (!record) {
        // Nothing to compare against — a hand-opened forward records nothing.
        // Only claim a stale forward when something is actually listening;
        // otherwise this is just the current address, for whoever opens one.
        notes.push(
          listening
            ? `tunnel: the daemon task is currently ${current} — a forward opened before the last deployment points elsewhere`
            : `tunnel: the daemon task is currently ${current} — open a forward to it with: fleet connect`,
        );
      } else if (current !== record.endpointId) {
        findings.push(
          `tunnel: the recorded forward points at ${record.endpointId} but the daemon task is now ${current} — the service was redeployed; fleet connect re-resolves it`,
        );
      } else {
        notes.push(`tunnel: recorded endpoint ${record.endpointId} is still the current daemon task`);
      }
    } catch (err) {
      notes.push(
        `tunnel: could not check whether the daemon task is current: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { notes, findings };
}
