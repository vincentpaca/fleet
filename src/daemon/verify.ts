// Rung verification seam. Phase 1: rungs up to "implemented" are verified
// locally from the settle payload; Phase 2 (this issue): gh-dependent rungs
// are verified by shelling out to `gh` — the caller injects a GhRunner so
// tests can mock it without spawning a real CLI.

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
  report?: { status?: string; pr?: string } & Record<string, unknown>;
} & Record<string, unknown>;

export type RungVerification = {
  verified: boolean;
  reached: string | null;
  notes: string[];
};

/**
 * Executes a gh CLI subcommand, returning stdout. Throw on any failure.
 * Inject in tests; the daemon passes execFileSync('gh', ...).
 */
export type GhRunner = (args: string[]) => string;

/**
 * Mechanically check whether a settle event supports the target rung.
 * Never trusts the runner's claim beyond what can be checked here.
 *
 * When opts.ghRunner is provided, gh-dependent rungs are verified via the
 * CLI. Without it they stay "unverified: requires gh" (backward-compatible).
 * The PR URL is expected in settle.report.pr (set by the runner after
 * authority.publish PR creation).
 */
export function verifyRung(
  settle: SettleFacts | undefined,
  targetRung: string,
  opts?: { ghRunner?: GhRunner },
): RungVerification {
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
    const ghRunner = opts?.ghRunner;
    if (!ghRunner) {
      return { verified: false, reached, notes: ["unverified: requires gh"] };
    }
    return verifyWithGh(settle, targetRung, reached, reachedIdx, targetIdx, ghRunner);
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

/** Dispatch a verified rung check to its dedicated verifier. */
function dispatchRungCheck(prUrl: string, targetRung: string, reached: string | null, ghRunner: GhRunner): RungVerification {
  switch (targetRung) {
    case "pushed": return verifyPushed(prUrl, reached, ghRunner);
    case "pr-open": return verifyPrOpen(prUrl, reached, ghRunner);
    case "ci-green": return verifyCiGreen(prUrl, reached, ghRunner);
    case "reviews-clear": return verifyReviewsClear(prUrl, reached, ghRunner);
    case "mergeable": return verifyMergeable(prUrl, reached, ghRunner);
    case "merge-ready": return verifyMergeReady(prUrl, reached, ghRunner);
    case "merged": return verifyMerged(prUrl, reached, ghRunner);
    default: return { verified: false, reached, notes: ["unverified: no gh check for " + targetRung] };
  }
}

/**
 * Verify a gh-dependent rung by calling the gh CLI.
 * The PR URL from settle.report.pr is the primary evidence anchor.
 */
function verifyWithGh(
  settle: SettleFacts,
  targetRung: string,
  reached: string | null,
  reachedIdx: number,
  targetIdx: number,
  ghRunner: GhRunner,
): RungVerification {
  // Reached rung must be at or above the target rung per the runner's claim.
  if (reachedIdx < targetIdx) {
    return {
      verified: false,
      reached,
      notes: ["reached rung " + (reached ?? "(none)") + " is below target " + targetRung],
    };
  }

  const prUrl = settle.report?.pr;
  if (!prUrl || typeof prUrl !== "string") {
    return { verified: false, reached, notes: ["unverified: no PR URL in settle report"] };
  }

  try {
    return dispatchRungCheck(prUrl, targetRung, reached, ghRunner);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).split("\n")[0];
    return { verified: false, reached, notes: ["gh error: " + msg] };
  }
}

