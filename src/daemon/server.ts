// Fleet daemon HTTP server. Operator endpoints trust socket permissions;
// runner endpoints trust the per-job X-Fleet-Runner-Token. Every event is
// schema-validated at intake; reject, never coerce.
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { validateManifest, validateWorkOrder, validateEvent } from "../validate.mjs";
import { readBody, sendJson } from "../shared/http.ts";
import { parseNdjson } from "../shared/ndjson.ts";
import { newId, newRunnerToken } from "../shared/ids.ts";
import { socketPath } from "../shared/home.ts";
import { parseDurationMs } from "../shared/time.ts";
import { Registry } from "./registry.ts";
import type { JobRecord, StoredEvent } from "./registry.ts";
import { canTransition, isMarkerAllowed, isTerminal } from "./state.ts";
import type { JobState, Marker } from "./state.ts";
import { verifyRung } from "./verify.ts";
import type { Provider } from "../providers/provider.ts";

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
  /** TCP listener on 127.0.0.1 when set (0 = ephemeral, for tests/providers). */
  port?: number;
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
   * How often (ms) the daemon scans for wall-clock-overdue jobs. Default: 10_000.
   * Set smaller in tests.
   */
  wallClockSweepIntervalMs?: number;
};

type IntakeError = { status: number; errors: unknown[] };

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

/** Target rung from a work order already validated at job creation. */
function targetRung(workOrder: unknown): string {
  if (workOrder && typeof workOrder === "object" && "finish" in workOrder) {
    const finish = workOrder.finish;
    if (typeof finish === "string") return finish;
  }
  return "implemented";
}

