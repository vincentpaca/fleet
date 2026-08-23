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
import { isTerminal } from "./state.ts";
import type { JobState, Marker } from "./state.ts";

export type StoredEvent = {
  job: string;
  seq: number;
  /** The runner's claimed seq, stored on the event for dedup-by-content. */
  runnerSeq?: number;
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
  /**
   * Why a job cancelled ("wall-clock", "stall", "pickup-gate", ...), carried
   * from the state event so `fleet status` and the board can say which kind of
   * cancellation this was without replaying the event log.
   */
  reason?: string;
  workOrder: unknown;
  createdAt: string;
  updatedAt: string;
  provider: string;
  handle?: string;
  runnerToken: string;
  settle?: Record<string, unknown>;
  doneCheck?: Record<string, unknown>;
  /** Most recent think/log event text + timestamp. Computed at event intake; no log scan at list time. */
  lastActivity?: { text: string; at: string };
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
  // Stall backstop tracking (issue #39).
  /** Idle (silence) threshold in ms; null = not initialised (pre-#39 records). */
  idleMs: number | null;
  /** Daemon-clock ms when the last event landed; null until the first event. */
  lastEventAt: number | null;
  // Decision-timeout tracking (issue #6).
  /** Total decision timeout in ms (from first block to stale); null = no limit. */
  decisionTimeoutMs: number | null;
  /** Timestamp (ms) when the current decision event first arrived; null if none active. */
  decisionBlockedAt: number | null;
  // Launch details stored for parked-job re-entry (issue #6).
  launchManifest: unknown;
  launchEnv: Record<string, string>;
  launchSync: Record<string, string>;
  launchImage: string | undefined;
};

type JobEntry = {
  record: JobRecord;
  internal: JobInternal;
  events: StoredEvent[];
  lastSeq: number;
  /** True when in-memory state diverged from job.json but the persist is deferred (coalescing). */
  dirty: boolean;
};

export class Registry extends EventEmitter {
  readonly home: string;
  #jobs = new Map<string, JobEntry>();
  /**
   * When true, persist-calling methods (updateJob, clearMarker, wallClock*, …)
   * defer the write and only set `entry.dirty`. The caller is responsible for
   * calling `flushPersist` once the batch is done. This lets `#intakeOne`
   * coalesce 3–6 separate job.json writes into one.
   */
  #batching = false;

  constructor(home: string) {
    super();
    this.setMaxListeners(0);
    this.home = home;
    this.#loadAll();
  }

  /**
   * Run boot reconciliation for all loaded non-terminal jobs. Must be called
   * after `setApplyEffectsFn` — the reconciler replays through the real
   * effects function, and that callback is set by the daemon after construction.
   */
  reconcileAll(): void {
    for (const [id, entry] of this.#jobs) {
      this.#reconcile(id, entry);
    }
  }

  /**
   * Callback set by the daemon to replay event effects on a record. The
   * reconciler uses the same effects function intake uses — not a parallel
   * reimplementation — so the two paths can never drift.
   */
  #applyEffectsFn: ((job: JobRecord, event: StoredEvent) => void) | null = null;

  /** Set the effects callback used for boot reconciliation. */
  setApplyEffectsFn(fn: (job: JobRecord, event: StoredEvent) => void): void {
    this.#applyEffectsFn = fn;
  }

