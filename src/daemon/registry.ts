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
 * The write-once half of a job's state, in its own file (issue #113).
 *
 * The launch manifest and the work order are set at creation and never change,
 * but they are also the bulk of the record — a manifest with a synced-file map
 * is kilobytes. Keeping them in job.json meant every event re-serialised and
 * re-wrote all of it: on EFS, that is a multi-kilobyte network round trip per
 * event to persist a state field. They live in launch.json now, and job.json is
 * the hot record.
 *
 * A job created before the split has these fields inside its job.json and no
 * launch.json. The loader migrates it — writes launch.json from what it read —
 * because job.json is rewritten on the very next event WITHOUT them, and a
 * record whose launch half is in neither file is unrecoverable.
 */
const LAUNCH_FILE = "launch.json";

/**
 * Stamped into job.json by every post-split write. It is what separates "this
 * job predates the split" from "this job's launch.json is gone": both look like
 * an absent file, one is routine and one is corruption, and neither file's
 * tmp+rename is ordered against the other's under a host crash (D15 accepts no
 * fsync). Without the marker the loader has to guess, and guessing "legacy"
 * silently serves a job with no work order.
 */
const LAUNCH_SPLIT_VERSION = 1;

/**
 * The only keys read out of launch.json. An allowlist, not a convenience: the
 * file is merged over the card, so any other key that parsed would be persisted
 * and served — see #readLaunchFile.
 */
const LAUNCH_KEYS = [
  "workOrder", "launchManifest", "launchEnv", "launchSync", "launchImage",
] as const;

/**
 * What the loader concluded about a job's write-once half: the fields to merge,
 * and whether a migration write is owed. A named type, not an inline one, on
 * purpose — Lizard parses TypeScript as C, and braces in a return-type
 * annotation read as a function body opening, so it mis-measures the function
 * and everything after it as one 90-line block.
 */
type LaunchHalf = { fields: Partial<LaunchFile>; migrate: boolean };

type LaunchFile = {
  workOrder: unknown;
  launchManifest: unknown;
  launchEnv: Record<string, string>;
  launchSync: Record<string, string>;
  launchImage: string | undefined;
};

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

/**
 * The two halves of a persisted job.json. They live in one file (one atomic
 * rename per job) but are separate in memory: `record` is the wire shape the
 * operator sees, `internal` is daemon bookkeeping that never leaves the daemon.
 *
 * Split out of the loader so the defaulting — one `??` per field, and every one
 * of them a branch — is not counted against the function doing the file I/O and
 * the error handling. Each default is the value a record written before that
 * field existed should read as.
 */
function publicFields(raw: JobRecord & JobInternal): JobRecord {
  const {
    launchSplit, lastRunnerSeq, runnerSeqEpoch, openDecision,
    wallClockMs, wallClockActiveMs, wallClockActiveSince,
    idleMs, lastEventAt,
    decisionTimeoutMs, decisionBlockedAt,
    launchManifest, launchEnv, launchSync, launchImage,
    ...record
  } = raw;
  return record;
}

/**
 * What each internal field reads as when the persisted record predates it. A
 * table rather than a field-by-field `?? default`: fourteen of those is
 * fourteen branches through one function, and the table also puts every
 * migration default in one place a reader can check against JobInternal.
 */
const INTERNAL_DEFAULTS: JobInternal = {
  launchSplit: 0,
  lastRunnerSeq: null,
  // Pre-#113 records have no epoch: -1 searches the whole log, which is the old
  // behaviour and correct for a journal with only one generation in it.
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
};

