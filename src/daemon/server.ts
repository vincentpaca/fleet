// Fleet daemon HTTP server. Operator endpoints trust socket permissions;
// runner endpoints trust the per-job X-Fleet-Runner-Token. Every event is
// schema-validated at intake; reject, never coerce.
import http from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { validateManifest, validateWorkOrder, validateEvent } from "../validate.mjs";
import { readBody, sendJson } from "../shared/http.ts";
import { parseNdjson } from "../shared/ndjson.ts";
import { newId, newRunnerToken } from "../shared/ids.ts";
import { socketPath } from "../shared/home.ts";
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
    return { socketPath: this.#sockPath, port: this.#port };
  }

  async stop(): Promise<void> {
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
    // Schema-validated above: work order requires mode + target strings.
    const order = workOrder as { mode: string; target: string };
    // Schema-validated above: manifest setup.image is an optional string.
    const manifestDoc = manifest as { setup?: { image?: string } };

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

    try {
      const { handle } = await this.#options.provider.launch({
        jobId: id,
        daemonUrl: this.daemonUrl,
        runnerToken: record.runnerToken,
        image: manifestDoc.setup?.image,
        env,
        sync,
        manifest,
        workOrder,
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
    // Answer delivery is the blocked -> running transition.
    this.registry.setOpenDecision(job.id, null);
    this.registry.clearMarker(job.id);
    const updated = this.registry.updateJob(job.id, { state: "running" });
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
        return { status: 422, errors: [`illegal transition: ${job.state} -> ${nextState}`] };
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
      if (isTerminal(nextState)) {
        // Settle rides ahead of the terminal state event; verify the target
        // rung mechanically (Phase 1: local rungs only, gh rungs stay a seam).
        const target = targetRung(job.workOrder);
        const doneCheck = verifyRung(job.settle, target);
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
