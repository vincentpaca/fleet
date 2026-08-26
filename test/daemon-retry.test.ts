// Harness-exit auto-retry (#30). Policy, settled in the issue: retry exactly
// once, only when zero decisions were answered (no human context to lose), and
// only within the remaining wall-clock budget. The record never rests on
// cancelled while retrying — the journal carries cancelled(harness-exit) then
// queued(reason=retry, attempt=2) so replay derives the same record — and a
// harness-exit that is NOT retried settles cancelled with the `fleet reclaim`
// incantation journalled, so "needs operator" is a transcript line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { FleetDaemon } from "../src/daemon/server.ts";
import { MANIFEST, WORK_ORDER, StubProvider, op, runnerPost, tempHome, until } from "./daemon-helpers.ts";

type JobShape = { id: string; state: string; reason?: string; attempt?: number };

async function startWithJob(manifest: unknown = MANIFEST) {
  const provider = new StubProvider();
  const home = tempHome();
  const daemon = new FleetDaemon({ home, provider });
  const { socketPath: sock } = await daemon.start();
  const created = await op(sock, "POST", "/jobs", { manifest, workOrder: WORK_ORDER });
  assert.equal(created.status, 201);
  const id = (created.json as { job: JobShape }).job.id;
  return { daemon, provider, home, sock, id };
}

const token = (daemon: FleetDaemon, id: string): string => daemon.registry.getJob(id)!.runnerToken;

const ev = (id: string, seq: number, body: Record<string, unknown>): string =>
  JSON.stringify({ job: id, seq, ...body });

const SETTLE_PARTIAL = {
  type: "settle",
  outcome: { produced: [], findings: 0, decisions: 0 },
  report: { status: "PARTIAL", next_action: "inspect harness exit 1" },
};

test("first harness-exit auto-retries once: re-queue, fresh launch, both attempts in the journal", async (t) => {
  const { daemon, provider, sock, id } = await startWithJob();
  t.after(() => daemon.stop());

  await runnerPost(sock, id, token(daemon, id), ev(id, 0, { type: "state", state: "running" }));
  await runnerPost(sock, id, token(daemon, id), ev(id, 1, SETTLE_PARTIAL));
  const firstToken = token(daemon, id);
  const res = await runnerPost(sock, id, firstToken, ev(id, 2, { type: "state", state: "cancelled", reason: "harness-exit" }));
  assert.equal(res.status, 200, "the runner's cancellation is accepted, not rejected");

  // The retry re-launches (deferred outside the intake batch).
  await until(() => provider.launches.length === 2);
  const job = daemon.registry.getJob(id)!;
  assert.equal(job.state, "queued", "the record never rests on cancelled while retrying");
  assert.equal(job.attempt, 2);
  const relaunch = provider.launches[1]!;
  assert.equal(relaunch.retryAttempt, 2, "the fresh runner is told which attempt it is");
  assert.notEqual(relaunch.runnerToken, firstToken, "the runner token rotates on relaunch");

  // Events record both attempts: the harness-exit stays, the re-queue follows.
  const events = daemon.registry.eventsAfter(id, -1);
  const cancelled = events.find((e) => e.type === "state" && e.state === "cancelled");
  assert.ok(cancelled, "attempt 1's harness-exit stays in the journal");
  assert.equal(cancelled!.reason, "harness-exit");
  const requeued = events.find((e) => e.type === "state" && e.state === "queued" && e.reason === "retry");
  assert.ok(requeued, "the daemon-authored re-queue is journalled");
  assert.equal(requeued!.attempt, 2, "the attempt count rides the event, absolute");
  assert.ok(requeued!.seq > cancelled!.seq, "re-queue follows the cancellation");

  // Attempt 2 starts its seq from 0 (fresh generation) and runs to done.
  const secondToken = token(daemon, id);
  const running2 = await runnerPost(sock, id, secondToken, ev(id, 0, { type: "state", state: "running" }));
  assert.equal(running2.status, 200, "queued -> running holds for the fresh runner at seq 0");
  await runnerPost(sock, id, secondToken, ev(id, 1, {
    type: "settle",
    outcome: { produced: [], findings: 0, decisions: 0 },
    rung: "implemented",
    report: { status: "READY", next_action: "review the change" },
  }));
  await runnerPost(sock, id, secondToken, ev(id, 2, { type: "state", state: "done" }));
  const done = daemon.registry.getJob(id)!;
  assert.equal(done.state, "done");
  assert.equal(done.attempt, 2, "the attempt count survives to the settled record");
});

test("a second harness-exit does NOT retry: settles cancelled and journals the reclaim incantation", async (t) => {
  const { daemon, provider, sock, id } = await startWithJob();
  t.after(() => daemon.stop());

  await runnerPost(sock, id, token(daemon, id), ev(id, 0, { type: "state", state: "running" }));
  await runnerPost(sock, id, token(daemon, id), ev(id, 1, SETTLE_PARTIAL));
  await runnerPost(sock, id, token(daemon, id), ev(id, 2, { type: "state", state: "cancelled", reason: "harness-exit" }));
  await until(() => provider.launches.length === 2);

  // Attempt 2 dies the same way.
  const secondToken = token(daemon, id);
  await runnerPost(sock, id, secondToken, ev(id, 0, { type: "state", state: "running" }));
  await runnerPost(sock, id, secondToken, ev(id, 1, SETTLE_PARTIAL));
  await runnerPost(sock, id, secondToken, ev(id, 2, { type: "state", state: "cancelled", reason: "harness-exit" }));

  // Give any (buggy) deferred relaunch a tick to fire, then hold the line.
  await sleep(50);
  assert.equal(provider.launches.length, 2, "exactly one automatic retry, never two");
  const job = daemon.registry.getJob(id)!;
  assert.equal(job.state, "cancelled");
  assert.equal(job.reason, "harness-exit");
  assert.equal(job.attempt, 2, "a job that failed twice must not look like one that failed once");
  const logs = daemon.registry.eventsAfter(id, -1).filter((e) => e.type === "log");
  const loud = logs.find((e) => typeof e.text === "string" && e.text.includes("not auto-retrying"));
  assert.ok(loud, "the refusal is journalled");
  assert.match(String(loud!.text), /fleet reclaim APP-123/, "the operator is told the exact next command");
});

