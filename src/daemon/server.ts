// Fleet daemon HTTP server. Operator endpoints trust socket permissions;
// runner endpoints trust the per-job X-Fleet-Runner-Token. Every event is
// schema-validated at intake; reject, never coerce.
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { validateManifest, validateWorkOrder, validateEvent } from "../validate.mjs";
import { readBody, sendJson } from "../shared/http.ts";
import { parseNdjson } from "../shared/ndjson.ts";
import { stableStringify } from "../shared/json.ts";
import { newId, newRunnerToken } from "../shared/ids.ts";
import { operatorTokenPath, socketPath, daemonLockPath, artifactDir, ARTIFACT_PER_FILE_CAP, ARTIFACT_TOTAL_CAP } from "../shared/home.ts";
import { parseDurationMs, idleLimitMs, toMinutes, DEFAULT_BACKSTOP_MARGIN_MS } from "../shared/time.ts";
import { Registry } from "./registry.ts";
import { HomeLock } from "./lock.ts";
import type { EffectsMode, JobRecord, OpenDecision, StoredEvent } from "./registry.ts";
import { canTransition, isMarkerAllowed, isTerminal } from "./state.ts";
import type { JobState, Marker } from "./state.ts";
import { verifyRung } from "./verify.ts";
import type { Provider } from "../providers/provider.ts";

/**
 * Prefix of the log note the runner posts when a work push failed and the
 * workspace is retained (issue #38). The daemon uses it to suppress the
 * clean-settle container reap: a retained workspace keeps its stopped
 * container so `fleet resume-push` can retry the push from inside it.
 */
const RETAINED_WORKSPACE_NOTE_PREFIX = "workspace retained at";

/** Blocked-first ordering: anything waiting on the operator sorts first. */
export const RANK: Record<JobState, number> = {
  blocked: 0,
  running: 1,
  queued: 2,
  done: 3,
  cancelled: 4,
};

export type DaemonOptions = {
  home: string;
  provider: Provider;
  /**
   * TCP listener port when set (0 = ephemeral, for tests/providers).
   * Bind interface is tcpHost (default 127.0.0.1).
   */
  port?: number;
  /**
   * IP/host to bind the TCP listener on.  Default 127.0.0.1.
   * Set to 0.0.0.0 in containers so the daemon is reachable on any interface.
   */
  bindHost?: string;
  /**
   * IP/host to advertise in daemonUrl so runner tasks know where to connect.
   * Defaults to bindHost.  In ECS set this to the container's private VPC IP
   * (auto-discovered from ECS container metadata in main.ts) so runner tasks
   * can reach the daemon even when bindHost is 0.0.0.0.
   */
  tcpHost?: string;
  /**
   * Operator secret required on every /jobs/* route of BOTH listeners (issue
   * #133). Compared constant-time against the x-fleet-operator-token header.
   * The daemon entrypoint loads-or-creates it at $FLEET_HOME/operator-token
   * (mode 0600) via loadOrCreateOperatorToken. Undefined disables enforcement
   * (direct class use in tests only — the real daemon always configures it).
   */
  operatorToken?: string;
  /** Long-poll window for follow/answer endpoints; default 25s. */
  longPollMs?: number;
  /**
   * Decision-notification webhooks; default FLEET_NOTIFY_WEBHOOK (comma-separated
   * URLs). Payload is {text}; Slack accepts it natively, anything else can front
   * it with a relay. Optional: with no webhook, blocked jobs surface via
   * `fleet status` (blocked-first) — the pull loop needs no channel at all.
   */
  notifyWebhooks?: string[];
  /**
   * Extra ms the daemon adds to the wall_clock limit before triggering its
   * backstop (terminate + synthesise events). Default: 90_000 (90s). Must be
   * large enough for the runner to SIGTERM + grace + settle before the daemon
   * fires. Set smaller in tests.
   */
  wallClockBackstopMarginMs?: number;
  /**
   * How often (ms) the daemon scans for overdue jobs (wall-clock, stall,
   * decision-timeout). Default: 10_000. Set smaller in tests.
   */
  wallClockSweepIntervalMs?: number;
  /**
   * Extra ms the daemon adds to the idle threshold before triggering the stall
   * backstop (issue #39). Default: 90_000 (90s) — the runner is the primary
   * enforcer, and this margin must leave it room to SIGTERM, push, and settle.
   */
  idleBackstopMarginMs?: number;
};

type IntakeError = { status: number; errors: unknown[] };
type IntakeResult = IntakeError | { deduped: true } | null;

/** Wire shape for operator responses: the runner token never leaves the daemon. */
function publicJob(record: JobRecord): Omit<JobRecord, "runnerToken"> {
  const { runnerToken, ...rest } = record;
  return rest;
}

/** Optional {NAME: value} maps from the operator (env, sync). Throws on any non-string value. */
function stringRecord(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} must be an object of string values`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${what}.${key} must be a string`);
  }
  // Every entry checked above.
  return value as Record<string, string>;
}

/**
 * gh CLI runner for rung verification. If gh is absent or the call fails,
 * verifyRung catches the thrown error and records it as "gh error: ..." in
 * the doneCheck notes — no special treatment needed here.
 */
