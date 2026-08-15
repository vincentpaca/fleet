// Rung verification seam. Phase 1: rungs up to "implemented" are verified
// locally from the settle payload; rungs that need GitHub evidence (push, PR,
// CI, reviews, merge state) stay a seam — marked unverified until real `gh`
// calls land; local-gate rungs (focused/static green) likewise need a rerun.

/** The unified evidence ladder, weakest to strongest (work-order.schema.json #/$defs/rung). */
export const RUNG_LADDER = [
  "inspected",
  "implemented",
  "focused-green",
  "static-green",
  "pushed",
  "pr-open",
  "ci-green",
  "reviews-clear",
  "mergeable",
  "merge-ready",
  "merged",
  "deployed",
  "runtime-accepted",
] as const;

export type Rung = (typeof RUNG_LADDER)[number];

const LOCALLY_VERIFIABLE: Record<string, true> = { inspected: true, implemented: true };
const GH_DEPENDENT: Record<string, true> = {
  pushed: true,
  "pr-open": true,
  "ci-green": true,
  "reviews-clear": true,
  mergeable: true,
  "merge-ready": true,
  merged: true,
};

export type SettleFacts = {
  rung?: string;
  report?: { status?: string } & Record<string, unknown>;
} & Record<string, unknown>;

export type RungVerification = {
  verified: boolean;
  reached: string | null;
  notes: string[];
};

/**
 * Mechanically check whether a settle event supports the target rung.
 * Never trusts the runner's claim beyond what can be checked here.
 */
export function verifyRung(settle: SettleFacts | undefined, targetRung: string): RungVerification {
  if (!settle) {
    return { verified: false, reached: null, notes: ["no settle event recorded"] };
  }
  const reached = typeof settle.rung === "string" ? settle.rung : null;
  const reachedIdx = reached === null ? -1 : RUNG_LADDER.indexOf(reached as Rung);
  const targetIdx = RUNG_LADDER.indexOf(targetRung as Rung);

  if (targetIdx === -1) {
    return { verified: false, reached, notes: [`unknown target rung: ${targetRung}`] };
  }
  if (GH_DEPENDENT[targetRung]) {
    return { verified: false, reached, notes: ["unverified: requires gh"] };
  }
  if (!LOCALLY_VERIFIABLE[targetRung]) {
    return { verified: false, reached, notes: ["unverified: requires local gate rerun"] };
  }
  if (reachedIdx < targetIdx) {
    return {
      verified: false,
      reached,
      notes: [`reached rung ${reached ?? "(none)"} is below target ${targetRung}`],
    };
  }
  return {
    verified: true,
    reached,
    notes: [`verified locally: reached ${reached} satisfies target ${targetRung}`],
  };
}