test("an answered decision blocks the retry: human context is never re-rolled", async (t) => {
  const { daemon, provider, sock, id } = await startWithJob();
  t.after(() => daemon.stop());

  await runnerPost(sock, id, token(daemon, id), ev(id, 0, { type: "state", state: "running" }));
  await runnerPost(sock, id, token(daemon, id), ev(id, 1, {
    type: "decision",
    id: "d1",
    question: "Proceed how?",
    options: [
      { id: "a", label: "Plan A", recommended: true },
      { id: "b", label: "Plan B" },
    ],
  }));
  const answered = await op(sock, "POST", `/jobs/${id}/answer`, { option: "a" });
  assert.equal(answered.status, 200);

  await runnerPost(sock, id, token(daemon, id), ev(id, 2, SETTLE_PARTIAL));
  await runnerPost(sock, id, token(daemon, id), ev(id, 3, { type: "state", state: "cancelled", reason: "harness-exit" }));
  await sleep(50);

  assert.equal(provider.launches.length, 1, "no relaunch after a human answered");
  const job = daemon.registry.getJob(id)!;
  assert.equal(job.state, "cancelled");
  assert.equal(job.reason, "harness-exit");
  const logs = daemon.registry.eventsAfter(id, -1).filter((e) => e.type === "log");
  assert.ok(
    logs.some((e) => typeof e.text === "string" && e.text.includes("decisions were answered")),
    "the refusal names its reason",
  );
});

test("a spent wall-clock budget blocks the retry", async (t) => {
  const manifest = { ...MANIFEST, limits: { wall_clock: "1s" } };
  const { daemon, provider, sock, id } = await startWithJob(manifest);
  t.after(() => daemon.stop());

  await runnerPost(sock, id, token(daemon, id), ev(id, 0, { type: "state", state: "running" }));
  // Burn past the 1s budget while active, then fail with harness-exit.
  await sleep(1_100);
  await runnerPost(sock, id, token(daemon, id), ev(id, 1, SETTLE_PARTIAL));
  await runnerPost(sock, id, token(daemon, id), ev(id, 2, { type: "state", state: "cancelled", reason: "harness-exit" }));
  await sleep(50);

  assert.equal(provider.launches.length, 1, "no relaunch without remaining budget");
  assert.equal(daemon.registry.getJob(id)!.state, "cancelled");
  const logs = daemon.registry.eventsAfter(id, -1).filter((e) => e.type === "log");
  assert.ok(
    logs.some((e) => typeof e.text === "string" && e.text.includes("wall-clock budget is spent")),
    "the refusal names its reason",
  );
});

test("a failed retry launch cancels loudly instead of stranding the job queued", async (t) => {
  const { daemon, provider, sock, id } = await startWithJob();
  t.after(() => daemon.stop());

  await runnerPost(sock, id, token(daemon, id), ev(id, 0, { type: "state", state: "running" }));
  await runnerPost(sock, id, token(daemon, id), ev(id, 1, SETTLE_PARTIAL));
  provider.failNextLaunch = true;
  await runnerPost(sock, id, token(daemon, id), ev(id, 2, { type: "state", state: "cancelled", reason: "harness-exit" }));

  await until(() => daemon.registry.getJob(id)!.state === "cancelled");
  const job = daemon.registry.getJob(id)!;
  assert.equal(job.reason, "launch-failed", "the failure is a terminal fact, not a silent queued forever");
});

test("boot recovery finishes a retry whose launch died with the old daemon", async (t) => {
  const { daemon, provider, home, sock, id } = await startWithJob();

  await runnerPost(sock, id, token(daemon, id), ev(id, 0, { type: "state", state: "running" }));
  await runnerPost(sock, id, token(daemon, id), ev(id, 1, SETTLE_PARTIAL));
  await runnerPost(sock, id, token(daemon, id), ev(id, 2, { type: "state", state: "cancelled", reason: "harness-exit" }));
  await until(() => provider.launches.length === 2);
  // The job is queued as attempt 2 and no runner has spoken yet: exactly the
  // shape a crash between re-queue and launch leaves behind. Restart onto the
  // same home — no sweep covers queued, so boot recovery must relaunch it.
  await daemon.stop();

  const provider2 = new StubProvider();
  const daemon2 = new FleetDaemon({ home, provider: provider2 });
  await daemon2.start();
  t.after(() => daemon2.stop());

  await until(() => provider2.launches.length === 1);
  assert.equal(provider2.launches[0]!.retryAttempt, 2, "boot finishes the journalled retry, not a fresh dispatch");
  const job = daemon2.registry.getJob(id)!;
  assert.equal(job.state, "queued");
  assert.equal(job.attempt, 2);
});
