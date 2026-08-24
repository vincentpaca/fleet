// The answer path's races (#114) and the marker gap (#151).
//
// #answer checks "blocked with an open decision" and then awaits the request
// body — anything can complete in that await. These tests drive the handler
// through the interleavings that used to resurrect cancelled jobs, launch a
// parked job twice, and strand a gap answer on a runner that had already
// committed to parking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { FleetDaemon } from "../src/daemon/server.ts";
import { parseNdjson } from "../src/shared/ndjson.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost, until } from "./daemon-helpers.ts";

const LONG_POLL_MS = 300;

type Ctx = { daemon: FleetDaemon; sock: string; provider: StubProvider; home: string };

async function startDaemon(home = tempHome()): Promise<Ctx> {
  const provider = new StubProvider();
  const daemon = new FleetDaemon({ home, provider, longPollMs: LONG_POLL_MS });
  const { socketPath } = await daemon.start();
  return { daemon, sock: socketPath, provider, home };
}

type Job = { id: string; state: string; marker?: string; reason?: string } & Record<string, unknown>;

function jobOf(json: unknown): Job {
  const body = json as { job: Job };
  assert.ok(body.job, `expected {job} body, got ${JSON.stringify(json)}`);
  return body.job;
}

async function createJob(ctx: Ctx): Promise<{ id: string; token: string }> {
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(res.status, 201, res.body);
  const job = jobOf(res.json);
  const launch = ctx.provider.launches.find((l) => l.jobId === job.id);
  assert.ok(launch, "provider.launch not called");
  return { id: job.id, token: launch.runnerToken };
}

function event(job: string, seq: number, rest: Record<string, unknown>): string {
  return JSON.stringify({ job, seq, ...rest });
}

const DECISION = {
  type: "decision",
  id: "d1",
  question: "Ship behind a feature flag?",
  options: [
    { id: "flag", label: "Feature flag", recommended: true },
    { id: "direct", label: "Ship directly" },
  ],
};

async function events(ctx: Ctx, id: string): Promise<Record<string, unknown>[]> {
  const res = await op(ctx.sock, "GET", `/jobs/${id}/events`);
  return parseNdjson(res.body) as Record<string, unknown>[];
}

/**
 * POST whose body arrives in two writes, so another request can complete while
 * the handler is parked inside `await readBody` — the exact window #114 races.
 */
function slowPost(sock: string, path: string, body: string): {
  finish: () => void;
  done: Promise<{ status: number; body: string }>;
} {
  const req = http.request({
    socketPath: sock,
    path,
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  });
  const split = 2;
  req.write(body.slice(0, split));
  const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on("response", (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
  });
  return { finish: () => req.end(body.slice(split)), done };
}

test("a cancel completing during the answer's body read does not resurrect the job (#114)", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, { type: "decision", ...DECISION }));
  assert.equal(jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json).state, "blocked");

  // The answer's pre-checks pass (blocked, open decision), then it awaits the
  // body. A cancel completes in that window.
  const slow = slowPost(ctx.sock, `/jobs/${id}/answer`, JSON.stringify({ option: "flag" }));
  await sleep(50);
  const cancelled = await op(ctx.sock, "POST", `/jobs/${id}/cancel`);
  assert.equal(cancelled.status, 200, cancelled.body);

  slow.finish();
  const res = await slow.done;
  assert.equal(res.status, 409, `answer after cancel must 409, got ${res.status}: ${res.body}`);

  // The job stays terminal; no answer event lands after cancelled.
  const job = jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "cancelled");
  const log = await events(ctx, id);
  assert.ok(!log.some((e) => e.type === "answer"), "no answer event may land on a cancelled job");
  const lastState = [...log].reverse().find((e) => e.type === "state");
  assert.equal(lastState?.state, "cancelled");
});