/** gh pr view wrapper — returns parsed JSON. */
function prView(prUrl: string, fields: string[], ghRunner: GhRunner): Record<string, unknown> {
  const out = ghRunner(["pr", "view", prUrl, "--json", fields.join(",")]);
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * pushed: a PR URL existing implies the branch was pushed. Confirm the PR is
 * reachable (any non-error response validates the push happened).
 */
function verifyPushed(prUrl: string, reached: string | null, ghRunner: GhRunner): RungVerification {
  const data = prView(prUrl, ["headRefName"], ghRunner);
  const branch = data.headRefName;
  if (typeof branch === "string" && branch.length > 0) {
    return { verified: true, reached, notes: [`pushed: branch ${branch} confirmed via PR`] };
  }
  return { verified: false, reached, notes: ["pushed: could not confirm head branch via gh"] };
}

/** pr-open: PR state must be OPEN. */
function verifyPrOpen(prUrl: string, reached: string | null, ghRunner: GhRunner): RungVerification {
  const data = prView(prUrl, ["state"], ghRunner);
  if (data.state === "OPEN") {
    return { verified: true, reached, notes: ["pr-open: PR is OPEN"] };
  }
  return { verified: false, reached, notes: [`pr-open: PR state is ${data.state}`] };
}

/**
 * ci-green: all status checks at HEAD must be COMPLETED with a passing
 * conclusion. An empty check list means CI is absent — not green.
 */
function verifyCiGreen(prUrl: string, reached: string | null, ghRunner: GhRunner): RungVerification {
  const data = prView(prUrl, ["statusCheckRollup"], ghRunner);
  const checks = data.statusCheckRollup;
  if (!Array.isArray(checks) || checks.length === 0) {
    return { verified: false, reached, notes: ["ci-green: no checks found (CI absent or pending)"] };
  }
  const failing: string[] = [];
  for (const check of checks) {
    const c = check as { name?: string; status?: string; conclusion?: string };
    if (c.status !== "COMPLETED") {
      failing.push(`${c.name ?? "?"}: ${c.status ?? "?"}`);
    } else if (c.conclusion !== "SUCCESS" && c.conclusion !== "NEUTRAL") {
      failing.push(`${c.name ?? "?"}: ${c.conclusion ?? "?"}`);
    }
  }
  if (failing.length > 0) {
    return { verified: false, reached, notes: [`ci-green: failing checks: ${failing.join(", ")}`] };
  }
  return { verified: true, reached, notes: [`ci-green: ${checks.length} check(s) passed`] };
}

/**
 * reviews-clear: no review with CHANGES_REQUESTED state remains. An approved
 * or neutral review state is acceptable; no reviews at all is also clear.
 */
function verifyReviewsClear(prUrl: string, reached: string | null, ghRunner: GhRunner): RungVerification {
  const data = prView(prUrl, ["reviews", "reviewDecision"], ghRunner);
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  const blocking = reviews.filter(
    (r) => (r as { state?: string }).state === "CHANGES_REQUESTED",
  );
  if (blocking.length > 0) {
    return {
      verified: false,
      reached,
      notes: [`reviews-clear: ${blocking.length} CHANGES_REQUESTED review(s) outstanding`],
    };
  }
  return { verified: true, reached, notes: ["reviews-clear: no blocking reviews"] };
}

/** mergeable: GitHub reports the PR as MERGEABLE (conflict-free). */
function verifyMergeable(prUrl: string, reached: string | null, ghRunner: GhRunner): RungVerification {
  const data = prView(prUrl, ["mergeable"], ghRunner);
  if (data.mergeable === "MERGEABLE") {
    return { verified: true, reached, notes: ["mergeable: no merge conflicts"] };
  }
  return { verified: false, reached, notes: [`mergeable: ${data.mergeable ?? "UNKNOWN"}`] };
}

/**
 * merge-ready: mergeStateStatus CLEAN means GitHub considers the PR fully
 * ready — CI passed, approved, no conflicts, and base branch in sync.
 * Any other status (BEHIND, DIRTY, UNSTABLE, BLOCKED, UNKNOWN) is not ready.
 */
function verifyMergeReady(prUrl: string, reached: string | null, ghRunner: GhRunner): RungVerification {
  const data = prView(prUrl, ["mergeStateStatus"], ghRunner);
  if (data.mergeStateStatus === "CLEAN") {
    return { verified: true, reached, notes: ["merge-ready: mergeStateStatus CLEAN"] };
  }
  return {
    verified: false,
    reached,
    notes: [`merge-ready: mergeStateStatus is ${data.mergeStateStatus ?? "UNKNOWN"} (not CLEAN)`],
  };
}

/** merged: PR state MERGED. */
function verifyMerged(prUrl: string, reached: string | null, ghRunner: GhRunner): RungVerification {
  const data = prView(prUrl, ["state"], ghRunner);
  if (data.state === "MERGED") {
    return { verified: true, reached, notes: ["merged: PR is MERGED"] };
  }
  return { verified: false, reached, notes: [`merged: PR state is ${data.state}`] };
}
