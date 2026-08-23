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

/** Suffix a torn job dir is renamed to at boot. Never loaded, never reused. */
const QUARANTINE_SUFFIX = ".corrupt";

/**
 * How the effects function is being called. `"intake"` is a live event and runs
 * everything; `"replay"` is boot reconciliation and runs the record derivation
 * only — see `#reconcile` for why the side effects must not fire twice.
 */
export type EffectsMode = "intake" | "replay";

export type ApplyEffectsFn = (job: JobRecord, event: StoredEvent, mode: EffectsMode) => void;

/**
 * The state the journal implies, or null when no event in it sets one. Both
 * `state` events and `decision` events move a job (a decision blocks it), so
 * reading only `state` events would miss a card that disagrees with a journal
 * ending on a decision.
 */
function journalDerivedState(events: StoredEvent[]): JobState | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "state") return event.state as JobState;
    if (event.type === "decision") return "blocked";
  }
  return null;
}

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
  /**
   * Log seq at which the current runner generation began — the boundary
   * dedup-by-content searches after. A re-entered runner restarts its own seq
   * at 0 (`resetRunnerSeq`), so a claimed seq only identifies an event within
   * one generation: without this boundary, generation 2's `seq 0` would match
   * generation 1's `seq 0` and its first event would be silently deduped away.
   */
  runnerSeqEpoch: number;
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
   * Batch depth. Above zero, persist-calling methods (updateJob, clearMarker,
   * wallClock*, …) defer the write and only set `entry.dirty`; the caller
   * flushes once the batch is done. This lets `#intakeOne` coalesce the 3–6
   * job.json writes one event used to trigger into a single write.
   *
   * A depth counter, not a flag: `endBatch` must not release a batch it did not
   * open, or a nested caller would start persisting mid-intake and the
   * write-count checkpoint would silently stop holding.
   */
  #batching = 0;

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
   * Callback set by the daemon to apply an event's effects to a record. The
   * reconciler uses the same effects function intake uses — not a parallel
   * reimplementation — so the two derivations can never drift. `"replay"`
   * suppresses the outward-facing side effects only.
   */
  #applyEffectsFn: ApplyEffectsFn | null = null;

  /** Set the effects callback used for boot reconciliation. */
  setApplyEffectsFn(fn: ApplyEffectsFn): void {
    this.#applyEffectsFn = fn;
  }

  #loadAll(): void {
    const jobsRoot = join(this.home, "jobs");
    if (!existsSync(jobsRoot)) return;
    for (const id of readdirSync(jobsRoot).sort()) {
      // A quarantined dir is evidence, not a job. Skipping it is what stops
      // the quarantine from chaining a suffix per boot (`x.corrupt.corrupt`…)
      // and from loading a stale record under a second key for the same id.
      if (id.endsWith(QUARANTINE_SUFFIX)) continue;
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
        this.#quarantine(jobsRoot, id, `job.json unreadable: ${String(err)}`);
        continue;
      }

      const {
        lastRunnerSeq, runnerSeqEpoch, openDecision,
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
        // The events log is corrupted beyond a truncated trailing line.
        // Quarantine like a bad job.json — the journal is the source of truth
        // (D15) and a job whose journal cannot be read cannot be served.
        this.#quarantine(jobsRoot, id, `events.jsonl corrupt: ${String(err)}`);
        continue;
      }
      const lastSeq = events.length > 0 ? events[events.length - 1].seq : -1;
      const entry: JobEntry = {
        record,
        internal: {
          lastRunnerSeq: lastRunnerSeq ?? null,
          // Pre-#113 records have no epoch: -1 searches the whole log, which is
          // the old behaviour and correct for a journal with one generation.
          runnerSeqEpoch: runnerSeqEpoch ?? -1,
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
   * Rename a job dir out of the way so one torn file never crash-loops the
   * daemon. The rename is loud and the dir is left for a human — an existing
   * quarantine for the same id is never overwritten, and `#loadAll` skips
   * `.corrupt` dirs, so this cannot chain a suffix per boot.
   */
  #quarantine(jobsRoot: string, id: string, why: string): void {
    const target = join(jobsRoot, `${id}${QUARANTINE_SUFFIX}`);
    console.error(`fleet: quarantining job ${id} (${why})`);
    if (existsSync(target)) {
      console.error(
        `fleet: ${target} already exists; leaving ${id} in place and skipping it. ` +
        `Move or delete the old quarantine to clear this.`,
      );
      return;
    }
    try {
      renameSync(join(jobsRoot, id), target);
    } catch (err) {
      console.error(`fleet: failed to quarantine ${id}: ${String(err)}`);
    }
  }

  /**
   * Compare the card (job.json) against the journal's tail. If the journal's
   * derived state disagrees with `record.state`, replay every event through the
   * real effects function so the card converges on the journal. The journal is
   * authoritative; the card is derived (D15).
   *
   * The replay runs in `"replay"` mode: the same derivation, none of the
   * outward-facing side effects. Intake's effects include webhook notifications,
   * a synchronous `gh` shell-out and a container terminate — replaying those at
   * boot would re-notify operators about every historic decision, block the
   * constructor on `gh`, and kill containers. Derivation is shared; I/O is not.
   *
   * Settled (done/cancelled) jobs are NOT reconciled — their journals are not
   * re-read at boot (issue #118's cost requirement); the trusted snapshot wins.
   */
  #reconcile(id: string, entry: JobEntry): void {
    if (isTerminal(entry.record.state)) return;
    if (!this.#applyEffectsFn) return;
    const journalState = journalDerivedState(entry.events);
    if (journalState === null || journalState === entry.record.state) return;

    console.error(
      `fleet: boot reconciliation — job ${id} card says ${entry.record.state} ` +
      `but journal says ${journalState}; replaying the journal`,
    );
    // The effects function mutates the record in place; nothing is persisted
    // mid-replay (batching), so the repair lands as a single write.
    this.beginBatch();
    try {
      for (const event of entry.events) {
        this.#applyEffectsFn(entry.record, event, "replay");
      }
    } finally {
      this.#batching -= 1;
    }
    this.#writeJobJson(entry);
    console.error(`fleet: boot reconciliation — job ${id} repaired to ${entry.record.state}`);
  }

  #persist(entry: JobEntry): void {
    if (this.#batching > 0) {
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
    this.#batching += 1;
  }

  /** End a batch and flush the deferred job.json write for the given job. */
  endBatch(id: string): void {
    this.#batching = Math.max(0, this.#batching - 1);
    if (this.#batching === 0) this.flushPersist(id);
  }

  createJob(record: JobRecord): void {
    if (this.#jobs.has(record.id)) throw new Error(`job already exists: ${record.id}`);
    const entry: JobEntry = {
      record,
      internal: {
        lastRunnerSeq: null,
        runnerSeqEpoch: -1,
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
   * Find the stored event that was logged with a given runner-claimed seq,
   * within the current runner generation. Used by intake's dedup-by-content
   * check: a retried event whose payload matches the stored event is
   * acknowledged as a duplicate rather than rejected. The runner's claimed seq
   * is stored on the event as `runnerSeq`.
   *
   * The generation bound is load-bearing, not a nicety — see `runnerSeqEpoch`.
   */
  findEventByRunnerSeq(id: string, runnerSeq: number): StoredEvent | undefined {
    const entry = this.#entry(id);
    return entry.events.find(
      (event) => event.runnerSeq === runnerSeq && event.seq > entry.internal.runnerSeqEpoch,
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
    // Close the old generation: claimed seqs recorded before this point belong
    // to a runner that is gone, and must never satisfy a dedup lookup for the
    // fresh one (which starts claiming from 0 again).
    entry.internal.runnerSeqEpoch = entry.lastSeq;
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
