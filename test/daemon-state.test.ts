import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canTransition, isTerminal, isMarkerAllowed, INITIAL_STATE, STATES } from "../src/daemon/state.ts";
import { verifyRung, verifyRungGh, RUNG_LADDER, INVALID_PR_NOTE } from "../src/daemon/verify.ts";

test("state machine mirrors schemas/job-states.json", () => {
  assert.equal(INITIAL_STATE, "queued");
  assert.deepEqual([...STATES], ["queued", "running", "blocked", "done", "cancelled"]);

  // Legal transitions
  assert.ok(canTransition("queued", "running"));
  assert.ok(canTransition("queued", "cancelled"));
  assert.ok(canTransition("running", "blocked"));
  assert.ok(canTransition("blocked", "running"));
  assert.ok(canTransition("running", "done"));
  assert.ok(canTransition("running", "cancelled"));
  assert.ok(canTransition("blocked", "cancelled"));

  // Illegal transitions
  assert.ok(!canTransition("queued", "blocked"));
  assert.ok(!canTransition("queued", "done"));
  assert.ok(!canTransition("blocked", "done"));
  assert.ok(!canTransition("done", "running"));
  assert.ok(!canTransition("done", "cancelled"));
  assert.ok(!canTransition("cancelled", "running"));
  assert.ok(!canTransition("running", "queued"));
  assert.ok(!canTransition("running", "running"));
});

test("terminal states are done and cancelled", () => {
  assert.ok(isTerminal("done"));
  assert.ok(isTerminal("cancelled"));
  assert.ok(!isTerminal("queued"));
  assert.ok(!isTerminal("running"));
  assert.ok(!isTerminal("blocked"));
});

test("parked/stale markers ride only on blocked", () => {
  for (const marker of ["parked", "stale"] as const) {
    assert.ok(isMarkerAllowed("blocked", marker));
    assert.ok(!isMarkerAllowed("running", marker));
    assert.ok(!isMarkerAllowed("queued", marker));
    assert.ok(!isMarkerAllowed("done", marker));
    assert.ok(!isMarkerAllowed("cancelled", marker));
  }
});

test("verifyRung: locally verifiable rungs check reached vs target", () => {
  const settle = { rung: "implemented", outcome: { produced: [], findings: 0, decisions: 0 } };
  assert.equal(verifyRung(settle, "implemented").verified, true);
  assert.equal(verifyRung(settle, "inspected").verified, true);

  const low = verifyRung({ rung: "inspected" }, "implemented");
  assert.equal(low.verified, false);
  assert.match(low.notes.join(" "), /below target/);

  const none = verifyRung({}, "implemented");
  assert.equal(none.verified, false);
  assert.equal(none.reached, null);
});

test("verifyRung: gh-dependent rungs stay an unverified seam", () => {
  for (const target of ["pushed", "pr-open", "ci-green", "reviews-clear", "merge-ready", "merged"]) {
    const result = verifyRung({ rung: target }, target);
    assert.equal(result.verified, false);
    assert.deepEqual(result.notes, ["unverified: requires gh"]);
    assert.equal(result.reached, target);
  }
});

test("verifyRung: local-gate rungs and edge cases", () => {
  const gate = verifyRung({ rung: "focused-green" }, "focused-green");
  assert.equal(gate.verified, false);
  assert.match(gate.notes.join(" "), /local gate/);

  const missing = verifyRung(undefined, "implemented");
  assert.equal(missing.verified, false);
  assert.deepEqual(missing.notes, ["no settle event recorded"]);

  const unknown = verifyRung({ rung: "implemented" }, "not-a-rung");
  assert.equal(unknown.verified, false);
  assert.match(unknown.notes.join(" "), /unknown target rung/);
});

test("rung ladder matches the work-order schema order", () => {
  // The schema's rung enum is the source of truth; verify.ts keeps a parallel
  // ordered copy. Compare the two whole, so drift in either direction fails.
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/work-order.schema.json", import.meta.url), "utf8"),
  ) as { $defs: { rung: { enum: string[] } } };
  assert.deepEqual([...RUNG_LADDER], schema.$defs.rung.enum);
});

// --- gh-runner verification (issue #3) ---

function prSettle(rung: string, pr?: string): import("../src/daemon/verify.ts").SettleFacts {
  return {
    rung,
    outcome: { produced: [], findings: 0, decisions: 0 },
    ...(pr !== undefined ? { report: { status: "READY", next_action: "review", pr } } : {}),
  };
}

const PR = "https://github.com/owner/repo/pull/1";

test("verifyRung: gh-dependent rung without ghRunner stays unverified: requires gh", () => {
  // Without a ghRunner, gh-dependent rungs must still return the legacy note.
  for (const target of ["pushed", "pr-open", "ci-green", "reviews-clear", "mergeable", "merge-ready"]) {
    const result = verifyRung(prSettle(target, PR), target);
    assert.equal(result.verified, false);
    assert.deepEqual(result.notes, ["unverified: requires gh"]);
  }
});

test("verifyRungGh: gh-dependent rung without PR URL reports missing URL", async () => {
  const mockGh = async (_args: string[]) => { throw new Error("should not be called"); };
  const result = await verifyRungGh({ rung: "pr-open" }, "pr-open", mockGh);
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /no PR URL/);
});

test("verifyRungGh: reached rung below target fails before gh is called", async () => {
  const mockGh = async (_args: string[]) => { throw new Error("should not be called"); };
  const result = await verifyRungGh(prSettle("pushed", PR), "pr-open", mockGh);
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /below target/);
});

test("verifyRungGh: pr-open verified when gh reports OPEN", async () => {
  const mockGh = async (args: string[]) => {
    assert.ok(args.includes(PR));
    return JSON.stringify({ state: "OPEN" });
  };
  const result = await verifyRungGh(prSettle("pr-open", PR), "pr-open", mockGh);
  assert.equal(result.verified, true);
  assert.match(result.notes.join(" "), /OPEN/);
});

