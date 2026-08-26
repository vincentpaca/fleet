/**
 * The consumer-side view of one persisted Fleet event, as read back from the
 * daemon (`GET /jobs/:id/events`). One shape for every consumer — `fleet logs`
 * and `fleet attach` (src/cli/format.ts), the board and cockpit
 * (src/cli/board.ts), and `fleet resume` — where three near-identical copies
 * used to drift (#128).
 *
 * This is deliberately NOT the producer's shape: the runner posts
 * `RunnerEvent` (src/runner/events.ts — carries `job` and `at`, and its seq is
 * the runner's claim, not the daemon's authoritative one). The two contracts
 * must not share a name, so a reader grepping a type cannot conflate them.
 *
 * Fields are the union of what the event vocabulary carries; the daemon's
 * schema (schemas/event.schema.json) owns validity — this type only describes
 * what a consumer may find on an already-accepted event.
 */

/** One option of a decision event, exactly as the schema shapes it. */
export type DecisionOption = { id: string; label?: string; recommended?: boolean };

/** Extract the `id` field from an option; passed to Array.map() by reference. */
export function optionId(o: DecisionOption): string {
  return o.id;
}

export type FleetEvent = {
  seq: number;
  type: string;
  state?: string;
  reason?: string;
  marker?: string;
  /** Launch attempt this state event begins (#30); absent = attempt 1. */
  attempt?: number;
  text?: string;
  value?: number;
  id?: string;
  question?: string;
  options?: DecisionOption[];
  decision?: string;
  option?: string;
  by?: string;
  rung?: string;
  minutes?: number;
  report?: { status?: string; next_action?: string };
  /**
   * Settle outcome (schema-required on settle events). Consumers read only the
   * artifact-lane paths off produced[] — the entries carry more (id, type,
   * title, sha256, url) that no renderer needs.
   */
  outcome?: { produced?: { path?: string }[] };
};

/** A decision awaiting an answer: its id, the verbatim question, the options. */
export type PendingDecision = { id: string; question: string; options: DecisionOption[] };
