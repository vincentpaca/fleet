/**
 * Single-writer lock on $FLEET_HOME (issue #112).
 *
 * The registry is the single writer and the single seq authority for a job's
 * log. Two daemons on one home break that: interleaved `job.json` renames and
 * two processes stamping the same log seq. This claims the home before the
 * registry opens it.
 *
 * Liveness is a heartbeat, not a PID. The obvious test — "is the PID in the
 * lockfile alive?" — is wrong for the deployment this protects: the daemon runs
 * as PID 1 of its Fargate task (`images/daemon/Dockerfile` uses exec-form
 * ENTRYPOINT) with FLEET_HOME on EFS. After a daemon crash the lockfile holds
 * `1`, the replacement task's `process.kill(1, 0)` succeeds because it is
 * signalling itself, and the daemon refuses to start — forever. A PID check
 * turns one crash into a permanent crash-loop, which is the failure #112 exists
 * to remove.
 *
 * So the holder rewrites `updatedAt` on a timer and a contender trusts the
 * clock: a lock refreshed within STALE_AFTER_MS is held by something alive, on
 * any host; an older one is a corpse and is reclaimed loudly. A dead daemon's
 * lock therefore clears within seconds without operator action, and a contender
 * that starts inside that window refuses and is restarted by its supervisor —
 * bounded, not permanent. The PID and host are recorded for diagnosis only.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createIfAbsent } from "../shared/fs.ts";

/** How often the holder refreshes the lock. */
export const HEARTBEAT_MS = 5_000;

/**
 * Age at which a lock is considered abandoned. Three heartbeats: a holder that
 * misses one to GC or a slow EFS write must not lose its home.
 */
export const STALE_AFTER_MS = 3 * HEARTBEAT_MS;

type LockFile = { pid: number; host: string; startedAt: string; updatedAt: number };

export class HomeLockedError extends Error {
  constructor(home: string, held: LockFile, ageMs: number) {
    super(
      `fleet: another daemon holds ${home} (pid ${held.pid} on ${held.host}, ` +
      `heartbeat ${ageMs}ms ago). Stop it, or wait ${STALE_AFTER_MS}ms for the ` +
      `lock to go stale if that daemon is gone.`,
    );
    this.name = "HomeLockedError";
  }
}

/**
 * Claim the home. Throws HomeLockedError when a live daemon holds it; reclaims
 * a stale lock. Call `release()` on shutdown; the heartbeat timer is unref'd so
 * it never holds the process open.
 */
export class HomeLock {
  readonly #path: string;
  readonly #home: string;
  readonly #host = hostname();
  #timer: NodeJS.Timeout | null = null;

  constructor(home: string, lockPath: string) {
    this.#home = home;
    this.#path = lockPath;
  }

  acquire(now: () => number = Date.now): void {
    const mine = (): string =>
      JSON.stringify({
        pid: process.pid,
        host: this.#host,
        startedAt: new Date(now()).toISOString(),
        updatedAt: now(),
      } satisfies LockFile);

    if (!createIfAbsent(this.#path, mine(), { mode: 0o600 })) {
      const held = this.#read();
      if (held !== null && !this.#abandoned(held, now())) {
        throw new HomeLockedError(this.#home, held, now() - held.updatedAt);
      }
      // An unreadable lock is as good as absent: it cannot name a holder, and
      // refusing on it would be a torn file bricking boot — the whole bug.
      console.error(
        held === null
          ? `fleet: reclaiming unreadable lock ${this.#path}`
          : `fleet: reclaiming stale lock ${this.#path} (pid ${held.pid} on ` +
            `${held.host}, last heartbeat ${now() - held.updatedAt}ms ago)`,
      );
      writeFileSync(this.#path, mine(), { mode: 0o600 });
    }
    this.#timer = setInterval(() => this.#beat(now), HEARTBEAT_MS);
    this.#timer.unref();
  }

  release(): void {
    // Never touch the file we do not hold: a daemon whose `acquire` was refused
    // still runs `stop()`, and deleting the winner's lock on the way out would
    // hand the home to whoever asks next.
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
    try {
      unlinkSync(this.#path);
    } catch {
      // Best-effort: a leftover lock stops heartbeating and goes stale.
    }
  }

  /** Whether we currently hold the lock (test seam). */
  get held(): boolean {
    return this.#timer !== null;
  }

  #beat(now: () => number): void {
    try {
      const held = this.#read();
      // Someone reclaimed it while we were away. Do not clobber them; the
      // registry is already inconsistent and a loud log is the only honest move.
      if (held !== null && (held.pid !== process.pid || held.host !== this.#host)) {
        console.error(
          `fleet: lock ${this.#path} was taken by pid ${held.pid} on ${held.host}; ` +
          `this daemon no longer owns ${this.#home}`,
        );
        return;
      }
      writeFileSync(
        this.#path,
        JSON.stringify({
          pid: process.pid,
          host: this.#host,
          startedAt: held?.startedAt ?? new Date(now()).toISOString(),
          updatedAt: now(),
        } satisfies LockFile),
        { mode: 0o600 },
      );
    } catch {
      // A failed heartbeat is survivable: the next tick retries, and three
      // consecutive failures hand the home to a contender, which is correct.
    }
  }

  #read(): LockFile | null {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<LockFile>;
      if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) return null;
      return {
        pid: typeof parsed.pid === "number" ? parsed.pid : -1,
        host: typeof parsed.host === "string" ? parsed.host : "(unknown)",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "(unknown)",
        updatedAt: parsed.updatedAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * Abandoned purely on the clock — deliberately not "same pid as us, so it
   * must be ours". Two daemons in one process (a test, a hosted CLI) share a
   * PID and must still contend properly, and a same-PID exception would let
   * exactly that case through.
   */
  #abandoned(held: LockFile, nowMs: number): boolean {
    return nowMs - held.updatedAt >= STALE_AFTER_MS;
  }
}