  #loadAll(): void {
    const jobsRoot = join(this.home, "jobs");
    if (!existsSync(jobsRoot)) return;
    for (const id of readdirSync(jobsRoot).sort()) {
      const dir = join(jobsRoot, id);
      const recordPath = join(dir, "job.json");
      if (!existsSync(recordPath)) continue;

      // Tolerant boot: a torn or empty job.json (host crash mid-rename) must
      // not brick the daemon. Quarantine the corrupt job and keep loading the
      // rest — one bad file never crash-loops the whole process.
      let raw: JobRecord & JobInternal;
      try {
        const text = readFileSync(recordPath, "utf8");
        if (text.trim().length === 0) throw new Error("job.json is empty");
        raw = JSON.parse(text) as JobRecord & JobInternal;
        if (typeof raw.id !== "string" || typeof raw.state !== "string") {
          throw new Error("job.json missing required fields");
        }
      } catch (err) {
        const corruptPath = join(jobsRoot, `${id}.corrupt`);
        console.error(`fleet: quarantining corrupt job ${id}: ${String(err)}`);
        try {
          renameSync(dir, corruptPath);
        } catch (renameErr) {
          console.error(`fleet: failed to quarantine ${id}: ${String(renameErr)}`);
        }
        continue;
      }

      const {
        lastRunnerSeq, openDecision,
        wallClockMs, wallClockActiveMs, wallClockActiveSince,
        idleMs, lastEventAt,
        decisionTimeoutMs, decisionBlockedAt,
        launchManifest, launchEnv, launchSync, launchImage,
        ...record
      } = raw;
      const eventsPath = join(dir, "events.jsonl");
      let events: StoredEvent[];
      try {
        events = existsSync(eventsPath)
          ? (parseNdjson(readFileSync(eventsPath, "utf8")) as StoredEvent[])
          : [];
      } catch (err) {
 // The events log is corrupted beyond a truncated trailing line. Quarantine
 // like a bad job.json — the job cannot be served safely with a broken log.
        const corruptPath = join(jobsRoot, `${id}.corrupt`);
        console.error(`fleet: quarantining job ${id} (events.jsonl corrupt): ${String(err)}`);
        try {
          renameSync(dir, corruptPath);
        } catch (renameErr) {
          console.error(`fleet: failed to quarantine ${id}: ${String(renameErr)}`);
        }
        continue;
      }
      const lastSeq = events.length > 0 ? events[events.length - 1].seq : -1;
      const entry: JobEntry = {
        record,
        internal: {
          lastRunnerSeq: lastRunnerSeq ?? null,
          openDecision: openDecision ?? null,
          wallClockMs: wallClockMs ?? null,
          wallClockActiveMs: wallClockActiveMs ?? 0,
          wallClockActiveSince: wallClockActiveSince ?? null,
          idleMs: idleMs ?? null,
          lastEventAt: lastEventAt ?? null,
          decisionTimeoutMs: decisionTimeoutMs ?? null,
          decisionBlockedAt: decisionBlockedAt ?? null,
          launchManifest: launchManifest ?? null,
          launchEnv: launchEnv ?? {},
          launchSync: launchSync ?? {},
          launchImage: launchImage ?? undefined,
        },
        events,
        lastSeq,
        dirty: false,
      };
      this.#jobs.set(id, entry);
    }
  }

  /**
   * Compare the card (job.json) against the journal's tail. If the last state
   * event in the log disagrees with `record.state`, replay the effects of all
   * events from the point of divergence. The journal is authoritative; the
   * card is derived.
   *
   * Settled (done/cancelled) jobs are NOT reconciled — their journals are not
   * re-read at boot (issue #118's cost requirement); the trusted snapshot wins.
   */
  #reconcile(id: string, entry: JobEntry): void {
    if (isTerminal(entry.record.state)) return;
    if (!this.#applyEffectsFn) return;
    // Find the last state event in the journal.
    let lastStateEvent: StoredEvent | null = null;
    for (let i = entry.events.length - 1; i >= 0; i--) {
      if (entry.events[i].type === "state") {
        lastStateEvent = entry.events[i];
        break;
      }
    }
    if (!lastStateEvent) return;
    const journalState = (lastStateEvent as { state: string }).state;
    if (journalState === entry.record.state) return;

    // Disagreement: the journal says the job is in a different state than the
    // card. Replay from the beginning through the real effects function so the
    // card converges with the journal. The effects function mutates the record
    // in-place; we must not persist mid-replay (batching).
    console.error(
      `fleet: boot reconciliation — job ${id} card says ${entry.record.state} but journal says ${journalState}; replaying`,
    );
    // Reset the record to its pre-event state by replaying all events.
    // The effects function re-derives state, settle, doneCheck, etc.
    this.#batching = true;
    try {
      for (const event of entry.events) {
        this.#applyEffectsFn(entry.record, event);
      }
      this.#writeJobJson(entry);
    } finally {
      this.#batching = false;
    }
  }

  #persist(entry: JobEntry): void {
    if (this.#batching) {
      entry.dirty = true;
      return;
    }
    this.#writeJobJson(entry);
  }

  /** Write job.json to disk (tmp + rename). Callers must flush `entry.dirty`. */
  #writeJobJson(entry: JobEntry): void {
    const dir = jobDir(this.home, entry.record.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "job.json");
    const payload = JSON.stringify({ ...entry.record, ...entry.internal }, null, 2);
    writeFileSync(`${path}.tmp`, payload);
    renameSync(`${path}.tmp`, path);
    entry.dirty = false;
    this.#persistCount++;
  }

  /** Number of job.json writes since construction (test instrumentation). */
  #persistCount = 0;

  /** Total job.json persist count since construction (test seam). */
  persistCount(): number {
    return this.#persistCount;
  }

  /**
   * Persist deferred writes. Called once at the end of a batched intake to
   * coalesce multiple in-memory mutations into a single job.json write.
   */
  flushPersist(id: string): void {
    const entry = this.#entry(id);
    if (!entry.dirty) return;
    this.#writeJobJson(entry);
  }

  /**
   * Begin a batch: subsequent persist-calling methods defer job.json writes
   * until `endBatch` flushes them. The journal (events.jsonl) is still
   * appended immediately — it is the source of truth and must be durable.
   */
  beginBatch(): void {
    this.#batching = true;
  }

  /** End a batch and flush the deferred job.json write for the given job. */
  endBatch(id: string): void {
    this.#batching = false;
    this.flushPersist(id);
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
        idleMs: null,
        lastEventAt: null,
        decisionTimeoutMs: null,
        decisionBlockedAt: null,
        launchManifest: null,
        launchEnv: {},
        launchSync: {},
        launchImage: undefined,
      },
      events: [],
      lastSeq: -1,
      dirty: false,
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
    // Liveness for the stall backstop (issue #39): the daemon's own clock, not
    // the event's `at` — that one is stamped by the runner, whose container
    // clock may be skewed against the daemon's.
    entry.internal.lastEventAt = Date.now();
    // Update lastActivity for think/log events — intake-computed so listJobs()
    // never has to scan event files (O(1) per job at list time).
    if ((stored.type === "think" || stored.type === "log") && typeof stored.text === "string" && stored.text) {
      entry.record.lastActivity = { text: stored.text, at: stored.at as string };
    }
    this.#persist(entry);
    this.emit("event", id, stored);
    return stored;
  }

  eventsAfter(id: string, after: number): StoredEvent[] {
    return this.#entry(id).events.filter((event) => event.seq > after);
  }

  /**
   * Find the stored event that was logged with a given runner-claimed seq.
   * Used by intake's dedup-by-content check: a retried event whose payload
   * matches the stored event is acknowledged as a duplicate rather than
   * rejected. The runner's claimed seq is stored on the event as `runnerSeq`.
   */
  findEventByRunnerSeq(id: string, runnerSeq: number): StoredEvent | undefined {
    return this.#entry(id).events.find(
      (event) => event.runnerSeq === runnerSeq,
    );
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

  // --- Stall backstop tracking (issue #39) ---

  /** Set the idle (silence) threshold for a job (called when the job is created). */
  initIdle(id: string, limitMs: number): void {
    const entry = this.#entry(id);
    entry.internal.idleMs = limitMs;
    this.#persist(entry);
  }

  /** Idle threshold in ms; null for records created before the limit existed. */
  idleLimitMs(id: string): number | null {
    return this.#entry(id).internal.idleMs;
  }

  /** Daemon-clock ms when this job's last event landed; null if it has none. */
  lastEventAtMs(id: string): number | null {
    return this.#entry(id).internal.lastEventAt;
  }

  // --- Decision-timeout tracking (issue #6) ---

  /** Set the decision timeout for a job (called at job creation). */
  initDecisionTimeout(id: string, limitMs: number): void {
    const entry = this.#entry(id);
    entry.internal.decisionTimeoutMs = limitMs;
    this.#persist(entry);
  }

  /** Decision timeout limit in ms; null if none. */
  decisionTimeLimitMs(id: string): number | null {
    return this.#entry(id).internal.decisionTimeoutMs;
  }

  /** Timestamp (ms) when the current decision first arrived; null if no decision active. */
  decisionBlockedAtMs(id: string): number | null {
    return this.#entry(id).internal.decisionBlockedAt;
  }

  /** Record when a decision arrived (start of the decision_timeout clock). */
  setDecisionBlockedAt(id: string, atMs: number | null): void {
    const entry = this.#entry(id);
    entry.internal.decisionBlockedAt = atMs;
    this.#persist(entry);
  }

  // --- Launch details for parked-job re-entry (issue #6) ---

  /** Store the launch spec fields needed to re-launch after parking. */
  storeLaunchDetails(id: string, details: {
    manifest: unknown;
    env: Record<string, string>;
    sync: Record<string, string>;
    image: string | undefined;
  }): void {
    const entry = this.#entry(id);
    entry.internal.launchManifest = details.manifest;
    entry.internal.launchEnv = details.env;
    entry.internal.launchSync = details.sync;
    entry.internal.launchImage = details.image;
    this.#persist(entry);
  }

  /** Retrieve the stored launch details for re-launching a parked job. */
  getLaunchDetails(id: string): {
    manifest: unknown;
    env: Record<string, string>;
    sync: Record<string, string>;
    image: string | undefined;
  } {
    const internal = this.#entry(id).internal;
    return {
      manifest: internal.launchManifest,
      env: internal.launchEnv,
      sync: internal.launchSync,
      image: internal.launchImage,
    };
  }

  /**
   * Reset the runner's seq counter (called on re-entry so the new runner
   * can start its seq from 0 without triggering the monotonic-seq check).
   */
  resetRunnerSeq(id: string): void {
    const entry = this.#entry(id);
    entry.internal.lastRunnerSeq = null;
    this.#persist(entry);
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
