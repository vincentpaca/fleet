// Job registry: in-memory index over $FLEET_HOME/jobs/<id>/{job.json,events.jsonl}.
// job.json is written atomically (tmp + rename); events.jsonl is append-only and
// every appended event is schema-validated. The registry is the single writer
// and the single seq authority for a job's event log.
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { validateEvent } from "../validate.mjs";
import { parseNdjson } from "../shared/ndjson.ts";
import { jobDir } from "../shared/home.ts";
import type { JobState, Marker } from "./state.ts";

export type StoredEvent = {
  job: string;
  seq: number;
  at?: string;
  type: string;
  [key: string]: unknown;
};

export type OpenDecision = {
  /** Decision event id (e.g. "d1"). */
  id: string;
  question: string;
  /** Stable option ids the operator may answer with. */
  optionIds: string[];
};

/** Wire shape per the contract; runnerToken is stripped before operator responses. */
export type JobRecord = {
  id: string;
  state: JobState;
  marker?: Marker;
  workOrder: unknown;
  createdAt: string;
  updatedAt: string;
  provider: string;
  handle?: string;
  runnerToken: string;
  settle?: Record<string, unknown>;
  doneCheck?: Record<string, unknown>;
};

/** Daemon-internal bookkeeping persisted alongside the record in job.json. */
type JobInternal = {
  /** Highest seq the runner has claimed on intake; null until the first runner event. */
  lastRunnerSeq: number | null;
  openDecision: OpenDecision | null;
  // Wall-clock backstop tracking (daemon-side, independent of runner).
  /** Limit in ms; null = no limit. */
  wallClockMs: number | null;
  /** Active ms accumulated before the current running segment. */
  wallClockActiveMs: number;
  /** Timestamp (ms) when the job last became active; null when not currently active. */
  wallClockActiveSince: number | null;
};

type JobEntry = {
  record: JobRecord;
  internal: JobInternal;
  events: StoredEvent[];
  lastSeq: number;
};

export class Registry extends EventEmitter {
  readonly home: string;
  #jobs = new Map<string, JobEntry>();

  constructor(home: string) {
    super();
    this.setMaxListeners(0);
    this.home = home;
    this.#loadAll();
  }