test("verifyRungGh: pr-open fails when gh reports CLOSED", async () => {
  const mockGh = async (_args: string[]) => JSON.stringify({ state: "CLOSED" });
  const result = await verifyRungGh(prSettle("pr-open", PR), "pr-open", mockGh);
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /CLOSED/);
});

test("verifyRungGh: pushed verified by confirming PR head branch via gh", async () => {
  const mockGh = async (_args: string[]) => JSON.stringify({ headRefName: "fleet/APP-7-job-1" });
  const result = await verifyRungGh(prSettle("pushed", PR), "pushed", mockGh);
  assert.equal(result.verified, true);
  assert.match(result.notes.join(" "), /fleet\/APP-7-job-1/);
});

test("verifyRungGh: ci-green passes when all checks COMPLETED SUCCESS", async () => {
  const checks = [
    { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "lint", status: "COMPLETED", conclusion: "NEUTRAL" },
  ];
  const mockGh = async (_args: string[]) => JSON.stringify({ statusCheckRollup: checks });
  const result = await verifyRungGh(prSettle("ci-green", PR), "ci-green", mockGh);
  assert.equal(result.verified, true);
  assert.match(result.notes.join(" "), /2 check/);
});

test("verifyRungGh: ci-green fails when checks are absent (CI not configured)", async () => {
  const mockGh = async (_args: string[]) => JSON.stringify({ statusCheckRollup: [] });
  const result = await verifyRungGh(prSettle("ci-green", PR), "ci-green", mockGh);
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /absent or pending/);
});

test("verifyRungGh: ci-green fails when a check is still pending", async () => {
  const checks = [
    { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "deploy-preview", status: "IN_PROGRESS", conclusion: null },
  ];
  const mockGh = async (_args: string[]) => JSON.stringify({ statusCheckRollup: checks });
  const result = await verifyRungGh(prSettle("ci-green", PR), "ci-green", mockGh);
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /deploy-preview/);
});

test("verifyRungGh: reviews-clear passes with no blocking reviews", async () => {
  const mockGh = async (_args: string[]) =>
    JSON.stringify({ reviews: [{ state: "APPROVED" }], reviewDecision: "APPROVED" });
  const result = await verifyRungGh(prSettle("reviews-clear", PR), "reviews-clear", mockGh);
  assert.equal(result.verified, true);
});

test("verifyRungGh: reviews-clear fails when CHANGES_REQUESTED", async () => {
  const mockGh = async (_args: string[]) =>
    JSON.stringify({ reviews: [{ state: "CHANGES_REQUESTED" }], reviewDecision: "CHANGES_REQUESTED" });
  const result = await verifyRungGh(prSettle("reviews-clear", PR), "reviews-clear", mockGh);
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /CHANGES_REQUESTED/);
});

test("verifyRungGh: merge-ready passes when mergeStateStatus is CLEAN", async () => {
  const mockGh = async (_args: string[]) => JSON.stringify({ mergeStateStatus: "CLEAN" });
  const result = await verifyRungGh(prSettle("merge-ready", PR), "merge-ready", mockGh);
  assert.equal(result.verified, true);
});

test("verifyRungGh: merge-ready fails when CI is pending (UNSTABLE)", async () => {
  const mockGh = async (_args: string[]) => JSON.stringify({ mergeStateStatus: "UNSTABLE" });
  const result = await verifyRungGh(prSettle("merge-ready", PR), "merge-ready", mockGh);
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /UNSTABLE/);
});

test("verifyRungGh: gh errors are caught and reported as unverified", async () => {
  const mockGh = async (_args: string[]) => { throw new Error("rate limit exceeded"); };
  const result = await verifyRungGh(prSettle("pr-open", PR), "pr-open", mockGh);
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /rate limit/);
});

// --- report.pr is job-authored: it must never reach gh argv unvalidated (#175) ---

test("verifyRungGh: flag-shaped or malformed report.pr never reaches gh argv", async () => {
  const invocations: string[][] = [];
  const recordingGh = async (args: string[]) => {
    invocations.push(args);
    return JSON.stringify({ state: "OPEN" });
  };
  const hostile = [
    "--web",
    "-R evil/repo",
    "7; rm -rf /",
    "owner/repo#7",
    "https://github.com/owner/repo/pull/7 --web",
    "http://github.com/owner/repo/pull/7",
  ];
  for (const pr of hostile) {
    const result = await verifyRungGh(prSettle("pr-open", pr), "pr-open", recordingGh);
    assert.equal(result.verified, false, `must not verify with pr=${JSON.stringify(pr)}`);
    assert.deepEqual(result.notes, [INVALID_PR_NOTE]);
  }
  // Empty string is caught earlier as a missing URL — same guarantee, its own note.
  const empty = await verifyRungGh(prSettle("pr-open", ""), "pr-open", recordingGh);
  assert.equal(empty.verified, false);
  assert.match(empty.notes.join(" "), /no PR URL/);
  assert.deepEqual(invocations, [], "gh must never be invoked with a rejected report.pr");
});

test("verifyRungGh: a legitimate PR URL verifies with -- before the positional", async () => {
  let seen: string[] | undefined;
  const mockGh = async (args: string[]) => {
    seen = args;
    return JSON.stringify({ state: "OPEN" });
  };
  const result = await verifyRungGh(prSettle("pr-open", PR), "pr-open", mockGh);
  assert.equal(result.verified, true);
  assert.match(result.notes.join(" "), /pr-open: PR is OPEN/);
  assert.deepEqual(seen, ["pr", "view", "--json", "state", "--", PR]);
});
