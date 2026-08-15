import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(RUNG_LADDER[0], "inspected");
  assert.equal(RUNG_LADDER[1], "implemented");
  assert.equal(RUNG_LADDER.length, 13);
  assert.ok(RUNG_LADDER.indexOf("merge-ready") < RUNG_LADDER.indexOf("merged"));
});
