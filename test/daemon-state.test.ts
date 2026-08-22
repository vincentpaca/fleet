import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canTransition, isTerminal, isMarkerAllowed, INITIAL_STATE, STATES } from "../src/daemon/state.ts";
import { verifyRung, RUNG_LADDER } from "../src/daemon/verify.ts";

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

test("verifyRung: gh-dependent rung without PR URL reports missing URL", () => {
  const mockGh = (_args: string[]) => { throw new Error("should not be called"); };
  const result = verifyRung({ rung: "pr-open" }, "pr-open", { ghRunner: mockGh });
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /no PR URL/);
});

test("verifyRung: reached rung below target fails before gh is called", () => {
  const mockGh = (_args: string[]) => { throw new Error("should not be called"); };
  const result = verifyRung(prSettle("pushed", PR), "pr-open", { ghRunner: mockGh });
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /below target/);
});

test("verifyRung: pr-open verified when gh reports OPEN", () => {
  const mockGh = (args: string[]) => {
    assert.ok(args.includes(PR));
    return JSON.stringify({ state: "OPEN" });
  };
  const result = verifyRung(prSettle("pr-open", PR), "pr-open", { ghRunner: mockGh });
  assert.equal(result.verified, true);
  assert.match(result.notes.join(" "), /OPEN/);
});

test("verifyRung: pr-open fails when gh reports CLOSED", () => {
  const mockGh = (_args: string[]) => JSON.stringify({ state: "CLOSED" });
  const result = verifyRung(prSettle("pr-open", PR), "pr-open", { ghRunner: mockGh });
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /CLOSED/);
});

test("verifyRung: pushed verified by confirming PR head branch via gh", () => {
  const mockGh = (_args: string[]) => JSON.stringify({ headRefName: "fleet/APP-7-job-1" });
  const result = verifyRung(prSettle("pushed", PR), "pushed", { ghRunner: mockGh });
  assert.equal(result.verified, true);
  assert.match(result.notes.join(" "), /fleet\/APP-7-job-1/);
});

test("verifyRung: ci-green passes when all checks COMPLETED SUCCESS", () => {
  const checks = [
    { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "lint", status: "COMPLETED", conclusion: "NEUTRAL" },
  ];
  const mockGh = (_args: string[]) => JSON.stringify({ statusCheckRollup: checks });
  const result = verifyRung(prSettle("ci-green", PR), "ci-green", { ghRunner: mockGh });
  assert.equal(result.verified, true);
  assert.match(result.notes.join(" "), /2 check/);
});

test("verifyRung: ci-green fails when checks are absent (CI not configured)", () => {
  const mockGh = (_args: string[]) => JSON.stringify({ statusCheckRollup: [] });
  const result = verifyRung(prSettle("ci-green", PR), "ci-green", { ghRunner: mockGh });
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /absent or pending/);
});

test("verifyRung: ci-green fails when a check is still pending", () => {
  const checks = [
    { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "deploy-preview", status: "IN_PROGRESS", conclusion: null },
  ];
  const mockGh = (_args: string[]) => JSON.stringify({ statusCheckRollup: checks });
  const result = verifyRung(prSettle("ci-green", PR), "ci-green", { ghRunner: mockGh });
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /deploy-preview/);
});

test("verifyRung: reviews-clear passes with no blocking reviews", () => {
  const mockGh = (_args: string[]) =>
    JSON.stringify({ reviews: [{ state: "APPROVED" }], reviewDecision: "APPROVED" });
  const result = verifyRung(prSettle("reviews-clear", PR), "reviews-clear", { ghRunner: mockGh });
  assert.equal(result.verified, true);
});

test("verifyRung: reviews-clear fails when CHANGES_REQUESTED", () => {
  const mockGh = (_args: string[]) =>
    JSON.stringify({ reviews: [{ state: "CHANGES_REQUESTED" }], reviewDecision: "CHANGES_REQUESTED" });
  const result = verifyRung(prSettle("reviews-clear", PR), "reviews-clear", { ghRunner: mockGh });
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /CHANGES_REQUESTED/);
});

test("verifyRung: merge-ready passes when mergeStateStatus is CLEAN", () => {
  const mockGh = (_args: string[]) => JSON.stringify({ mergeStateStatus: "CLEAN" });
  const result = verifyRung(prSettle("merge-ready", PR), "merge-ready", { ghRunner: mockGh });
  assert.equal(result.verified, true);
});

test("verifyRung: merge-ready fails when CI is pending (UNSTABLE)", () => {
  const mockGh = (_args: string[]) => JSON.stringify({ mergeStateStatus: "UNSTABLE" });
  const result = verifyRung(prSettle("merge-ready", PR), "merge-ready", { ghRunner: mockGh });
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /UNSTABLE/);
});

test("verifyRung: gh errors are caught and reported as unverified", () => {
  const mockGh = (_args: string[]) => { throw new Error("rate limit exceeded"); };
  const result = verifyRung(prSettle("pr-open", PR), "pr-open", { ghRunner: mockGh });
  assert.equal(result.verified, false);
  assert.match(result.notes.join(" "), /rate limit/);
});
