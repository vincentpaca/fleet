// State machine enforcement, loaded from schemas/job-states.json (single
// source of truth — the daemon never hardcodes the transition table).
import { jobStates } from "../validate.mjs";

export type JobState = "queued" | "running" | "blocked" | "done" | "cancelled";
export type Marker = "parked" | "stale";

type JobStatesDoc = {
  states: JobState[];
  initial: JobState;
  terminal: JobState[];
  transitions: { from: JobState; to: JobState }[];
  markers: Record<Marker, { on: JobState }>;
};

const doc = jobStates as JobStatesDoc;

export const STATES: readonly JobState[] = doc.states;
export const INITIAL_STATE: JobState = doc.initial;

const terminal: ReadonlySet<JobState> = new Set(doc.terminal);
const legal: ReadonlySet<string> = new Set(doc.transitions.map((t) => `${t.from}>${t.to}`));

export function canTransition(from: JobState, to: JobState): boolean {
  return legal.has(`${from}>${to}`);
}

export function isTerminal(state: JobState): boolean {
  return terminal.has(state);
}

/** Markers ride on specific states (parked/stale on blocked), never on others. */
export function isMarkerAllowed(state: JobState, marker: Marker): boolean {
  return doc.markers[marker]?.on === state;
}
