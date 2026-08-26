// Rung verification seam. Rungs up to "implemented" are verified locally from
// the settle payload (verifyRung, synchronous). gh-dependent rungs are
// verified by shelling out to `gh` — a network call, so that path is async
// (verifyRungGh, #117) and the caller injects a GhRunnerAsync so tests can
// mock it without spawning a real CLI. verifyRung alone records the honest
// interim "unverified: requires gh" for gh-dependent targets.

import type { GhRunnerAsync } from "../shared/git.ts";

/** The unified evidence ladder, weakest to strongest (work-order.schema.json #/$defs/rung). */
export const RUNG_LADDER = [ // contract pin: test-only export, asserted by the suite
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

type Rung = (typeof RUNG_LADDER)[number];

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

export type SettleFacts = { // contract pin: test-only export, asserted by the suite
  rung?: string;
  report?: { status?: string; pr?: string } & Record<string, unknown>;
} & Record<string, unknown>;

type RungVerification = {
  verified: boolean;
  reached: string | null;
  notes: string[];
};

/**
 * The interim note verifyRung records for a gh-dependent target. The deferred
 * follow-up (verifyRungGh) and the boot re-check both key on this exact
 * string, so it lives in one place.
 */
export const REQUIRES_GH_NOTE = "unverified: requires gh";

/** True when verifying targetRung needs the gh CLI (a network call). */
export function requiresGh(targetRung: string): boolean {
  return GH_DEPENDENT[targetRung] === true;
}

/**
 * Mechanically check whether a settle event supports the target rung, using
 * only local facts. Never trusts the runner's claim beyond what can be
 * checked here. gh-dependent rungs stay "unverified: requires gh" — the
 * caller follows up with verifyRungGh off any latency-sensitive path (#117).
 */
export function verifyRung(
  settle: SettleFacts | undefined,
  targetRung: string,
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
    return { verified: false, reached, notes: [REQUIRES_GH_NOTE] };
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

/**
 * The full verification, gh calls included (#117). For non-gh targets this is
 * exactly verifyRung; for gh-dependent ones it replaces the interim
 * "unverified: requires gh" with a real verdict. Async because gh is a
 * network call — never run this on the event intake path.
 * The PR URL is expected in settle.report.pr (set by the runner after
 * authority.publish PR creation).
 */
export async function verifyRungGh(
  settle: SettleFacts | undefined,
  targetRung: string,
  ghRunner: GhRunnerAsync,
): Promise<RungVerification> {
  if (!settle || !requiresGh(targetRung)) return verifyRung(settle, targetRung);
  const reached = typeof settle.rung === "string" ? settle.rung : null;
  const reachedIdx = reached === null ? -1 : RUNG_LADDER.indexOf(reached as Rung);
  const targetIdx = RUNG_LADDER.indexOf(targetRung as Rung);
  return verifyWithGh(settle, targetRung, reached, reachedIdx, targetIdx, ghRunner);
}

/** Dispatch a verified rung check to its dedicated verifier. */
function dispatchRungCheck(prUrl: string, targetRung: string, reached: string | null, ghRunner: GhRunnerAsync): Promise<RungVerification> {
  switch (targetRung) {
    case "pushed": return verifyPushed(prUrl, reached, ghRunner);
    case "pr-open": return verifyPrOpen(prUrl, reached, ghRunner);
    case "ci-green": return verifyCiGreen(prUrl, reached, ghRunner);
    case "reviews-clear": return verifyReviewsClear(prUrl, reached, ghRunner);
    case "mergeable": return verifyMergeable(prUrl, reached, ghRunner);
    case "merge-ready": return verifyMergeReady(prUrl, reached, ghRunner);
    case "merged": return verifyMerged(prUrl, reached, ghRunner);
    default: return Promise.resolve({ verified: false, reached, notes: ["unverified: no gh check for " + targetRung] });
  }
}

/**
 * Verify a gh-dependent rung by calling the gh CLI.
 * The PR URL from settle.report.pr is the primary evidence anchor.
 */
async function verifyWithGh(
  settle: SettleFacts,
  targetRung: string,
  reached: string | null,
  reachedIdx: number,
  targetIdx: number,
  ghRunner: GhRunnerAsync,
): Promise<RungVerification> {
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
  if (!PR_URL_SHAPE.test(prUrl)) {
    return { verified: false, reached, notes: [INVALID_PR_NOTE] };
  }

  try {
    return await dispatchRungCheck(prUrl, targetRung, reached, ghRunner);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).split("\n")[0];
    return { verified: false, reached, notes: ["gh error: " + msg] };
  }
}

/**
 * report.pr is authored inside the job sandbox — it crosses the same trust
 * boundary the runner token guards, so it must never be able to act as a gh
 * flag under the daemon's GitHub auth (#175). Only the exact shape the runner
 * produces (createDraftPr returns `gh pr create`'s stdout: a full https PR
 * URL) may reach argv; flags, bare numbers, owner/repo#n, and anything else
 * are rejected before argv is built.
 */
const PR_URL_SHAPE = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]+$/;