function defaultGhRunner(): import("./verify.ts").GhRunner {
  return (args: string[]) =>
    execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Default long-poll window for follow/answer endpoints. Exported so tests can
 * pin every client-side timeout above it: a healthy long-poll transfers no
 * bytes for this whole window, and an idle timeout at or below it would
 * destroy the request mid-poll instead of letting the daemon answer.
 */
export const DEFAULT_LONG_POLL_MS = 25_000;

/** Target rung from a work order already validated at job creation. */
function targetRung(workOrder: unknown): string {
  if (workOrder && typeof workOrder === "object" && "finish" in workOrder) {
    const finish = workOrder.finish;
    if (typeof finish === "string") return finish;
  }
  return "implemented";
}

/**
 * Load the boot-generated operator secret, creating it on first boot (issue
 * #133). Persisted at $FLEET_HOME/operator-token mode 0600 so the CLI (local,
 * or remote over an SSM tunnel) can attach it to /jobs/* requests without the
 * secret ever appearing in argv or env. An existing non-empty file wins so
 * restarts don't invalidate tokens already held by cockpits and tunnels.
 */
export function loadOrCreateOperatorToken(home: string): string {
  const path = operatorTokenPath(home);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") return existing;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export class FleetDaemon {
  readonly registry: Registry;
  readonly #options: DaemonOptions;
  readonly #longPollMs: number;
  readonly #sockPath: string;
  /** IP/host to bind the TCP listener on. */
  readonly #bindHost: string;
  /** IP/host to advertise in daemonUrl to runner tasks. */
  readonly #tcpHost: string;
  /** Operator secret gating /jobs/*; undefined = enforcement off (tests only). */
  readonly #operatorToken: string | undefined;
  #unixServer: Server | null = null;
  #tcpServer: Server | null = null;
  #port: number | null = null;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Jobs with a backstop cancellation in flight. Two sweeps run per tick and
   * `provider.terminate` is awaited, so without this the same job can be
   * cancelled twice — two settles and a cancelled → cancelled pair in the log,
   * which appendEvent has no state machine to refuse.
   */
  readonly #backstopping = new Set<string>();

  /** Single-writer claim on $FLEET_HOME; held for the daemon's whole life. */
  readonly #lock: HomeLock;

  constructor(options: DaemonOptions) {
    this.#options = options;
    this.#longPollMs = options.longPollMs ?? DEFAULT_LONG_POLL_MS;
    this.#sockPath = socketPath(options.home);
    this.#bindHost = options.bindHost ?? "127.0.0.1";
    // tcpHost defaults to bindHost so a simple `port: 0` test still works.
    this.#tcpHost = options.tcpHost ?? this.#bindHost;
    this.#operatorToken = options.operatorToken;
    mkdirSync(options.home, { recursive: true });
    // Claim the home BEFORE the registry opens it (issue #112). Loading is not
    // read-only — it quarantines torn job dirs and reconciliation rewrites
    // job.json — so a lock taken later in start() would refuse only after this
    // process had already written into a live daemon's home.
    this.#lock = new HomeLock(options.home, daemonLockPath(options.home));
    this.#lock.acquire();
    try {
      this.registry = new Registry(options.home);
      // Wire the effects function so the registry can replay events at boot
      // for log-authoritative reconciliation (issue #113).
      this.registry.setApplyEffectsFn((job, event, mode) => this.#applyEffects(job, event, mode));
      // Reconcile any non-terminal jobs whose card disagrees with the journal.
      this.registry.reconcileAll();
    } catch (error) {
      this.#lock.release();
      throw error;
    }
  }
  /** URL the runner uses to reach this daemon (TCP preferred when enabled). */
  get daemonUrl(): string {
    if (this.#port !== null) return `http://${this.#tcpHost}:${this.#port}`;
    return `unix:${this.#sockPath}`;
  }

  get port(): number | null {
    return this.#port;
  }

  async start(): Promise<{ socketPath: string; port: number | null }> {
    // The home was claimed in the constructor (issue #112) — by the time the
    // socket is unlinked, no other daemon can be serving from this home.
    if (existsSync(this.#sockPath)) unlinkSync(this.#sockPath);
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.#route(req, res).catch((error: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(error) });
        else res.end();
      });
    };
    this.#unixServer = http.createServer(handler);
    const unixListening = Promise.withResolvers<void>();
    this.#unixServer.listen(this.#sockPath, unixListening.resolve);
    await unixListening.promise;

    if (this.#options.port !== undefined) {
      this.#tcpServer = http.createServer(handler);
      const tcpListening = Promise.withResolvers<void>();
      this.#tcpServer.listen(this.#options.port, this.#bindHost, tcpListening.resolve);
      await tcpListening.promise;
      const address = this.#tcpServer.address();
      this.#port = typeof address === "object" && address !== null ? address.port : null;
    }

    // Recover the crash-window states no sweep reaches (#115) before the
    // sweeps arm. After the listeners are up, deliberately: a recovery
    // re-launch advertises daemonUrl, which needs the TCP port bound.
    await this.#bootRecover();

    // Combined sweep: wall-clock and stall backstops, decision-timeout (stale) marking.
    const sweepMs = this.#options.wallClockSweepIntervalMs ?? 10_000;
    this.#sweepTimer = setInterval(() => {
      this.#wallClockSweep();
      this.#idleSweep();
      this.#decisionTimeoutSweep();
    }, sweepMs);
    this.#sweepTimer.unref(); // don't prevent process exit

    return { socketPath: this.#sockPath, port: this.#port };
  }

  async stop(): Promise<void> {
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    const servers = [this.#unixServer, this.#tcpServer].filter((server) => server !== null);
    await Promise.all(
      servers.map((server) => {
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        server.closeAllConnections();
        return closed.promise;
      }),
    );
    this.#unixServer = null;
    this.#tcpServer = null;
    this.#port = null;
    this.#lock.release();
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fleet.invalid");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter((part) => part.length > 0);

    // Operator: POST /jobs | GET /jobs | GET /jobs/:id | events/answer/cancel
    // Every /jobs/* route requires the operator secret on BOTH listeners (issue
    // #133): the TCP listener is reachable from job containers in remote
    // deployments, so socket-permission trust would not hold there. /health
    // stays open; /internal/* keeps its own per-job token.
    if (parts[0] === "jobs") {
      if (!this.#operatorAuthorized(req)) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      if (parts.length === 1 && method === "POST") return this.#createJob(req, res);
      if (parts.length === 1 && method === "GET") {
        const jobs = this.registry
          .listJobs()
          .sort((a, b) => RANK[a.state] - RANK[b.state] || a.createdAt.localeCompare(b.createdAt))
          .map(publicJob);
        return sendJson(res, 200, { jobs });
      }
      const job = this.registry.getJob(parts[1] ?? "");
      if (!job) return sendJson(res, 404, { error: `unknown job: ${parts[1]}` });
      if (parts.length === 2 && method === "GET") return sendJson(res, 200, { job: publicJob(job) });
      if (parts.length === 3 && parts[2] === "events" && method === "GET") {
        return this.#streamEvents(job, url, res);
      }
      if (parts.length === 3 && parts[2] === "answer" && method === "POST") {
        return this.#answer(job, req, res);
      }
      if (parts.length === 3 && parts[2] === "cancel" && method === "POST") {
        return this.#cancel(job, res);
      }
      // Artifact lane (issue #18): list and fetch delivered artifacts.
      if (parts[2] === "artifacts" && method === "GET") {
        if (parts.length === 3) return this.#listArtifacts(job, res);
        const artPath = parts.slice(3).map(decodeURIComponent).join("/");
        return this.#getArtifact(job, artPath, res);
      }
    }

    // Runner: POST /internal/jobs/:id/events | GET /internal/jobs/:id/answer
    //         POST /internal/jobs/:id/artifacts
    if (parts[0] === "internal" && parts[1] === "jobs" && parts.length === 4) {
      // Unknown id and bad token answer identically (issue #133): a
      // distinguishable 404 would let a token holder probe which job ids exist.
      const job = this.registry.getJob(parts[2]);
      if (!job || !this.#runnerAuthorized(req, job)) {
        return sendJson(res, 401, { error: "invalid runner token" });
      }
      if (parts[3] === "events" && method === "POST") return this.#intakeEvents(job, req, res);
      if (parts[3] === "answer" && method === "GET") return this.#answerPoll(job, url, res);
      if (parts[3] === "artifacts" && method === "POST") return this.#receiveArtifact(job, req, res);
    }

    // Health check: GET /health — answers without any state; used by the daemon
    // Dockerfile HEALTHCHECK and by operators verifying the service is up.
    if (url.pathname === "/health" && method === "GET") {
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: `no route: ${method} ${url.pathname}` });
  }

  /** Constant-time check of the x-fleet-operator-token header against the boot secret. */
  #operatorAuthorized(req: IncomingMessage): boolean {
    if (this.#operatorToken === undefined) return true;
    const presented = req.headers["x-fleet-operator-token"];
    if (typeof presented !== "string") return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(this.#operatorToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  #runnerAuthorized(req: IncomingMessage, job: JobRecord): boolean {
    const presented = req.headers["x-fleet-runner-token"];
    if (typeof presented !== "string") return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(job.runnerToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async #createJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      return sendJson(res, 400, { error: `invalid JSON body: ${String(error)}` });
    }
    if (!body || typeof body !== "object") {
      return sendJson(res, 400, { error: "body must be a JSON object" });
    }
    const manifest = "manifest" in body ? body.manifest : undefined;
    const workOrder = "workOrder" in body ? body.workOrder : undefined;
    // Ajv boundary: validate.mjs returns ajv ErrorObject[] (instancePath, message, ...).
    const ajvErrors = (errors: unknown[]) => errors as ({ instancePath?: string; message?: string } & Record<string, unknown>)[];
    const manifestCheck = validateManifest(manifest);
    const orderCheck = validateWorkOrder(workOrder);
    if (!manifestCheck.ok || !orderCheck.ok) {
      return sendJson(res, 422, {
        errors: [
          ...ajvErrors(manifestCheck.errors).map((error) => ({ in: "manifest", ...error })),
          ...ajvErrors(orderCheck.errors).map((error) => ({ in: "workOrder", ...error })),
        ],
      });
    }
    let env: Record<string, string>;
    let sync: Record<string, string>;
    try {
      env = stringRecord("env" in body ? body.env : undefined, "env");
      sync = stringRecord("sync" in body ? body.sync : undefined, "sync");
    } catch (error) {
      return sendJson(res, 422, { errors: [{ instancePath: "", message: String(error) }] });
    }
    // Optional image override: when the CLI has pre-built the per-repo job
    // image (two-layer model, issue #5), it passes the computed tag here so
    // the daemon does not need to inspect the manifest setup section.
    const imageOverride = "image" in body && typeof body.image === "string"
      ? body.image
      : undefined;
    // Schema-validated above: work order requires mode + target strings.
    const order = workOrder as { mode: string; target: string };
    // Schema-validated above: manifest setup.image is an optional string;
    // limits.resources is an optional object with integer cpu/memory/disk.
    const manifestDoc = manifest as { setup?: { image?: string }; limits?: { resources?: { cpu?: number; memory?: number; disk?: number } } };
    const resources = manifestDoc.limits?.resources;

    // Dispatch-time resource check: reject before creating a job record if the
    // request cannot be served by any offered capacity tier.  This prevents
    // jobs queuing forever against capacity that can never satisfy them.
    if (resources && this.#options.provider.checkResources) {
      try {
        this.#options.provider.checkResources(resources);
      } catch (error) {
        return sendJson(res, 422, { errors: [{ instancePath: "/limits/resources", message: String(error) }] });
      }
    }

    const id = newId("job");
    const now = new Date().toISOString();
    const record: JobRecord = {
      id,
      state: "queued",
      workOrder,
      createdAt: now,
      updatedAt: now,
      provider: this.#options.provider.name,
      runnerToken: newRunnerToken(),
    };
    this.registry.createJob(record);
    this.registry.appendEvent(id, {
      type: "state",
      state: "queued",
      meta: {
        kind: "delegated",
        label: `${order.mode}: ${order.target}`,
        target: order.target,
        where: this.#options.provider.name,
        fleet: [],
      },
    });

    // Initialise wall-clock, stall, and decision-timeout backstop tracking.
    const manifestLimits = (manifest as Record<string, unknown>).limits;
    // Stall detection is always armed — idleLimitMs supplies the default when
    // the manifest declares no limits block at all.
    this.registry.initIdle(id, idleLimitMs(manifestLimits));
    if (manifestLimits && typeof manifestLimits === "object") {
      const limits = manifestLimits as Record<string, unknown>;
      const wallClockStr = limits.wall_clock;
      if (typeof wallClockStr === "string") {
        const limitMs = parseDurationMs(wallClockStr);
        if (limitMs !== undefined) this.registry.initWallClock(id, limitMs);
      }
      const decisionTimeoutStr = limits.decision_timeout;
      if (typeof decisionTimeoutStr === "string") {
        const limitMs = parseDurationMs(decisionTimeoutStr);
        if (limitMs !== undefined) this.registry.initDecisionTimeout(id, limitMs);
      }
    }

    // Store launch details for potential re-entry after parking (issue #6).
    this.registry.storeLaunchDetails(id, {
      manifest,
      env,
      sync,
      image: imageOverride,
    });

    try {
      const { handle } = await this.#options.provider.launch({
        jobId: id,
        daemonUrl: this.daemonUrl,
        runnerToken: record.runnerToken,
        image: imageOverride ?? manifestDoc.setup?.image,
        env,
        sync,
        manifest,
        workOrder,
        resources,
      });
      const updated = this.registry.updateJob(id, { handle });
      return sendJson(res, 201, { job: publicJob(updated) });
    } catch (error) {
      this.registry.appendEvent(id, { type: "state", state: "cancelled", reason: "launch-failed" });
      const updated = this.registry.updateJob(id, { state: "cancelled", reason: "launch-failed" });
      return sendJson(res, 500, { error: `launch failed: ${String(error)}`, job: publicJob(updated) });
    }
  }

  async #streamEvents(job: JobRecord, url: URL, res: ServerResponse): Promise<void> {
    const afterParam = Number(url.searchParams.get("after") ?? "-1");
    const after = Number.isFinite(afterParam) ? afterParam : -1;
    const follow = url.searchParams.get("follow") === "1";
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const event of this.registry.eventsAfter(job.id, after)) {
      res.write(`${JSON.stringify(event)}\n`);
    }
    if (!follow) {
      res.end();
      return;
    }
    const done = Promise.withResolvers<void>();
    const onEvent = (jobId: string, event: StoredEvent) => {
      if (jobId === job.id && event.seq > after) res.write(`${JSON.stringify(event)}\n`);
    };
    const finish = () => {
      clearTimeout(timer);
      this.registry.off("event", onEvent);
      res.end();
      done.resolve();
    };
    const timer = setTimeout(finish, this.#longPollMs);
    this.registry.on("event", onEvent);
    res.on("close", finish);
    return done.promise;
  }

  async #answer(job: JobRecord, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Cheap pre-checks so an obviously wrong answer fails before the body is
    // read. NOT the real gate: readBody yields the event loop, and a cancel or
    // a concurrent answer can complete while the body streams (#114).
    if (job.state !== "blocked") {
      return sendJson(res, 409, { error: `job is ${job.state}, not blocked` });
    }
    if (!this.registry.openDecision(job.id)) {
      return sendJson(res, 409, { error: "job is blocked but has no open decision" });
    }
    const answer = await this.#readAnswerBody(req, res);
    if (answer === null) return;
    // Re-check after the await (#114). Everything from here to the claim below
    // is synchronous — that is what makes the claim atomic under concurrency.
    const current = this.registry.getJob(job.id);
    if (!current || current.state !== "blocked") {
      return sendJson(res, 409, { error: `job is ${current?.state ?? "gone"}, not blocked` });
    }
    const decision = this.registry.openDecision(job.id);
    if (!decision) {
      return sendJson(res, 409, { error: "job is blocked but has no open decision" });
    }
    const invalid = FleetDaemon.#validateAnswer(decision, answer);
    if (invalid !== null) return sendJson(res, 422, invalid);
    // Claim the decision: append the answer (journal first — it is the durable
    // fact every recovery rests on) and consume the open decision before any
    // further await. A concurrent second answer re-checks above and gets 409;
    // without the claim both would pass and a parked job would launch twice.
    this.registry.appendEvent(job.id, {
      type: "answer",
      decision: decision.id,
      ...(answer.option !== undefined ? { option: answer.option } : {}),
      ...(answer.text !== undefined ? { text: answer.text } : {}),
      by: "operator",
    });
    this.registry.setOpenDecision(job.id, null);
    this.registry.setDecisionBlockedAt(job.id, null);

    // Parked (or stale) job: the old runner has already exited — re-entry.
    if (current.marker === "parked" || current.marker === "stale") {
      return this.#answerParked(current, { decisionId: decision.id, answer }, res);
    }
    return this.#answerHot(current, res);
  }

  /**
   * Parse and shape-check an answer body. Sends the 400/422 itself and returns
   * null when the body is unusable. Decision-dependent validation stays in
   * #answer, against the decision that is open AFTER the body await — the one
   * the answer will actually claim.
   */
  async #readAnswerBody(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ option?: string; text?: string } | null> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      sendJson(res, 400, { error: `invalid JSON body: ${String(error)}` });
      return null;
    }
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "body must be a JSON object" });
      return null;
    }
    const option = "option" in body ? body.option : undefined;
    const text = "text" in body ? body.text : undefined;
    if (option !== undefined && typeof option !== "string") {
      sendJson(res, 422, { error: "option must be a string" });
      return null;
    }
    if (text !== undefined && typeof text !== "string") {
      sendJson(res, 422, { error: "text must be a string" });
      return null;
    }
    return {
      ...(option !== undefined ? { option } : {}),
      ...(text !== undefined ? { text } : {}),
    };
  }

  /** Decision-dependent answer validation; returns the 422 payload or null. */
  static #validateAnswer(
    decision: OpenDecision,
    answer: { option?: string; text?: string },
  ): Record<string, unknown> | null {
    // An invalid option id is an error, never silently downgraded to free text.
    if (answer.option !== undefined && !decision.optionIds.includes(answer.option)) {
      return {
        error: `option "${answer.option}" does not match the open decision`,
        options: decision.optionIds,
      };
    }
    if (answer.option === undefined && (answer.text === undefined || answer.text.length === 0)) {
      return { error: "answer requires an option id or free text" };
    }
    return null;
  }

  /** Re-entry response path: relaunch with the answer; 500-and-cancel on failure. */
  async #answerParked(
    job: JobRecord,
    reentry: { decisionId: string; answer: { option?: string; text?: string } },
    res: ServerResponse,
  ): Promise<void> {
    try {
      const updated = await this.#launchReentry(job, reentry);
      if (updated === null) {
        // The job went terminal while the container launched (#114): the fresh
        // container is already terminated; do not resurrect the record.
        const after = this.registry.getJob(job.id);
        return sendJson(res, 409, { error: `job is ${after?.state ?? "gone"}, no longer answerable` });
      }
      return sendJson(res, 200, { job: publicJob(updated) });
    } catch (error) {
      // Re-launch failed: the old runner is dead and no new one is starting.
      // Cancel the job so it reaches a terminal state the operator can reason
      // about — leaving it in blocked with no runner and no marker would make
      // it permanently unrecoverable without manual intervention.
      this.#cancelAfterFailedRelaunch(job.id, error);
      return sendJson(res, 500, { error: `re-launch failed: ${String(error)}` });
    }
  }

  /**
   * Hot job: the existing runner is still alive and polling for its answer.
   * The blocked → running transition happens here, and it lands in the journal
   * as a daemon-authored state event (#114): replaying the log alone must
   * reconstruct the one transition the daemon itself performs. Should the
   * runner turn out to be mid-park rather than polling (#151's gap), its late
   * blocked/parked event still lands — running → blocked is legal — and the
   * answered-park recovery re-launches with this answer.
   */
  #answerHot(job: JobRecord, res: ServerResponse): void {
    const stored = this.registry.appendEvent(job.id, { type: "state", state: "running" });
    this.#applyEffects(job, stored, "intake");
    const updated = this.registry.getJob(job.id) ?? job;
    return sendJson(res, 200, { job: publicJob(updated) });
  }

  /**
   * Launch a fresh container for a blocked job whose runner has exited, with
   * the operator's answer pre-materialised so the status-driven harness picks
   * up where it left off. Shared by the parked/stale answer path, the
   * answered-park recovery (#151), and boot recovery (#115). The state stays
   * blocked until the new runner emits state:running (blocked → running is a
   * valid transition). The runner seq resets so the fresh container starts at 0.
   *
   * Ordering is the crash-window contract (#115): the rotated runner token is
   * persisted BEFORE provider.launch, so a crash after the container started
   * leaves a record whose token still matches it, and boot recovery can finish
   * the re-entry instead of stranding a container it cannot authenticate.
   *
   * Returns null when the job went terminal during the launch — the fresh
   * container is terminated and the terminal record left alone (#114).
   */
  async #launchReentry(
    job: JobRecord,
    reentry: { decisionId: string; answer: { option?: string; text?: string } },
  ): Promise<JobRecord | null> {
    this.registry.clearMarker(job.id);
    this.registry.resetRunnerSeq(job.id);
    const newToken = newRunnerToken();
    this.registry.updateJob(job.id, { runnerToken: newToken });
    const details = this.registry.getLaunchDetails(job.id);
    // Derive resources from the stored manifest so the provider can apply
    // any resource overrides declared in manifest.limits.resources.
    const storedManifest = details.manifest as { limits?: { resources?: { cpu?: number; memory?: number; disk?: number } } };
    const { handle } = await this.#options.provider.launch({
      jobId: job.id,
      daemonUrl: this.daemonUrl,
      runnerToken: newToken,
      image: details.image,
      env: details.env,
      sync: details.sync,
      manifest: details.manifest,
      workOrder: job.workOrder,
      resources: storedManifest?.limits?.resources,
      reentryAnswer: reentry,
      // Seed the new runner's decision counter past prior ids (issue #110).
      reentryDecisionSeed: this.registry.decisionSeed(job.id),
    });
    // Re-check after the await (#114): a cancel that completed while the
    // container launched has already settled the job — terminate the fresh
    // container rather than hanging a live handle on a terminal record.
    const after = this.registry.getJob(job.id);
    if (!after || isTerminal(after.state)) {
      this.#options.provider.terminate(handle).catch(() => {});
      return null;
    }
    return this.registry.updateJob(job.id, { handle });
  }

  /** A failed re-entry launch ends the job loudly instead of stranding it blocked. */
  #cancelAfterFailedRelaunch(jobId: string, error: unknown): void {
    const current = this.registry.getJob(jobId);
    if (!current || isTerminal(current.state)) return;
    this.registry.appendEvent(jobId, {
      type: "log",
      text: `re-launch failed after answer: ${String(error)}`,
      who: "daemon",
    });
    this.registry.appendEvent(jobId, { type: "state", state: "cancelled", reason: "launch-failed" });
    this.registry.updateJob(jobId, { state: "cancelled", reason: "launch-failed" });
  }

  /**
   * The re-entry a job's journal says it is owed: its most recent decision and
   * the operator answer recorded for it. Null when there is no decision or the
   * last one is unanswered. This is the durable fact both recoveries rest on —
   * #answer appends the answer event BEFORE consuming the open decision, so
   * any state where the decision is gone has the answer in the journal.
   */
  #answeredPendingReentry(jobId: string): { decisionId: string; answer: { option?: string; text?: string } } | null {
    const events = this.registry.eventsAfter(jobId, -1);
    let decisionId: string | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === "decision") {
        decisionId = String(events[i]!.id);
        break;
      }
    }
    if (decisionId === null) return null;
    const answer = this.registry.findAnswer(jobId, decisionId);
    if (!answer) return null;
    return {
      decisionId,
      answer: {
        ...(typeof answer.option === "string" ? { option: answer.option } : {}),
        ...(typeof answer.text === "string" ? { text: answer.text } : {}),
      },
    };
  }

  /**
   * The marker gap (#151): the runner stops its answer poll, pushes WIP, and
   * only then emits blocked/parked — an answer landing in that window takes
   * the hot path against a runner that is already gone. The park event is the
   * daemon's liveness fact: a park arriving with no open decision means the
   * runner parked on a question the operator has already answered, so finish
   * the re-entry the runner never collected. Deferred with setImmediate so the
   * recovery runs outside the intake batch that delivered the park event.
   */
  #maybeRecoverAnsweredPark(job: JobRecord, nextState: JobState, marker: Marker | undefined): void {
    if (nextState !== "blocked" || marker !== "parked") return;
    if (this.registry.openDecision(job.id) !== null) return;
    setImmediate(() => {
      this.#recoverAnsweredPark(job).catch(() => {});
    });
  }

  /** The answered-park recovery's actual work; re-checks, then re-launches. */
  async #recoverAnsweredPark(job: JobRecord): Promise<void> {
    const current = this.registry.getJob(job.id);
    if (!current || current.state !== "blocked") return;
    if (this.registry.openDecision(job.id) !== null) return;
    const pending = this.#answeredPendingReentry(job.id);
    if (pending === null) return;
    this.registry.appendEvent(job.id, {
      type: "log",
      text: `runner parked after decision ${pending.decisionId} was answered; re-launching with the answer`,
      who: "daemon",
    });
    try {
      await this.#launchReentry(current, pending);
    } catch (error) {
      this.#cancelAfterFailedRelaunch(job.id, error);
    }
  }

  async #cancel(job: JobRecord, res: ServerResponse): Promise<void> {
    if (isTerminal(job.state)) {
      return sendJson(res, 409, { error: `job already ${job.state}` });
    }
    if (job.handle) {
      try {
        await this.#options.provider.terminate(job.handle);
      } catch (error) {
        this.registry.appendEvent(job.id, {
          type: "log",
          text: `terminate failed (continuing cancel): ${String(error)}`,
          who: "daemon",
        });
      }
    }
    // Re-check after async terminate (issue #113): a done/settle event may
    // have landed during the await. Copy #cancelFromBackstop's guard — a
    // done event landing during provider.terminate must not be overwritten
    // with cancelled.
    const afterTerminate = this.registry.getJob(job.id);
    if (!afterTerminate || isTerminal(afterTerminate.state)) {
      return sendJson(res, 409, { error: `job already ${afterTerminate?.state ?? "gone"}` });
    }
    this.registry.appendEvent(job.id, { type: "state", state: "cancelled", reason: "operator-cancel" });
    this.registry.setOpenDecision(job.id, null);
    this.registry.setDecisionBlockedAt(job.id, null);
    this.registry.clearMarker(job.id);
    const updated = this.registry.updateJob(job.id, { state: "cancelled", reason: "operator-cancel" });
    return sendJson(res, 200, { job: publicJob(updated) });
  }

  async #intakeEvents(job: JobRecord, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let claimedEvents: unknown[];
    try {
      claimedEvents = [JSON.parse(raw)];
    } catch {
      try {
        claimedEvents = parseNdjson(raw);
      } catch (error) {
        return sendJson(res, 400, { error: `body is neither JSON nor ndjson: ${String(error)}` });
      }
    }
    if (claimedEvents.length === 0) return sendJson(res, 400, { error: "empty event batch" });

    let appended = 0;
    let deduped = 0;
    for (const claimed of claimedEvents) {
      const result = this.#intakeOne(job, claimed);
      if (result && "status" in result) {
        return sendJson(res, result.status, { errors: result.errors, appended });
      }
      if (result && "deduped" in result) {
        deduped += 1;
      } else {
        appended += 1;
      }
    }
    return sendJson(res, 200, { appended, ...(deduped > 0 ? { deduped } : {}) });
  }

  /**
   * Validate and apply a single runner event. Returns an error on violation,
   * `{deduped: true}` when a retried event is acknowledged as a duplicate,
   * or null on success.
   *
   * Ordering (issue #113): appendEvent runs BEFORE setLastRunnerSeq — the
   * journal is the source of truth and must be durable before any derived
   * state. A crash between append and seq-record produces a retried duplicate
   * (deduped below) rather than a permanently lost event.
   *
   * Dedup-by-content: a retried seq whose payload matches the stored event →
   * `{deduped: true}`. A reused seq with different content → 422 (the
   * tripwire that keeps orphan runners and seq bugs loud). The lookup is bounded
   * to the current runner generation — see `runnerSeqEpoch`.
   *
   * Coalescing: all job.json writes during applyEffects are batched into one
   * flushPersist at the end — one snapshot write per intake event.
   */
  #intakeOne(job: JobRecord, claimed: unknown): IntakeResult {
    const { ok, errors } = validateEvent(claimed);
    if (!ok) return { status: 422, errors };
    // Schema-validated just above: claimed carries job/seq/type plus per-type fields.
    const event = claimed as StoredEvent;

    const rejection = this.#screenIntake(job, event);
    if (rejection !== null) return rejection;

    // Accepted. Append to the journal FIRST (issue #113: append-before-seq).
    // The journal is the source of truth; if we crash after this but before
    // recording the seq, the retry is safely deduped by content.
    const { job: _job, seq: _seq, ...payload } = event;
    // Stamp the runner's claimed seq on the stored event for dedup lookups.
    payload.runnerSeq = event.seq;

    // Batch: coalesce all job.json writes from appendEvent + applyEffects
    // into one persist at the end.
    this.registry.beginBatch();
    try {
      this.registry.appendEvent(job.id, payload);
      // Record the runner's claimed seq AFTER the journal append (issue #113).
      this.registry.setLastRunnerSeq(job.id, event.seq);
      this.#applyEffects(job, event, "intake");
    } finally {
      this.registry.endBatch(job.id);
    }
    return null;
  }

  /**
   * Every reason a schema-valid runner event is still refused, in the order the
   * checks have to run. Returns null when the event may be appended,
   * `{deduped}` when it is a retry of one already stored.
   */
  #screenIntake(job: JobRecord, event: StoredEvent): IntakeResult {
    if (event.job !== job.id) {
      return { status: 422, errors: [`event.job "${event.job}" does not match job ${job.id}`] };
    }

    // Dedup-by-content (issue #113): a claimed seq this generation has already
    // stored is either a benign retry (same payload → 200 deduped) or a real
    // conflict (different payload → 422). Never dedupe on seq alone.
    //
    // Checked BEFORE the monotonic-seq guard, not inside it. Append-before-seq
    // opens exactly one crash window — appended, seq not yet recorded — and in
    // it the retried seq is *above* lastRunnerSeq. Gating dedup on
    // `seq <= lastRunnerSeq` makes it unreachable in the only window the
    // reordering creates, and the retry lands as a second copy of an event the
    // journal already holds: double settle, effects applied twice.
    const existing = this.registry.findEventByRunnerSeq(job.id, event.seq);
    if (existing) {
      if (this.#eventsMatch(existing, event)) return { deduped: true };
      return {
        status: 422,
        errors: [
          `seq ${event.seq} already recorded with different content ` +
          `(log seq ${existing.seq}, type "${existing.type}")`,
        ],
      };
    }
    const lastRunnerSeq = this.registry.lastRunnerSeq(job.id);
    if (lastRunnerSeq !== null && event.seq <= lastRunnerSeq) {
      return {
        status: 422,
        errors: [`seq must be monotonically increasing: got ${event.seq} after ${lastRunnerSeq}`],
      };
    }
    if (isTerminal(job.state)) {
      return { status: 422, errors: [`job is ${job.state}; no further events accepted`] };
    }
    if (event.type === "answer") {
      return {
        status: 422,
        errors: ["runners may not post answer events; answers arrive only via the operator /answer endpoint"],
      };
    }
    if (event.type === "state") return this.#screenStateEvent(job, event);
    if (event.type === "decision") return this.#screenDecisionEvent(job, event);
    return null;
  }

  /** Transition and marker legality for a runner `state` event. */
  #screenStateEvent(job: JobRecord, event: StoredEvent): IntakeError | null {
    // Schema-validated: state is one of the five states, marker parked|stale.
    const nextState = event.state as JobState;
    const marker = event.marker as Marker | undefined;
    if (!canTransition(job.state, nextState)) {
      // Special protocol: the runner emits state:blocked,marker:parked when
      // block_hot expires on an already-blocked job. This is a marker update
      // (not a new state transition) and is explicitly permitted.
      const isParking = job.state === "blocked" && nextState === "blocked" && marker === "parked";
      if (!isParking) {
        return { status: 422, errors: [`illegal transition: ${job.state} -> ${nextState}`] };
      }
    }
    if (marker !== undefined && !isMarkerAllowed(nextState, marker)) {
      return { status: 422, errors: [`marker "${marker}" not allowed on state ${nextState}`] };
    }
    return null;
  }

  /** Transition legality and id uniqueness for a runner `decision` event. */
  #screenDecisionEvent(job: JobRecord, event: StoredEvent): IntakeError | null {
    if (!canTransition(job.state, "blocked")) {
      return {
        status: 422,
        errors: [`decision not accepted while ${job.state}: illegal transition ${job.state} -> blocked`],
      };
    }
    // Decision ids are unique across a job's whole log (#110). Without this the
    // uniqueness the re-entry seed buys is a convention, and a runner that
    // recycles d1 — an old build, a harness numbering its own ids — silently
    // inherits the answer a human gave to a different question. Rejecting is
    // the loud failure; overwriting openDecision is the quiet one.
    if (this.registry.hasDecision(job.id, String(event.id))) {
      return {
        status: 422,
        errors: [
          `decision id "${String(event.id)}" already used by this job; ` +
          `ids must be unique across the whole log`,
        ],
      };
    }
    return null;
  }

  /**
   * Compare a stored event against a claimed one for dedup-by-content.
   *
   * Everything but the bookkeeping is compared, all the way down: `seq` is the
   * daemon's and differs by construction, `runnerSeq` is how the stored event
   * was found, and `at` is stamped per append. A shallow or key-name-only
   * comparison would be worse than none — dedup would swallow a settle whose
   * report changed, and the mismatch-422 tripwire is the whole point.
   */
  #eventsMatch(stored: StoredEvent, claimed: StoredEvent): boolean {
    const strip = (e: StoredEvent) => {
      const { seq, runnerSeq, at, ...rest } = e;
      return rest;
    };
    return stableStringify(strip(stored)) === stableStringify(strip(claimed));
  }

  /**
   * Apply an event's effects to the record.
   *
   * `mode` is `"intake"` for a live event and `"replay"` for boot
   * reconciliation. The record derivation is identical in both — that is the
   * point of one function — but the outward-facing effects run on intake only:
   * replaying them would re-notify operators about every historic decision,
   * block the constructor on a synchronous `gh`, and terminate containers at
   * boot. Every suppressed effect is either already done or belongs to a live
   * event that will arrive again.
   */
  #applyEffects(job: JobRecord, event: StoredEvent, mode: EffectsMode = "intake"): void {
    if (event.type === "state") return this.#applyStateEvent(job, event, mode);
    if (event.type === "decision") return this.#applyDecisionEvent(job, event, mode);
    if (event.type === "settle") return this.#applySettleEvent(job, event);
  }

  /** State transition, marker, wall-clock segment, and the terminal handling. */
  #applyStateEvent(job: JobRecord, event: StoredEvent, mode: EffectsMode): void {
    // Schema-validated at intake.
    const nextState = event.state as JobState;
    const marker = event.marker as Marker | undefined;
    // Cancellation reason (wall-clock, stall, pickup-gate, ...) is part of the
    // record so status/board can distinguish kinds of cancellation.
    const reason = typeof event.reason === "string" ? { reason: event.reason } : {};
    if (marker !== undefined) {
      this.registry.updateJob(job.id, { state: nextState, marker, ...reason });
    } else {
      this.registry.clearMarker(job.id);
      this.registry.updateJob(job.id, { state: nextState, ...reason });
    }
    // Wall-clock tracking: running = active, blocked/terminal = inactive.
    // Not replayed: these read the daemon clock, so a replay would collapse
    // every recorded segment to zero length and hand the job a fresh budget.
    // Wall-clock accounting is the one thing the journal cannot rebuild
    // (D15's accepted cost); the snapshot's value stands.
    if (mode === "intake") {
      if (nextState === "running") {
        this.registry.wallClockBecameActive(job.id);
      } else if (nextState === "blocked" || isTerminal(nextState)) {
        this.registry.wallClockBecameInactive(job.id);
      }
      // A park landing on an already-answered decision means the runner parked
      // through #151's gap; the guard and the recovery live in the helper.
      this.#maybeRecoverAnsweredPark(job, nextState, marker);
    }
    if (isTerminal(nextState)) this.#applyTerminalState(job, mode);
  }

  /** Rung verification and the clean-settle container reap. */
  #applyTerminalState(job: JobRecord, mode: EffectsMode): void {
    // Settle rides ahead of the terminal state event; verify the target
    // rung — locally for lower rungs, via gh for upper rungs.
    const target = targetRung(job.workOrder);
    // On replay, no gh: verifyRung records "unverified: requires gh" for the
    // upper rungs instead of shelling out synchronously inside the constructor.
    // An honest unverified beats a boot that blocks on the network, and the
    // operator can re-check.
    const ghRunner = mode === "intake" ? defaultGhRunner() : undefined;
    const doneCheck = verifyRung(job.settle, target, { ghRunner });
    this.registry.updateJob(job.id, { doneCheck: { target, ...doneCheck } });
    // Reap the stopped container on clean settle (#120): exited containers
    // pile up forever without this. Skip jobs whose workspace the runner
    // retained after a failed push — they keep their container so the
    // operator can retry the push from inside it via `fleet resume-push`.
    // Not replayed: terminating containers from a constructor is not boot's job.
    if (job.handle === undefined || mode !== "intake") return;
    const retained = this.registry
      .eventsAfter(job.id, -1)
      .some(
        (e) =>
          e.type === "log" &&
          typeof e.text === "string" &&
          e.text.startsWith(RETAINED_WORKSPACE_NOTE_PREFIX),
      );
    if (!retained) {
      this.#options.provider.terminate(job.handle).catch(() => {});
    }
  }

  /** Open the decision, block the job, start the decision-timeout clock. */
  #applyDecisionEvent(job: JobRecord, event: StoredEvent, mode: EffectsMode): void {
    // Schema-validated at intake: decision has id, question, options[{id,...}].
    const decision = event as StoredEvent & { id: string; question: string; options: { id: string }[] };
    this.registry.setOpenDecision(job.id, {
      id: decision.id,
      question: decision.question,
      optionIds: decision.options.map((option) => option.id),
    });
    this.registry.updateJob(job.id, { state: "blocked" });
    // Record when this decision first arrived — the decision_timeout clock
    // starts here (regardless of whether the job is hot or parked). On replay
    // the event's own timestamp is the honest answer: dating a two-day-old
    // decision to boot time would silently restart the operator's clock.
    const blockedAt = mode === "intake" ? Date.now() : Date.parse(String(event.at ?? ""));
    this.registry.setDecisionBlockedAt(job.id, Number.isFinite(blockedAt) ? blockedAt : Date.now());
    if (mode !== "intake") return;
    // The job is now waiting for an operator answer — operator wait time is
    // excluded from the wall-clock budget, same as the runner-side behaviour.
    this.registry.wallClockBecameInactive(job.id);
    this.#notify(job.id, decision.question);
  }

  /** Record the settle facts the terminal state event will verify. */
  #applySettleEvent(job: JobRecord, event: StoredEvent): void {
    const settle: Record<string, unknown> = { outcome: event.outcome };
    if (event.rung !== undefined) settle.rung = event.rung;
    if (event.minutes !== undefined) settle.minutes = event.minutes;
    if (event.report !== undefined) settle.report = event.report;
    this.registry.updateJob(job.id, { settle });
  }

  /**
   * Periodic sweep: terminate and cancel any job whose active runtime has
   * exceeded its wall_clock limit by more than the backstop margin.
   *
   * The runner is the primary enforcer; the daemon fires only when the runner
   * is wedged (not posting events). The backstop margin must be large enough
   * for the runner to SIGTERM + grace + settle before the daemon fires.
   */
  #wallClockSweep(): void {
    const now = Date.now();
    const margin = this.#options.wallClockBackstopMarginMs ?? DEFAULT_BACKSTOP_MARGIN_MS;
    for (const job of this.registry.listJobs()) {
      if (job.state !== "running" && job.state !== "blocked") continue;
      const limitMs = this.registry.wallClockLimitMs(job.id);
      if (limitMs === null) continue;
      const activeMs = this.registry.wallClockActiveMs(job.id, now);
      if (activeMs === null) continue;
      if (activeMs >= limitMs + margin) {
        // Fire asynchronously; errors are logged to the job's event stream.
        this.#timeoutBackstop(job, {
          reason: "wall-clock",
          nextAction: "job cancelled: wall-clock limit reached (daemon backstop)",
        }).catch(() => {});
      }
    }
  }

  /**
   * Periodic sweep: terminate and cancel any running job that has posted no
   * event for longer than its idle threshold plus the backstop margin (#39).
   *
   * The runner is the primary enforcer; this covers the case it cannot report
   * on itself (dead or wedged runner). Blocked jobs are exempt — waiting on a
   * human is not a stall, and the park/stale lifecycle already owns that wait.
   *
   * It is a backstop, not a mirror: the runner measures silence on the harness's
   * stdout, the daemon measures silence on the event stream, and the two differ
   * (the pickup gate feeds neither; some stream lines translate to no event).
   * Hence the margin, and hence `limits.idle` must exceed the gate's runtime —
   * this path terminates the container, so unlike the runner's own stall path it
   * cannot push the partial work first.
   */
  #idleSweep(): void {
    const now = Date.now();
    const margin = this.#options.idleBackstopMarginMs ?? DEFAULT_BACKSTOP_MARGIN_MS;
    for (const job of this.registry.listJobs()) {
      if (job.state !== "running") continue;
      const limitMs = this.registry.idleLimitMs(job.id);
      if (limitMs === null) continue;
      const lastEventAt = this.registry.lastEventAtMs(job.id);
      if (lastEventAt === null) continue;
      const idleMs = now - lastEventAt;
      if (idleMs >= limitMs + margin) {
        this.#timeoutBackstop(job, {
          reason: "stall",
          nextAction:
            `job cancelled: no events for ${toMinutes(idleMs)}m ` +
            `(idle limit ${toMinutes(limitMs)}m, daemon backstop)`,
        }).catch(() => {});
      }
    }
  }

  /**
   * Daemon-side timeout backstop: terminate the container, synthesise the
   * settle and the cancelled state event. Shared by the wall-clock (cost) and
   * stall (liveness) sweeps — only the reason and the note differ.
   */
  async #timeoutBackstop(job: JobRecord, cause: { reason: string; nextAction: string }): Promise<void> {
    // Re-fetch to guard against a race where the runner already settled.
    const current = this.registry.getJob(job.id);
    if (!current || isTerminal(current.state)) return;
    if (this.#backstopping.has(job.id)) return;
    this.#backstopping.add(job.id);
    try {
      await this.#cancelFromBackstop(current, cause);
    } finally {
      this.#backstopping.delete(job.id);
    }
  }

  /** The backstop's actual work; guarded by #timeoutBackstop against re-entry. */
  async #cancelFromBackstop(job: JobRecord, cause: { reason: string; nextAction: string }): Promise<void> {
    if (job.handle) {
      try {
        await this.#options.provider.terminate(job.handle);
      } catch (error) {
        this.registry.appendEvent(job.id, {
          type: "log",
          text: `${cause.reason} backstop: terminate failed: ${String(error)}`,
          who: "daemon",
        });
      }
    }

    // Re-check after async terminate; runner may have settled in the meantime.
    const afterTerminate = this.registry.getJob(job.id);
    if (!afterTerminate || isTerminal(afterTerminate.state)) return;

    // Synthesise settle (if none yet) then the terminal state event.
    if (!afterTerminate.settle) {
      const settlePayload = {
        type: "settle",
        outcome: { produced: [], findings: 0, decisions: 0 },
        report: {
          status: "PARTIAL",
          next_action: cause.nextAction,
        },
      };
      this.registry.appendEvent(job.id, settlePayload);
      this.registry.updateJob(job.id, {
        settle: {
          outcome: settlePayload.outcome,
          report: settlePayload.report,
        },
      });
    }

    this.registry.appendEvent(job.id, { type: "state", state: "cancelled", reason: cause.reason });
    this.registry.setOpenDecision(job.id, null);
    this.registry.setDecisionBlockedAt(job.id, null);
    this.registry.clearMarker(job.id);
    this.registry.wallClockBecameInactive(job.id);
    const updated = this.registry.updateJob(job.id, { state: "cancelled", reason: cause.reason });

    // Verify target rung (will show not-reached for a cancelled job).
    const target = targetRung(updated.workOrder);
    const doneCheck = verifyRung(updated.settle, target, { ghRunner: defaultGhRunner() });
    this.registry.updateJob(job.id, { doneCheck: { target, ...doneCheck } });
  }

  /**
   * Periodic sweep: mark any parked job as stale once its decision_timeout
   * has elapsed since the decision first arrived. Stale jobs stay parked and
   * answerable — they just get the stale marker surfaced in fleet status.
   */
  #decisionTimeoutSweep(): void {
    const now = Date.now();
    for (const job of this.registry.listJobs()) {
      if (job.state !== "blocked" || job.marker !== "parked") continue;
      const limitMs = this.registry.decisionTimeLimitMs(job.id);
      if (limitMs === null) continue;
      const blockedAt = this.registry.decisionBlockedAtMs(job.id);
      if (blockedAt === null) continue;
      if (now - blockedAt < limitMs) continue;
      this.#markStale(job);
    }
  }

  /** Transition a parked job to stale; idempotent. */
  #markStale(job: JobRecord): void {
    const current = this.registry.getJob(job.id);
    if (!current || current.state !== "blocked" || current.marker === "stale") return;
    this.registry.appendEvent(job.id, { type: "state", state: "blocked", marker: "stale" });
    this.registry.updateJob(job.id, { marker: "stale" });
  }

  /**
   * Boot-time recovery for the crash windows no sweep reaches (#115). The
   * launch paths persist their intent before `await provider.launch` and the
   * outcome only after, so a daemon crash between the two leaves a record that
   * *implies* a container without proving one: a queued job with no handle, a
   * running job with no handle, a blocked job whose open decision was consumed
   * but whose re-entry never finished. None of those shapes is reachable by
   * the wall-clock, idle, or decision sweeps — recover or fail each one loudly
   * at boot instead of stranding it.
   */
  async #bootRecover(): Promise<void> {
    for (const job of this.registry.listJobs()) {
      try {
        await this.#recoverJobAtBoot(job);
      } catch (error) {
        this.registry.appendEvent(job.id, {
          type: "log",
          text: `boot recovery failed: ${String(error)}`,
          who: "daemon",
        });
      }
    }
  }

  /** Route one job to the recovery its crash-window shape implies (#115). */
  async #recoverJobAtBoot(job: JobRecord): Promise<void> {
    if (isTerminal(job.state)) return;
    if (job.state === "queued" && job.handle === undefined) {
      return this.#resolveLostLaunch(job);
    }
    if (job.state === "running" && job.handle === undefined) {
      return this.#adoptDerivedHandle(job);
    }
    if (job.state === "blocked" && this.registry.openDecision(job.id) === null) {
      return this.#recoverBlockedWithoutDecision(job);
    }
  }

  /**
   * Queued with no handle at boot: #createJob persists the record before
   * `await provider.launch` and the handle only after, so this job's launch
   * died with the old daemon — and no sweep covers queued (wall-clock and idle
   * both skip it), so it would sit forever, indistinguishable in `fleet
   * status` from a healthy queue. Whether the container actually started is
   * unknowable (Provider has no list op), so resolve loudly: best-effort
   * terminate the derivable handle — a no-op when nothing launched
   * (termination is idempotent, #122), spend control when something did — and
   * cancel with a reason that says what happened.
   */
  async #resolveLostLaunch(job: JobRecord): Promise<void> {
    const derived = this.#options.provider.deriveHandle?.(job.id);
    if (derived !== undefined) {
      await this.#options.provider.terminate(derived).catch(() => {});
    }
    this.registry.appendEvent(job.id, {
      type: "log",
      text: "daemon restarted before the launch completed; cancelling",
      who: "daemon",
    });
    this.registry.appendEvent(job.id, { type: "state", state: "cancelled", reason: "launch-lost" });
    this.registry.updateJob(job.id, { state: "cancelled", reason: "launch-lost" });
  }

  /**
   * Running with no handle at boot: the launch succeeded — the runner has been
   * posting events with the token persisted before the launch — but the crash
   * ate the handle. The job itself is healthy; the fault is that cancel and
   * both backstops gate on job.handle and would silently skip terminate,
   * leaving a container Fleet can never kill. Adopt the provider's derivable
   * handle where one exists; where none does, say so in the journal instead of
   * letting the gap pass silently.
   */
  #adoptDerivedHandle(job: JobRecord): void {
    const derived = this.#options.provider.deriveHandle?.(job.id);
    if (derived === undefined) {
      this.registry.appendEvent(job.id, {
        type: "log",
        text: `handle lost in a daemon restart and provider ${job.provider} cannot derive one; Fleet cannot terminate this container`,
        who: "daemon",
      });
      return;
    }
    this.registry.appendEvent(job.id, {
      type: "log",
      text: `handle lost in a daemon restart; adopted derived handle ${derived}`,
      who: "daemon",
    });
    this.registry.updateJob(job.id, { handle: derived });
  }

  /**
   * Blocked with no open decision at boot: the answer path consumes the
   * decision (durably) before `await provider.launch`, so a crash mid-re-entry
   * leaves the exact shape #answer 409s as "blocked but has no open decision"
   * and every sweep skips — the permanently unrecoverable state the re-entry
   * path exists to prevent, created by the crash window instead. The journal
   * still holds everything needed: finish the interrupted re-entry from the
   * recorded answer. A blocked job whose last decision was never answered
   * instead gets its open decision restored, so the operator can answer it.
   */
  async #recoverBlockedWithoutDecision(job: JobRecord): Promise<void> {
    const pending = this.#answeredPendingReentry(job.id);
    if (pending === null) return this.#restoreOpenDecision(job);
    this.registry.appendEvent(job.id, {
      type: "log",
      text: `daemon restarted during re-entry for decision ${pending.decisionId}; re-launching with the recorded answer`,
      who: "daemon",
    });
    try {
      await this.#launchReentry(job, pending);
    } catch (error) {
      this.#cancelAfterFailedRelaunch(job.id, error);
    }
  }

  /** Reopen the journal's last unanswered decision on the record (#115). */
  #restoreOpenDecision(job: JobRecord): void {
    const events = this.registry.eventsAfter(job.id, -1);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type !== "decision") continue;
      const decision = events[i] as StoredEvent & { id: string; question: string; options: { id: string }[] };
      this.registry.setOpenDecision(job.id, {
        id: decision.id,
        question: decision.question,
        optionIds: decision.options.map((option) => option.id),
      });
      // Date the timeout clock from the decision event itself — restoring at
      // boot must not silently restart the operator's clock (same choice as
      // replay mode in #applyDecisionEvent).
      const at = Date.parse(String(decision.at ?? ""));
      this.registry.setDecisionBlockedAt(job.id, Number.isFinite(at) ? at : Date.now());
      this.registry.appendEvent(job.id, {
        type: "log",
        text: `restored open decision ${decision.id} lost in a daemon restart`,
        who: "daemon",
      });
      return;
    }
    // Blocked with no decision anywhere in the journal: nothing to restore or
    // re-launch. Cancel loudly rather than strand it.
    this.registry.appendEvent(job.id, { type: "state", state: "cancelled", reason: "unrecoverable" });
    this.registry.updateJob(job.id, { state: "cancelled", reason: "unrecoverable" });
  }

  #notify(jobId: string, question: string): void {
    const webhooks = this.#options.notifyWebhooks
      ?? (process.env.FLEET_NOTIFY_WEBHOOK ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const webhook of webhooks) {
      fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `Fleet job ${jobId} is blocked on a decision: ${question}` }),
      }).catch(() => {
        // Best-effort notification; the decision event is already persisted.
      });
    }
  }

  async #answerPoll(job: JobRecord, url: URL, res: ServerResponse): Promise<void> {
    const decisionId = url.searchParams.get("decision");
    if (!decisionId) return sendJson(res, 400, { error: "missing ?decision=<id>" });
    const deadline = Date.now() + this.#longPollMs;
    for (;;) {
      const answer = this.registry.findAnswer(job.id, decisionId);
      if (answer) {
        const body: Record<string, unknown> = {};
        if (answer.option !== undefined) body.option = answer.option;
        if (answer.text !== undefined) body.text = answer.text;
        return sendJson(res, 200, body);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        res.writeHead(204);
        res.end();
        return;
      }
      await this.registry.waitForEvent(job.id, remaining);
    }
  }

  // ---- Artifact lane (issue #18) ----

  /**
   * Reject artifact paths that could escape outside the artifact directory.
   * Returns the path as-is if safe, or null if unsafe.
   */
  static #safeArtifactPath(relPath: string): string | null {
    if (!relPath || relPath.startsWith("/") || relPath.startsWith("\\")) return null;
    const parts = relPath.split(/[/\\]/);
    for (const part of parts) {
      if (part === "" || part === "." || part === "..") return null;
    }
    return relPath;
  }

  /** Compute total bytes stored under an artifact directory. */
  static #artifactDirSize(dir: string): number {
    if (!existsSync(dir)) return 0;
    let total = 0;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else total += statSync(full).size;
      }
    }
    return total;
  }

  /**
   * POST /internal/jobs/:id/artifacts
   * Runner uploads one artifact at a time. Body: JSON {path, content (base64), sha256?, bytes}.
   * Enforces per-file and total caps; path-escape-guarded. Runner-token auth.
   */
  async #receiveArtifact(job: JobRecord, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendJson(res, 400, { error: "body must be a JSON object" });
    }
    const raw = body as Record<string, unknown>;
    const relPath = raw.path;
    const contentB64 = raw.content;
    const declaredBytes = raw.bytes;
    const declaredSha256 = raw.sha256;

    if (typeof relPath !== "string" || !relPath) {
      return sendJson(res, 400, { error: "path (string) required" });
    }
    if (typeof contentB64 !== "string") {
      return sendJson(res, 400, { error: "content (base64 string) required" });
    }
    if (typeof declaredBytes !== "number" || declaredBytes < 0) {
      return sendJson(res, 400, { error: "bytes (non-negative number) required" });
    }

    const safePath = FleetDaemon.#safeArtifactPath(relPath);
    if (!safePath) {
      return sendJson(res, 400, { error: `invalid artifact path: ${relPath}` });
    }

    // Per-file cap: checked against declared bytes before decoding.
    if (declaredBytes > ARTIFACT_PER_FILE_CAP) {
      return sendJson(res, 413, {
        error: `artifact ${relPath} (${declaredBytes} bytes) exceeds per-file cap of ${ARTIFACT_PER_FILE_CAP} bytes`,
      });
    }

    // Decode and verify integrity.
    const decoded = Buffer.from(contentB64, "base64");
    if (decoded.length !== declaredBytes) {
      return sendJson(res, 422, {
        error: `bytes mismatch: declared ${declaredBytes}, actual ${decoded.length}`,
      });
    }
    if (typeof declaredSha256 === "string") {
      const actualSha256 = createHash("sha256").update(decoded).digest("hex");
      if (actualSha256 !== declaredSha256) {
        return sendJson(res, 422, { error: `sha256 mismatch for ${relPath}` });
      }
    }

    // Total cap: compute current on-disk total before writing.
    const artDir = artifactDir(this.#options.home, job.id);
    const currentTotal = FleetDaemon.#artifactDirSize(artDir);
    if (currentTotal + declaredBytes > ARTIFACT_TOTAL_CAP) {
      return sendJson(res, 413, {
        error: `total artifact cap (${ARTIFACT_TOTAL_CAP} bytes) would be exceeded`,
      });
    }

    const targetPath = join(artDir, safePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, decoded);

    return sendJson(res, 200, { stored: true, path: relPath, bytes: declaredBytes });
  }

  /** GET /jobs/:id/artifacts — list artifacts stored for the job. */
  async #listArtifacts(job: JobRecord, res: ServerResponse): Promise<void> {
    const artDir = artifactDir(this.#options.home, job.id);
    const artifacts: { path: string; bytes: number }[] = [];
    if (existsSync(artDir)) {
      const stack = [artDir];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else {
            const relPath = relative(artDir, full).replace(/\\/g, "/");
            artifacts.push({ path: relPath, bytes: statSync(full).size });
          }
        }
      }
      artifacts.sort((a, b) => a.path.localeCompare(b.path));
    }
    return sendJson(res, 200, { artifacts });
  }

  /**
   * GET /jobs/:id/artifacts/<path> — fetch a single artifact.
   * Returns JSON {path, content (base64), bytes, sha256} so the CLI can write
   * it without binary-encoding issues in the HTTP client.
   */
  async #getArtifact(job: JobRecord, relPath: string, res: ServerResponse): Promise<void> {
    const safePath = FleetDaemon.#safeArtifactPath(relPath);
    if (!safePath) {
      return sendJson(res, 400, { error: `invalid artifact path: ${relPath}` });
    }
    const artDir = artifactDir(this.#options.home, job.id);
    const fullPath = join(artDir, safePath);
    if (!existsSync(fullPath)) {
      return sendJson(res, 404, { error: `artifact not found: ${relPath}` });
    }
    const content = readFileSync(fullPath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    return sendJson(res, 200, {
      path: relPath,
      content: content.toString("base64"),
      bytes: content.length,
      sha256,
    });
  }
}