  #loadAll(): void {
    const jobsRoot = join(this.home, "jobs");
    if (!existsSync(jobsRoot)) return;
    for (const id of readdirSync(jobsRoot).sort()) {
      const recordPath = join(jobsRoot, id, "job.json");
      if (!existsSync(recordPath)) continue;
      const raw = JSON.parse(readFileSync(recordPath, "utf8")) as JobRecord & JobInternal;
      const { lastRunnerSeq, openDecision, wallClockMs, wallClockActiveMs, wallClockActiveSince, ...record } = raw;
      const eventsPath = join(jobsRoot, id, "events.jsonl");
      const events = existsSync(eventsPath)
        ? (parseNdjson(readFileSync(eventsPath, "utf8")) as StoredEvent[])
        : [];
      const lastSeq = events.length > 0 ? events[events.length - 1].seq : -1;
      this.#jobs.set(id, {
        record,
        internal: {
          lastRunnerSeq: lastRunnerSeq ?? null,
          openDecision: openDecision ?? null,
          wallClockMs: wallClockMs ?? null,
          wallClockActiveMs: wallClockActiveMs ?? 0,
          wallClockActiveSince: wallClockActiveSince ?? null,
        },
        events,
        lastSeq,
      });
    }
  }

  #persist(entry: JobEntry): void {
    const dir = jobDir(this.home, entry.record.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "job.json");
    const payload = JSON.stringify({ ...entry.record, ...entry.internal }, null, 2);
    writeFileSync(`${path}.tmp`, payload);
    renameSync(`${path}.tmp`, path);
  }

  createJob(record: JobRecord): void {
    if (this.#jobs.has(record.id)) throw new Error(`job already exists: ${record.id}`);
    const entry: JobEntry = {
      record,
      internal: {
        lastRunnerSeq: null,
        openDecision: null,
        wallClockMs: null,
        wallClockActiveMs: 0,
        wallClockActiveSince: null,
      },
      events: [],
      lastSeq: -1,
    };
    this.#jobs.set(record.id, entry);
    this.#persist(entry);
  }

  getJob(id: string): JobRecord | undefined {
    return this.#jobs.get(id)?.record;
  }

  listJobs(): JobRecord[] {
    return [...this.#jobs.values()].map((entry) => entry.record);
  }

  /** Mutate record fields (state, marker, handle, settle, doneCheck, ...) and persist. */
  updateJob(id: string, patch: Partial<JobRecord>): JobRecord {
    const entry = this.#entry(id);
    Object.assign(entry.record, patch);
    if (patch.marker === undefined && "marker" in patch) delete entry.record.marker;
    entry.record.updatedAt = new Date().toISOString();
    this.#persist(entry);
    return entry.record;
  }

  clearMarker(id: string): void {
    const entry = this.#entry(id);
    delete entry.record.marker;
    entry.record.updatedAt = new Date().toISOString();
    this.#persist(entry);
  }

  lastRunnerSeq(id: string): number | null {
    return this.#entry(id).internal.lastRunnerSeq;
  }

  setLastRunnerSeq(id: string, seq: number): void {
    const entry = this.#entry(id);
    entry.internal.lastRunnerSeq = seq;
    this.#persist(entry);
  }

  openDecision(id: string): OpenDecision | null {
    return this.#entry(id).internal.openDecision;
  }

  setOpenDecision(id: string, decision: OpenDecision | null): void {
    const entry = this.#entry(id);
    entry.internal.openDecision = decision;
    this.#persist(entry);
  }

  /**
   * Append an event to the job's log. The registry assigns the authoritative
   * log seq (strictly monotonic, daemon- and runner-originated events share
   * one sequence) and stamps `at` when absent. Throws if the resulting event
   * fails the wire schema — callers validate intake payloads first; this is
   * the last line of defence.
   */
  appendEvent(id: string, event: Record<string, unknown>): StoredEvent {
    const entry = this.#entry(id);
    const stored: StoredEvent = {
      ...event,
      job: id,
      seq: entry.lastSeq + 1,
      at: typeof event.at === "string" ? event.at : new Date().toISOString(),
    } as StoredEvent;
    const { ok, errors } = validateEvent(stored);
    if (!ok) throw new Error(`event failed schema validation: ${JSON.stringify(errors)}`);
    const dir = jobDir(this.home, id);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(stored)}\n`);
    entry.events.push(stored);
    entry.lastSeq = stored.seq;
    this.emit("event", id, stored);
    return stored;
  }

  eventsAfter(id: string, after: number): StoredEvent[] {
    return this.#entry(id).events.filter((event) => event.seq > after);
  }

  /** Find the answer event for a decision id, if any. */
  findAnswer(id: string, decisionId: string): StoredEvent | undefined {
    return this.#entry(id).events.find(
      (event) => event.type === "answer" && event.decision === decisionId,
    );
  }

  /** Set the wall-clock limit for a job (called when the job is created). */
  initWallClock(id: string, limitMs: number): void {
    const entry = this.#entry(id);
    entry.internal.wallClockMs = limitMs;
    this.#persist(entry);
  }

  /**
   * Record that the job became active (state → running).
   * Idempotent: no-op if already marked active.
   */
  wallClockBecameActive(id: string, now = Date.now()): void {
    const entry = this.#entry(id);
    if (entry.internal.wallClockMs === null) return;
    if (entry.internal.wallClockActiveSince !== null) return; // already active
    entry.internal.wallClockActiveSince = now;
    this.#persist(entry);
  }

  /**
   * Record that the job stopped being active (state → blocked or terminal).
   * Idempotent: no-op if not currently active.
   */
  wallClockBecameInactive(id: string, now = Date.now()): void {
    const entry = this.#entry(id);
    if (entry.internal.wallClockMs === null) return;
    if (entry.internal.wallClockActiveSince === null) return; // already inactive
    entry.internal.wallClockActiveMs += now - entry.internal.wallClockActiveSince;
    entry.internal.wallClockActiveSince = null;
    this.#persist(entry);
  }

  /**
   * Compute current active ms for the job (accumulated + current segment).
   * Returns null when the job has no wall-clock limit.
   */
  wallClockActiveMs(id: string, now = Date.now()): number | null {
    const entry = this.#entry(id);
    if (entry.internal.wallClockMs === null) return null;
    const current = entry.internal.wallClockActiveSince !== null
      ? now - entry.internal.wallClockActiveSince
      : 0;
    return entry.internal.wallClockActiveMs + current;
  }

  /** Wall-clock limit in ms for the job; null if none. */
  wallClockLimitMs(id: string): number | null {
    return this.#entry(id).internal.wallClockMs;
  }

  /**
   * Long-poll primitive: resolves with the next event appended for the job,
   * or null when timeoutMs elapses first.
   */
  waitForEvent(id: string, timeoutMs: number): Promise<StoredEvent | null> {
    const { promise, resolve } = Promise.withResolvers<StoredEvent | null>();
    const onEvent = (jobId: string, event: StoredEvent) => {
      if (jobId !== id) return;
      cleanup();
      resolve(event);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      this.off("event", onEvent);
    };
    this.on("event", onEvent);
    return promise;
  }

  #entry(id: string): JobEntry {
    const entry = this.#jobs.get(id);
    if (!entry) throw new Error(`unknown job: ${id}`);
    return entry;
  }
}
