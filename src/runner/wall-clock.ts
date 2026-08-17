/**
 * Wall-clock budget tracker: meters active (non-blocked) runtime.
 *
 * block()/resume() bracket periods when the harness is waiting for an
 * operator decision; those intervals do not count against the budget.
 * All timestamps are ms-since-epoch; the `now` parameter lets tests inject
 * controlled values.
 */
export class WallClockTimer {
  private readonly limitMs: number;
  private readonly startedAt: number;
  private accumulatedBlockedMs = 0;
  private blockStartedAt: number | null = null;

  constructor(limitMs: number, startedAt = Date.now()) {
    this.limitMs = limitMs;
    this.startedAt = startedAt;
  }

  /** Begin a blocked interval (decision pending). Idempotent. */
  block(now = Date.now()): void {
    if (this.blockStartedAt !== null) return;
    this.blockStartedAt = now;
  }

  /** End a blocked interval (answer received). Idempotent. */
  resume(now = Date.now()): void {
    if (this.blockStartedAt === null) return;
    this.accumulatedBlockedMs += now - this.blockStartedAt;
    this.blockStartedAt = null;
  }

  /** Total blocked ms accumulated so far (including any ongoing block). */
  blockedMs(now = Date.now()): number {
    return (
      this.accumulatedBlockedMs +
      (this.blockStartedAt !== null ? now - this.blockStartedAt : 0)
    );
  }

  /** Active runtime ms (elapsed minus blocked). */
  activeMs(now = Date.now()): number {
    return now - this.startedAt - this.blockedMs(now);
  }

  /** True when active runtime has reached or exceeded the limit. */
  expired(now = Date.now()): boolean {
    return this.activeMs(now) >= this.limitMs;
  }

  /** Ms until expiry; 0 if already expired. */
  remainingMs(now = Date.now()): number {
    return Math.max(0, this.limitMs - this.activeMs(now));
  }
}
