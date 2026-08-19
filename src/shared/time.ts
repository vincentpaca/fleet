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
 * ms as minutes rounded to 2dp — the unit the settle event already reports
 * (`minutes`), reused so durations read the same everywhere in the log.
 */
export function toMinutes(ms: number): number {
  return Math.max(0, Math.round((ms / 60_000) * 100) / 100);
}