export class FleetDaemon {
  readonly registry: Registry;
  readonly #options: DaemonOptions;
  readonly #longPollMs: number;
  readonly #sockPath: string;
  #unixServer: Server | null = null;
  #tcpServer: Server | null = null;
  #port: number | null = null;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DaemonOptions) {
    this.#options = options;
    this.#longPollMs = options.longPollMs ?? 25_000;
    this.#sockPath = socketPath(options.home);
    mkdirSync(options.home, { recursive: true });
    this.registry = new Registry(options.home);
  }

  /** URL the runner uses to reach this daemon (TCP preferred when enabled). */
  get daemonUrl(): string {
    if (this.#port !== null) return `http://127.0.0.1:${this.#port}`;
    return `unix:${this.#sockPath}`;
  }

  get port(): number | null {
    return this.#port;
  }

  async start(): Promise<{ socketPath: string; port: number | null }> {
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
      this.#tcpServer.listen(this.#options.port, "127.0.0.1", tcpListening.resolve);
      await tcpListening.promise;
      const address = this.#tcpServer.address();
      this.#port = typeof address === "object" && address !== null ? address.port : null;
    }

    // Combined sweep: wall-clock backstop and decision-timeout (stale) marking.
    const sweepMs = this.#options.wallClockSweepIntervalMs ?? 10_000;
    this.#sweepTimer = setInterval(() => {
      this.#wallClockSweep();
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
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fleet.invalid");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter((part) => part.length > 0);

    // Operator: POST /jobs | GET /jobs | GET /jobs/:id | events/answer/cancel
    if (parts[0] === "jobs") {
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
    }

    // Runner: POST /internal/jobs/:id/events | GET /internal/jobs/:id/answer
    if (parts[0] === "internal" && parts[1] === "jobs" && parts.length === 4) {
      const job = this.registry.getJob(parts[2]);
      if (!job) return sendJson(res, 404, { error: `unknown job: ${parts[2]}` });
      if (!this.#runnerAuthorized(req, job)) {
        return sendJson(res, 401, { error: "invalid runner token" });
      }
      if (parts[3] === "events" && method === "POST") return this.#intakeEvents(job, req, res);
      if (parts[3] === "answer" && method === "GET") return this.#answerPoll(job, url, res);
    }

    sendJson(res, 404, { error: `no route: ${method} ${url.pathname}` });
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

    // Initialise wall-clock and decision-timeout backstop tracking.
    const manifestLimits = (manifest as Record<string, unknown>).limits;
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
      const updated = this.registry.updateJob(id, { state: "cancelled" });
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
    if (job.state !== "blocked") {
      return sendJson(res, 409, { error: `job is ${job.state}, not blocked` });
    }
    const decision = this.registry.openDecision(job.id);
    if (!decision) {
      return sendJson(res, 409, { error: "job is blocked but has no open decision" });
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      return sendJson(res, 400, { error: `invalid JSON body: ${String(error)}` });
    }
    if (!body || typeof body !== "object") {
      return sendJson(res, 400, { error: "body must be a JSON object" });
    }
    const rawOption = "option" in body ? body.option : undefined;
    const rawText = "text" in body ? body.text : undefined;
    if (rawOption !== undefined && typeof rawOption !== "string") {
      return sendJson(res, 422, { error: "option must be a string" });
    }
    if (rawText !== undefined && typeof rawText !== "string") {
      return sendJson(res, 422, { error: "text must be a string" });
    }
    const option = rawOption;
    const text = rawText;
    // An invalid option id is an error, never silently downgraded to free text.
    if (option !== undefined && !decision.optionIds.includes(option)) {
      return sendJson(res, 422, {
        error: `option "${option}" does not match the open decision`,
        options: decision.optionIds,
      });
    }
    if (option === undefined && (text === undefined || text.length === 0)) {
      return sendJson(res, 422, { error: "answer requires an option id or free text" });
    }
    this.registry.appendEvent(job.id, {
      type: "answer",
      decision: decision.id,
      ...(option !== undefined ? { option } : {}),
      ...(text !== undefined ? { text } : {}),
      by: "operator",
    });
    this.registry.setOpenDecision(job.id, null);
    this.registry.setDecisionBlockedAt(job.id, null);

    // Parked (or stale) job: re-entry path. The old runner has already exited.
    // Re-launch a fresh container with the answer pre-materialised so the
    // status-driven harness can pick up where it left off. The state stays
    // blocked until the new runner emits state:running (blocked → running is a
    // valid transition). The runner seq resets so the fresh container starts at 0.
    if (job.marker === "parked" || job.marker === "stale") {
      this.registry.clearMarker(job.id);
      this.registry.resetRunnerSeq(job.id);
      const newToken = newRunnerToken();
      const details = this.registry.getLaunchDetails(job.id);
      const reAnswer: { option?: string; text?: string } = {};
      if (option !== undefined) reAnswer.option = option;
      if (text !== undefined) reAnswer.text = text;
      // Derive resources from the stored manifest so the provider can apply
      // any resource overrides declared in manifest.limits.resources.
      const storedManifest = details.manifest as { limits?: { resources?: { cpu?: number; memory?: number; disk?: number } } };
      const resources = storedManifest?.limits?.resources;
      try {
        const { handle } = await this.#options.provider.launch({
          jobId: job.id,
          daemonUrl: this.daemonUrl,
          runnerToken: newToken,
          image: details.image,
          env: details.env,
          sync: details.sync,
          manifest: details.manifest,
          workOrder: job.workOrder,
          resources,
          reentryAnswer: { decisionId: decision.id, answer: reAnswer },
        });
        const updated = this.registry.updateJob(job.id, { handle, runnerToken: newToken });
        return sendJson(res, 200, { job: publicJob(updated) });
      } catch (error) {
        // Re-launch failed: the old runner is dead and no new one is starting.
        // Cancel the job so it reaches a terminal state the operator can reason
        // about — leaving it in blocked with no runner and no marker would make
        // it permanently unrecoverable without manual intervention.
        this.registry.appendEvent(job.id, {
          type: "log",
          text: `re-launch failed after answer: ${String(error)}`,
          who: "daemon",
        });
        this.registry.appendEvent(job.id, { type: "state", state: "cancelled", reason: "launch-failed" });
        this.registry.updateJob(job.id, { state: "cancelled" });
        return sendJson(res, 500, { error: `re-launch failed: ${String(error)}` });
      }
    }

    // Hot job: the existing runner is still alive and polling for its answer.
    // The blocked → running transition happens immediately here.
    this.registry.clearMarker(job.id);
    const updated = this.registry.updateJob(job.id, { state: "running" });
    // Job is active again; resume the daemon-side wall-clock meter.
    this.registry.wallClockBecameActive(job.id);
    return sendJson(res, 200, { job: publicJob(updated) });
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
    this.registry.appendEvent(job.id, { type: "state", state: "cancelled", reason: "operator-cancel" });
    this.registry.setOpenDecision(job.id, null);
    this.registry.setDecisionBlockedAt(job.id, null);
    this.registry.clearMarker(job.id);
    const updated = this.registry.updateJob(job.id, { state: "cancelled" });
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
    for (const claimed of claimedEvents) {
      const failure = this.#intakeOne(job, claimed);
      if (failure) {
        return sendJson(res, failure.status, { errors: failure.errors, appended });
      }
      appended += 1;
    }
    return sendJson(res, 200, { appended });
  }

  /** Validate and apply a single runner event. Returns an error instead of appending on any violation. */
  #intakeOne(job: JobRecord, claimed: unknown): IntakeError | null {
    const { ok, errors } = validateEvent(claimed);
    if (!ok) return { status: 422, errors };
    // Schema-validated just above: claimed carries job/seq/type plus per-type fields.
    const event = claimed as StoredEvent;

    if (event.job !== job.id) {
      return { status: 422, errors: [`event.job "${event.job}" does not match job ${job.id}`] };
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
    if (event.type === "state") {
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
    }
    if (event.type === "decision" && !canTransition(job.state, "blocked")) {
      return {
        status: 422,
        errors: [`decision not accepted while ${job.state}: illegal transition ${job.state} -> blocked`],
      };
    }

    // Accepted: record the runner's claimed seq, then append with the
    // authoritative log seq (daemon-appended events share the sequence).
    this.registry.setLastRunnerSeq(job.id, event.seq);
    const { job: _job, seq: _seq, ...payload } = event;
    this.registry.appendEvent(job.id, payload);
    this.#applyEffects(job, event);
    return null;
  }

  #applyEffects(job: JobRecord, event: StoredEvent): void {
    if (event.type === "state") {
      // Schema-validated at intake.
      const nextState = event.state as JobState;
      const marker = event.marker as Marker | undefined;
      if (marker !== undefined) {
        this.registry.updateJob(job.id, { state: nextState, marker });
      } else {
        this.registry.clearMarker(job.id);
        this.registry.updateJob(job.id, { state: nextState });
      }
      // Wall-clock tracking: running = active, blocked/terminal = inactive.
      if (nextState === "running") {
        this.registry.wallClockBecameActive(job.id);
      } else if (nextState === "blocked" || isTerminal(nextState)) {
        this.registry.wallClockBecameInactive(job.id);
      }
      if (isTerminal(nextState)) {
        // Settle rides ahead of the terminal state event; verify the target
        // rung — locally for lower rungs, via gh for upper rungs.
        const target = targetRung(job.workOrder);
        const ghRunner = defaultGhRunner();
        const doneCheck = verifyRung(job.settle, target, { ghRunner });
        this.registry.updateJob(job.id, { doneCheck: { target, ...doneCheck } });
      }
      return;
    }
    if (event.type === "decision") {
      // Schema-validated at intake: decision has id, question, options[{id,...}].
      const decision = event as StoredEvent & { id: string; question: string; options: { id: string }[] };
      this.registry.setOpenDecision(job.id, {
        id: decision.id,
        question: decision.question,
        optionIds: decision.options.map((option) => option.id),
      });
      this.registry.updateJob(job.id, { state: "blocked" });
      // Record when this decision first arrived — the decision_timeout clock
      // starts here (regardless of whether the job is hot or parked).
      this.registry.setDecisionBlockedAt(job.id, Date.now());
      // The job is now waiting for an operator answer — operator wait time is
      // excluded from the wall-clock budget, same as the runner-side behaviour.
      this.registry.wallClockBecameInactive(job.id);
      this.#notify(job.id, decision.question);
      return;
    }
    if (event.type === "settle") {
      const settle: Record<string, unknown> = { outcome: event.outcome };
      if (event.rung !== undefined) settle.rung = event.rung;
      if (event.minutes !== undefined) settle.minutes = event.minutes;
      if (event.report !== undefined) settle.report = event.report;
      this.registry.updateJob(job.id, { settle });
    }
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
    const margin = this.#options.wallClockBackstopMarginMs ?? 90_000;
    for (const job of this.registry.listJobs()) {
      if (job.state !== "running" && job.state !== "blocked") continue;
      const limitMs = this.registry.wallClockLimitMs(job.id);
      if (limitMs === null) continue;
      const activeMs = this.registry.wallClockActiveMs(job.id, now);
      if (activeMs === null) continue;
      if (activeMs >= limitMs + margin) {
        // Fire asynchronously; errors are logged to the job's event stream.
        this.#wallClockBackstop(job).catch(() => {});
      }
    }
  }

  /** Daemon-side wall-clock backstop: terminate container, synthesise events. */
  async #wallClockBackstop(job: JobRecord): Promise<void> {
    // Re-fetch to guard against a race where the runner already settled.
    const current = this.registry.getJob(job.id);
    if (!current || isTerminal(current.state)) return;

    if (current.handle) {
      try {
        await this.#options.provider.terminate(current.handle);
      } catch (error) {
        this.registry.appendEvent(job.id, {
          type: "log",
          text: `wall-clock backstop: terminate failed: ${String(error)}`,
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
          next_action: "job cancelled: wall-clock limit reached (daemon backstop)",
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

    this.registry.appendEvent(job.id, { type: "state", state: "cancelled", reason: "wall-clock" });
    this.registry.setOpenDecision(job.id, null);
    this.registry.setDecisionBlockedAt(job.id, null);
    this.registry.clearMarker(job.id);
    this.registry.wallClockBecameInactive(job.id);
    const updated = this.registry.updateJob(job.id, { state: "cancelled" });

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
}
