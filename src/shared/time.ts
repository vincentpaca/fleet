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
 * How long a blocked container stays hot before parking when
 * `limits.block_hot` is absent (issue #134). The docs promised 30m from day
 * one (docs/architecture.md, docs/drill.md); without a code default a
 * manifest with no limits block kept a blocked container hot forever —
 * the opposite of the advertised cost model.
 */
export const DEFAULT_BLOCK_HOT_MS = 30 * 60_000;

/**
 * How long an unanswered decision waits before the daemon marks the job
 * stale, when `limits.decision_timeout` is absent (issue #134). 24h per the
 * same docs promise as DEFAULT_BLOCK_HOT_MS.
 */
export const DEFAULT_DECISION_TIMEOUT_MS = 24 * 3_600_000;

/** One limit key as ms, or the fallback when absent/unparseable. */
function limitMs(limits: unknown, key: string, fallback: number): number {
  if (limits === null || typeof limits !== 'object') return fallback;
  const value = (limits as Record<string, unknown>)[key];
  if (typeof value !== 'string') return fallback;
  return parseDurationMs(value) ?? fallback;
}

/**
 * Idle threshold in ms from a manifest's `limits` object. Both enforcers (the
 * runner's own timer and the daemon's backstop) read it through here so they
 * can never disagree about the default.
 */
export function idleLimitMs(limits: unknown): number {
  return limitMs(limits, 'idle', DEFAULT_IDLE_MS);
}

/**
 * block_hot in ms from a `limits` object; defaults so every job parks —
 * a blocked container that stays hot forever was never an intended state.
 * The runner (the only block_hot enforcer) reads it through here.
 */
export function blockHotLimitMs(limits: unknown): number {
  return limitMs(limits, 'block_hot', DEFAULT_BLOCK_HOT_MS);
}

/**
 * decision_timeout in ms from a `limits` object; defaults so the daemon's
 * stale sweep is always armed — an unanswered question must surface.
 */
export function decisionTimeoutMs(limits: unknown): number {
  return limitMs(limits, 'decision_timeout', DEFAULT_DECISION_TIMEOUT_MS);
}

/**
 * The one chokepoint where a work order's per-dispatch limits override the
 * manifest's (work-order.schema.json `limits`). Both readers — the daemon at
 * job creation and the runner at pickup — merge through here, so an operator
 * override can never be honored by one enforcer and ignored by the other.
 */
export function mergedLimits(manifestLimits: unknown, orderLimits: unknown): Record<string, unknown> {
  const asObject = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return { ...asObject(manifestLimits), ...asObject(orderLimits) };
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
