/**
 * Idle (stall) tracker: meters how long the harness has been silent (issue #39).
 *
 * Wall-clock is a cost bound; this is a liveness check. `touch()` re-marks the
 * window every time the harness emits an output line, so `idleMs()` is the age
 * of the newest line rather than of the job.
 *
 * Blocked intervals are excluded on exactly the same terms as the wall-clock
 * budget — a harness polling for an operator answer is silent on purpose, and
 * waiting on a human is not a stall. The metering itself is WallClockTimer's:
 * touch() simply restarts one at the new mark, carrying the blocked state over,
 * so there is one implementation of "active ms since a mark" in the runner.
 */

import { WallClockTimer } from './wall-clock.ts';

export class IdleTimer {
  private readonly limitMs: number;
  private window: WallClockTimer;
  private blocked = false;

  constructor(limitMs: number, startedAt = Date.now()) {
    this.limitMs = limitMs;
    this.window = new WallClockTimer(limitMs, startedAt);
  }

  /** Record harness output: the idle window restarts from `now`. */
  touch(now = Date.now()): void {
    this.window = new WallClockTimer(this.limitMs, now);
    if (this.blocked) this.window.block(now);
  }

  /** Begin a blocked interval (decision pending). Idempotent. */
  block(now = Date.now()): void {
    this.blocked = true;
    this.window.block(now);
  }

  /** End a blocked interval (answer received). Idempotent. */
  resume(now = Date.now()): void {
    this.blocked = false;
    this.window.resume(now);
  }

  /** Silent (non-blocked) ms since the last output line. */
  idleMs(now = Date.now()): number {
    return this.window.activeMs(now);
  }

  /** True when the harness has been silent for at least the limit. */
  expired(now = Date.now()): boolean {
    return this.window.expired(now);
  }

  /** Ms until the stall threshold; 0 once reached. */
  remainingMs(now = Date.now()): number {
    return this.window.remainingMs(now);
  }
}