/** The honest note recorded when report.pr fails the shape check. */
export const INVALID_PR_NOTE = "unverified: report.pr is not a well-formed GitHub PR URL";

/** gh pr view wrapper — returns parsed JSON. `--` keeps the job-authored URL positional. */
async function prView(prUrl: string, fields: string[], ghRunner: GhRunnerAsync): Promise<Record<string, unknown>> {
  const out = await ghRunner(["pr", "view", "--json", fields.join(","), "--", prUrl]);
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * pushed: a PR URL existing implies the branch was pushed. Confirm the PR is
 * reachable (any non-error response validates the push happened).
 */
async function verifyPushed(prUrl: string, reached: string | null, ghRunner: GhRunnerAsync): Promise<RungVerification> {
  const data = await prView(prUrl, ["headRefName"], ghRunner);
  const branch = data.headRefName;
  if (typeof branch === "string" && branch.length > 0) {
    return { verified: true, reached, notes: [`pushed: branch ${branch} confirmed via PR`] };
  }
  return { verified: false, reached, notes: ["pushed: could not confirm head branch via gh"] };
}

/** pr-open: PR state must be OPEN. */
async function verifyPrOpen(prUrl: string, reached: string | null, ghRunner: GhRunnerAsync): Promise<RungVerification> {
  const data = await prView(prUrl, ["state"], ghRunner);
  if (data.state === "OPEN") {
    return { verified: true, reached, notes: ["pr-open: PR is OPEN"] };
  }
  return { verified: false, reached, notes: [`pr-open: PR state is ${data.state}`] };
}

/**
 * ci-green: all status checks at HEAD must be COMPLETED with a passing
 * conclusion. An empty check list means CI is absent — not green.
 */
async function verifyCiGreen(prUrl: string, reached: string | null, ghRunner: GhRunnerAsync): Promise<RungVerification> {
  const data = await prView(prUrl, ["statusCheckRollup"], ghRunner);
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
async function verifyReviewsClear(prUrl: string, reached: string | null, ghRunner: GhRunnerAsync): Promise<RungVerification> {
  const data = await prView(prUrl, ["reviews", "reviewDecision"], ghRunner);
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
async function verifyMergeable(prUrl: string, reached: string | null, ghRunner: GhRunnerAsync): Promise<RungVerification> {
  const data = await prView(prUrl, ["mergeable"], ghRunner);
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
async function verifyMergeReady(prUrl: string, reached: string | null, ghRunner: GhRunnerAsync): Promise<RungVerification> {
  const data = await prView(prUrl, ["mergeStateStatus"], ghRunner);
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
async function verifyMerged(prUrl: string, reached: string | null, ghRunner: GhRunnerAsync): Promise<RungVerification> {
  const data = await prView(prUrl, ["state"], ghRunner);
  if (data.state === "MERGED") {
    return { verified: true, reached, notes: ["merged: PR is MERGED"] };
  }
  return { verified: false, reached, notes: [`merged: PR state is ${data.state}`] };
}
