/**
 * Duration parsing: convert manifest limit strings ("30s", "2m", "1h") to
 * milliseconds. Returns undefined for strings that don't match the pattern.
 */
export function parseDurationMs(value: string): number | undefined {
  const match = value.match(/^([0-9]+)(s|m|h)$/);
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  if (match[2] === 's') return n * 1_000;
  if (match[2] === 'm') return n * 60_000;
  if (match[2] === 'h') return n * 3_600_000;
  return undefined;
}

/**
 * Stall threshold when `limits.idle` is absent (issue #39). Unlike wall_clock,
 * idle detection is always armed: silence is never the intended state of a
 * running job, so the default has to be a real number rather than "off".
 */
export const DEFAULT_IDLE_MS = 20 * 60_000;

/**
 * Idle threshold in ms from a manifest's `limits` object. Both enforcers (the
 * runner's own timer and the daemon's backstop) read it through here so they
 * can never disagree about the default.
 */
export function idleLimitMs(limits: unknown): number {
  if (limits === null || typeof limits !== 'object') return DEFAULT_IDLE_MS;
  const value = (limits as Record<string, unknown>).idle;
  if (typeof value !== 'string') return DEFAULT_IDLE_MS;
  return parseDurationMs(value) ?? DEFAULT_IDLE_MS;
}

/**
 * Default slack the daemon's backstops grant past a limit before terminating
 * (wall-clock and idle sweeps alike). Shared so tests that reason about the
 * heartbeat window fitting inside the backstop can never drift from the
 * daemon's real default.
 */
export const DEFAULT_BACKSTOP_MARGIN_MS = 90_000;

/**
 * How often a live-but-event-silent job must emit one liveness line (#50).
 *
 * The daemon's stall backstop measures silence on the *event stream*, not on
 * the harness's stdout, and terminating from that path cannot push the partial
 * work first. Since the translator drops the harness's own heartbeats
 * (`tool_progress` and friends), a job inside one long tool call can be alive
 * and event-silent — so the runner coalesces those dropped lines into one
 * bounded log line per window. A third of the idle limit leaves two missed
 * windows of slack before the backstop's margin even begins.
 */
export function heartbeatMs(idleMs: number): number {
  return Math.max(30_000, Math.floor(idleMs / 3));
}

/**
 * ms as minutes rounded to 2dp — the unit the settle event already reports
 * (`minutes`), reused so durations read the same everywhere in the log.
 */
export function toMinutes(ms: number): number {
  return Math.max(0, Math.round((ms / 60_000) * 100) / 100);
}