function internalFields(raw: Partial<JobInternal>): JobInternal {
  const stored = raw as Record<string, unknown>;
  const present = Object.keys(INTERNAL_DEFAULTS).filter((key) => stored[key] !== undefined);
  return {
    ...INTERNAL_DEFAULTS,
    ...Object.fromEntries(present.map((key) => [key, stored[key]])),
  };
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
  /**
   * Which launch attempt this record is on (#30). Absent = 1 (every record
   * written before auto-retry existed). Set from the daemon-authored queued
   * retry event's `attempt` field — an absolute value, so boot reconciliation
   * replaying the journal derives the same count intake did.
   */
  attempt?: number;
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
  /**
   * Which launch-file layout wrote this record: 0 (or absent) means pre-split,
   * with the launch fields still inside job.json. See LAUNCH_SPLIT_VERSION.
   */
  launchSplit: number;
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
  /**
   * The in-memory event log, or null when it has been evicted (issue #118).
   * Terminal jobs evict: their journal never changes again, so keeping every
   * settled job's events resident makes daemon memory grow with lifetime usage,
   * not with live work. The file on disk stays the source of truth — readers
   * that still need a settled job's history (`?after=`, replay) re-read it on
   * demand via `#eventsOf`. `lastSeq` is only meaningful while events is
   * non-null; an append to an evicted entry consults the journal (`#nextSeq`).
   */
  events: StoredEvent[] | null;
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
    // A lost launch half becomes a journal entry, not just a line on stderr.
    // The journal is what the cockpit and `fleet events` read; without this the
    // failure only surfaces much later as cancelled/launch-failed, which is
    // indistinguishable from a real launch failure. Appended here rather than
    // during the load because appendEvent needs the entry to be registered.
    for (const id of this.#launchLost) {
      if (isTerminal(this.#entry(id).record.state)) continue;
      this.appendEvent(id, {
        type: "log",
        text: `launch data lost: ${LAUNCH_FILE} is missing or unreadable — this job cannot be re-launched after parking`,
        who: "daemon",
      });
    }
    this.#launchLost = [];
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
      if (!existsSync(join(dir, "job.json"))) continue;
      // Tolerant boot: one torn file must not brick the daemon. Either half
      // being unreadable quarantines that job and loading continues.
      const entry = this.#loadOne(jobsRoot, id, dir);
      if (entry !== null) this.#jobs.set(id, entry);
    }
  }

  /**
   * Read one job dir into an entry, or quarantine it and return null. A torn
   * `job.json` (host crash mid-rename, so the rename persisted before the data)
   * and a journal corrupted beyond a truncated trailing line are both fatal to
   * that job and to nothing else — the journal is the source of truth (D15), so
   * a job whose journal cannot be read whole cannot be served.
   */
  #loadOne(jobsRoot: string, id: string, dir: string): JobEntry | null {
    let raw: JobRecord & JobInternal;
    try {
      const text = readFileSync(join(dir, "job.json"), "utf8");
      if (text.trim().length === 0) throw new Error("job.json is empty");
      raw = JSON.parse(text) as JobRecord & JobInternal;
      if (typeof raw.id !== "string" || typeof raw.state !== "string") {
        throw new Error("job.json missing required fields");
      }
    } catch (err) {
      this.#quarantine(jobsRoot, id, `job.json unreadable: ${String(err)}`);
      return null;
    }

    let events: StoredEvent[] | null;
    try {
      events = this.#loadBootJournal(id, raw.state);
    } catch (err) {
      this.#quarantine(jobsRoot, id, `events.jsonl corrupt: ${String(err)}`);
      return null;
    }

    const launch = this.#resolveLaunchHalf(id, dir, raw);
    const merged = { ...raw, ...launch.fields } as JobRecord & JobInternal;
    const entry: JobEntry = {
      record: publicFields(merged),
      internal: internalFields(merged),
      events,
      lastSeq: events !== null && events.length > 0 ? events[events.length - 1].seq : -1,
      dirty: false,
    };
    if (events !== null) this.#restartClocks(id, entry.internal);
    if (launch.migrate) {
      // Migrate now, not later. The next event rewrites job.json WITHOUT these
      // fields, so a legacy job that is read but not migrated loses its launch
      // half on its first event and has it in neither file after that.
      console.error(`fleet: migrating job ${id} to ${LAUNCH_FILE}`);
      this.#writeLaunchJson(entry);
    }
    return entry;
  }

  /**
   * A job's journal for boot, or null when the job is terminal. Settled jobs'
   * event files are NOT read at boot (issue #118): they never change again, so
   * parsing them buys nothing, and on an EFS-backed home the sync reads delay
   * the socket bind by the whole lifetime history. Throws when the journal is
   * corrupt beyond a truncated trailing line — the caller quarantines.
   */
  #loadBootJournal(id: string, state: string): StoredEvent[] | null {
    if (isTerminal(state as JobState)) return null;
    return this.#readJournal(id);
  }

  /** Parse the job's events.jsonl from disk; [] when the file does not exist. */
  #readJournal(id: string): StoredEvent[] {
    const path = join(jobDir(this.home, id), "events.jsonl");
    if (!existsSync(path)) return [];
    return parseNdjson(readFileSync(path, "utf8")) as StoredEvent[];
  }

  /**
   * The job's full event log: the resident array for live jobs, a fresh read
   * of the journal for evicted (settled) ones. Consumers see the exact daemon
   * seqs either way — the file is the authoritative log they were stamped into.
   */
  #eventsOf(entry: JobEntry): StoredEvent[] {
    return entry.events ?? this.#readJournal(entry.record.id);
  }

  /**
   * Restart a job's wall-clock and idle clocks from boot time (issue #116).
   * Both are persisted as absolute timestamps, so the gap between the daemon's
   * last write and this boot — the daemon's own downtime — would otherwise be
   * billed to the job: the first sweep after a 90-minute outage reads a healthy
   * job as 90 minutes over budget or 90 minutes silent, and cancels it.
   * Accumulated active time already banked stays; only the open segment and
   * the silence measurement restart. In-memory only: the values converge to
   * disk on the entry's next persist, and re-forgiving a span on a crashy boot
   * under-bills, which is the safe direction.
   */
  #restartClocks(id: string, internal: JobInternal, now = Date.now()): void {
    const skipped = Math.max(
      internal.wallClockActiveSince !== null ? now - internal.wallClockActiveSince : 0,
      internal.lastEventAt !== null ? now - internal.lastEventAt : 0,
    );
    if (internal.wallClockActiveSince !== null) internal.wallClockActiveSince = now;
    if (internal.lastEventAt !== null) internal.lastEventAt = now;
    // Audit trail for real outages; a quick restart is not worth a line per job.
    if (skipped >= 60_000) {
      console.error(
        `fleet: job ${id} — clocks restarted from boot; ` +
        `${Math.round(skipped / 60_000)}m of daemon downtime not billed`,
      );
    }
  }

  /**
   * Decide what the write-once half of a job is, from the two files. Three
   * cases, and confusing them is how the launch data gets lost:
   *
   *  - launch.json readable                → it wins; job.json no longer holds these
   *  - absent, and job.json unmarked       → a pre-split job; migrate it
   *  - absent or torn, and job.json marked → the launch half is gone
   *
   * Returns the fields to merge and whether a migration write is owed.
   */
  #resolveLaunchHalf(id: string, dir: string, raw: JobRecord & JobInternal): LaunchHalf {
    const launch = this.#readLaunchFile(dir);
    if (launch !== null) return { fields: launch, migrate: false };
    if ((raw.launchSplit ?? 0) < LAUNCH_SPLIT_VERSION) return { fields: {}, migrate: true };
    // job.json says a launch.json was written, and it is not readable now. Not
    // fatal (the journal is intact, the job serves and settles) but the job can
    // never re-enter, so it must not pass silently.
    console.error(
      `fleet: job ${id} has no readable ${LAUNCH_FILE}; its launch data is lost ` +
      `and it cannot be re-launched after parking`,
    );
    this.#launchLost.push(id);
    return { fields: {}, migrate: false };
  }

  /** Jobs whose launch.json was marked-but-unreadable at load (see #loadAll). */
  #launchLost: string[] = [];

  /**
   * Read launch.json. Returns null when it is absent or unreadable — the caller
   * decides what that means from job.json's `launchSplit` marker.
   *
   * The five fields are picked by name, never spread wholesale. Anything that
   * parses would otherwise land in the record and be persisted and served: an
   * array injects "0", "1", … keys, and an object carrying `state`,
   * `runnerToken` or `handle` overrides the card, because the launch half is
   * spread last. On the process provider the job runs as the same user with
   * access to $FLEET_HOME, so that path lets a job edit its own control record —
   * the one thing the /internal-only token exists to prevent.
   */
  #readLaunchFile(dir: string): Partial<LaunchFile> | null {
    const path = join(dir, LAUNCH_FILE);
    if (!existsSync(path)) return null;
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${LAUNCH_FILE} is not a JSON object`);
      }
      parsed = value as Record<string, unknown>;
    } catch (err) {
      console.error(`fleet: ${path} unreadable: ${String(err)}`);
      return null;
    }
    const picked: Record<string, unknown> = {};
    for (const key of LAUNCH_KEYS) {
      if (key in parsed) picked[key] = parsed[key];
    }
    return picked as Partial<LaunchFile>;
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
    // Evicted entries are terminal by construction; the guard keeps the type
    // honest and the settled-journals-stay-unread promise (#118) visible here.
    if (isTerminal(entry.record.state) || entry.events === null) return;
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
    // The write-once fields are excluded: they are in launch.json, and the
    // whole point of the split is that this payload stays small. `launchSplit`
    // is NOT excluded — it is how a later boot knows launch.json should exist.
    const { workOrder: _workOrder, ...record } = entry.record;
    const {
      launchManifest: _m, launchEnv: _e, launchSync: _s, launchImage: _i,
      ...internal
    } = entry.internal;
    internal.launchSplit = LAUNCH_SPLIT_VERSION;
    const path = join(dir, "job.json");
    writeFileSync(`${path}.tmp`, JSON.stringify({ ...record, ...internal }, null, 2));
    renameSync(`${path}.tmp`, path);
    entry.dirty = false;
    this.#persistCount++;
  }

  /**
   * Write the launch half. Called at creation and when the launch details
   * arrive — never from intake, so it costs nothing per event.
   */
  #writeLaunchJson(entry: JobEntry): void {
    const dir = jobDir(this.home, entry.record.id);
    mkdirSync(dir, { recursive: true });
    const payload: LaunchFile = {
      workOrder: entry.record.workOrder,
      launchManifest: entry.internal.launchManifest,
      launchEnv: entry.internal.launchEnv,
      launchSync: entry.internal.launchSync,
      launchImage: entry.internal.launchImage,
    };
    const path = join(dir, LAUNCH_FILE);
    writeFileSync(`${path}.tmp`, JSON.stringify(payload, null, 2));
    renameSync(`${path}.tmp`, path);
    this.#launchWriteCount++;
  }

  /** launch.json writes since construction (test seam; must not grow per event). */
  #launchWriteCount = 0;

  launchWriteCount(): number {
    return this.#launchWriteCount;
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
        launchSplit: LAUNCH_SPLIT_VERSION,
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
    this.#writeLaunchJson(entry);
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
    // A settled job's events leave memory (#118): the journal never changes
    // again, and the file on disk keeps serving replay via #eventsOf.
    if (isTerminal(entry.record.state)) entry.events = null;
    this.#persist(entry);
    return entry.record;
  }

  /** Whether the job's events are resident in memory (test seam for #118 eviction). */
  eventsRetained(id: string): boolean {
    return this.#entry(id).events !== null;
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
      seq: this.#nextSeq(entry),
      at: typeof event.at === "string" ? event.at : new Date().toISOString(),
    } as StoredEvent;
    const { ok, errors } = validateEvent(stored);
    if (!ok) throw new Error(`event failed schema validation: ${JSON.stringify(errors)}`);
    const dir = jobDir(this.home, id);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(stored)}\n`);
    if (entry.events !== null) {
      entry.events.push(stored);
      entry.lastSeq = stored.seq;
    }
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

  /**
   * The authoritative seq the next appended event gets. Evicted entries carry
   * no usable lastSeq, so the rare daemon append to a settled job consults the
   * journal — never restart a job's seq sequence.
   */
  #nextSeq(entry: JobEntry): number {
    if (entry.events !== null) return entry.lastSeq + 1;
    const events = this.#readJournal(entry.record.id);
    return (events.length > 0 ? events[events.length - 1]!.seq : -1) + 1;
  }

  eventsAfter(id: string, after: number): StoredEvent[] {
    const events = this.#eventsOf(this.#entry(id));
    // Sorted by seq: binary-search the first index past `after` instead of
    // filtering the whole log per request (#118).
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.seq > after) hi = mid;
      else lo = mid + 1;
    }
    return events.slice(lo);
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
    return this.#eventsOf(entry).find(
      (event) => event.runnerSeq === runnerSeq && event.seq > entry.internal.runnerSeqEpoch,
    );
  }

  /**
   * Find the answer event for a decision id, if any. Only an answer recorded
   * AFTER the decision event matches (issue #110): on park/resume the fresh
   * runner seeds its counter past prior ids, but as a belt-and-braces guard
   * against id reuse the seq comparison prevents a recycled d1 from picking up
   * a stale answer from an earlier generation.
   */
  findAnswer(id: string, decisionId: string): StoredEvent | undefined {
    const events = this.#eventsOf(this.#entry(id));
    // Locate the LAST decision event with this id — if ids are unique across
    // generations (the runner-side seed), there is only one; if they collide,
    // the most recent decision is the one currently open.
    let decisionIndex = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "decision" && e.id === decisionId) {
        decisionIndex = i;
        break;
      }
    }
    if (decisionIndex < 0) return undefined;
    // Scan forward from the decision, not from the log's start (#118): this
    // lookup wakes on every event of a polled job, and position past the last
    // matching decision already implies seq > decisionSeq.
    for (let i = decisionIndex + 1; i < events.length; i++) {
      const event = events[i]!;
      if (event.type === "answer" && event.decision === decisionId) return event;
    }
    return undefined;
  }

  /**
   * Seed for a re-entering runner's decision counter (#110): the highest
   * ordinal already used by a `d<n>` id in the job's log, so the fresh runner's
   * first id is the next unused one.
   *
   * Deliberately the maximum ordinal, not the number of decision events. Those
   * are the same only while every decision the runner raised also reached the
   * log; one rejected or dropped decision event and a count seeds *below* an id
   * already in use, which is the collision this exists to prevent. Ids that are
   * not `d<n>` (the schema allows any non-empty string) contribute their
   * position instead, so an unusual id shape still moves the counter forward.
   */
  decisionSeed(id: string): number {
    let seed = 0;
    let seen = 0;
    for (const event of this.#eventsOf(this.#entry(id))) {
      if (event.type !== "decision") continue;
      seen += 1;
      const ordinal = /^d(\d+)$/.exec(String(event.id))?.[1];
      seed = Math.max(seed, ordinal !== undefined ? Number(ordinal) : seen);
    }
    return seed;
  }

  /** True when a decision with this id is already in the job's log (#110). */
  hasDecision(id: string, decisionId: string): boolean {
    return this.#eventsOf(this.#entry(id)).some(
      (event) => event.type === "decision" && event.id === decisionId,
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
    // The launch half, not the hot record: these fields are write-once and
    // job.json no longer carries them.
    this.#writeLaunchJson(entry);
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