test("two concurrent answers to a parked job: one 200, one 409, exactly one re-launch (#114)", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, { type: "decision", ...DECISION }));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));
  assert.equal(jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json).marker, "parked");

  // Both requests pass the pre-await checks before either body completes.
  const body = JSON.stringify({ option: "flag" });
  const first = slowPost(ctx.sock, `/jobs/${id}/answer`, body);
  const second = slowPost(ctx.sock, `/jobs/${id}/answer`, body);
  await sleep(50);
  first.finish();
  second.finish();
  const results = await Promise.all([first.done, second.done]);

  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify(results));

  // Exactly one re-entry launch (the other launch is the original dispatch),
  // and exactly one answer event for the one decision.
  const reentries = ctx.provider.launches.filter((l) => l.reentryAnswer !== undefined);
  assert.equal(reentries.length, 1, "a decision must be claimed by exactly one answer");
  assert.equal(ctx.provider.launches.length, 2);
  const log = await events(ctx, id);
  assert.equal(log.filter((e) => e.type === "answer").length, 1);
});

test("an answer in the marker gap re-launches once the late park lands; the job stays answerable (#151)", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, { type: "decision", ...DECISION }));

  // The gap: block_hot has expired runner-side (poller stopped, WIP pushing)
  // but the blocked/parked event has not landed. The job is blocked with no
  // marker, so the answer takes the hot path.
  const answered = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(answered.status, 200, answered.body);
  assert.equal(jobOf(answered.json).state, "running");

  // The hot transition is in the journal (#114): a replay consumer must see
  // blocked → running, not infer it.
  const midLog = await events(ctx, id);
  const answerSeq = midLog.find((e) => e.type === "answer")?.seq as number;
  const hotRunning = midLog.find((e) => e.type === "state" && e.state === "running" && (e.seq as number) > answerSeq);
  assert.ok(hotRunning, "the daemon's blocked → running transition must land in the event log");

  // The late park arrives: the runner was gone all along.
  const parked = await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));
  assert.equal(parked.status, 200, parked.body);

  // The daemon notices the park answers an already-claimed decision and
  // finishes the re-entry the runner never collected.
  await until(() => ctx.provider.launches.length === 2, 5_000);
  const relaunch = ctx.provider.launches[1];
  assert.equal(relaunch.jobId, id);
  assert.equal(relaunch.reentryAnswer?.decisionId, "d1");
  assert.equal(relaunch.reentryAnswer?.answer.option, "flag");
  assert.notEqual(relaunch.runnerToken, token, "re-entry must rotate the runner token");

  // The old runner is fenced: its token no longer authenticates.
  const stale = await runnerPost(ctx.sock, id, token, event(id, 3, { type: "log", text: "late", who: "runner" }));
  assert.equal(stale.status, 401);

  // Consistent and answerable end-state: the fresh runner picks up (seq reset
  // to 0), raises a new decision, and the operator can answer it.
  const job = jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "blocked");
  assert.equal(job.marker, undefined, "recovery must clear the parked marker");
  const newToken = relaunch.runnerToken;
  const resumed = await runnerPost(ctx.sock, id, newToken, event(id, 0, { type: "state", state: "running" }));
  assert.equal(resumed.status, 200, resumed.body);
  const d2 = { ...DECISION, id: "d2" };
  const decided = await runnerPost(ctx.sock, id, newToken, event(id, 1, { type: "decision", ...d2 }));
  assert.equal(decided.status, 200, decided.body);
  const answered2 = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "direct" });
  assert.equal(answered2.status, 200, answered2.body);
});

test("a late park after a hot answer with a live runner is not misread: normal park still parks", async (t) => {
  // Guard the guard: a park landing while its decision is still open (the
  // ordinary flow) must not trigger any recovery launch.
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, { type: "decision", ...DECISION }));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));
  await sleep(100); // any recovery would fire on setImmediate; give it room
  assert.equal(ctx.provider.launches.length, 1, "an unanswered park must not re-launch");
  const job = jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "blocked");
  assert.equal(job.marker, "parked");
});
