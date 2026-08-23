import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { FleetDaemon } from "../src/daemon/server.ts";
import { parseNdjson } from "../src/shared/ndjson.ts";
import { request } from "../src/shared/http.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost, until } from "./daemon-helpers.ts";
import type { ResourceRequest } from "../src/providers/provider.ts";

const LONG_POLL_MS = 300;

type Ctx = { daemon: FleetDaemon; sock: string; provider: StubProvider; home: string };

async function startDaemon(home = tempHome()): Promise<Ctx> {
  const provider = new StubProvider();
  const daemon = new FleetDaemon({ home, provider, longPollMs: LONG_POLL_MS });
  const { socketPath } = await daemon.start();
  return { daemon, sock: socketPath, provider, home };
}

type Job = {
  id: string;
  state: string;
  marker?: string;
  handle?: string;
  settle?: { rung?: string };
  doneCheck?: { verified: boolean; notes: string[]; target: string };
} & Record<string, unknown>;

function jobOf(json: unknown): Job {
  const body = json as { job: Job };
  assert.ok(body.job, `expected {job} body, got ${JSON.stringify(json)}`);
  return body.job;
}

/** Create a job and return {id, token} straight from the stub provider. */
async function createJob(ctx: Ctx, workOrder: unknown = WORK_ORDER): Promise<{ id: string; token: string }> {
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder, manifest: MANIFEST });
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

const SETTLE = {
  type: "settle",
  rung: "implemented",
  minutes: 12,
  outcome: { produced: [], findings: 0, decisions: 0 },
};

test("POST /jobs rejects invalid manifest and work order with 422", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: { mode: "bogus" }, manifest: { nope: 1 } });
  assert.equal(res.status, 422);
  const { errors } = res.json as { errors: { in: string; message?: string }[] };
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.in === "manifest"));
  assert.ok(errors.some((e) => e.in === "workOrder"));

  // Nothing was created or launched.
  const list = await op(ctx.sock, "GET", "/jobs");
  assert.deepEqual((list.json as { jobs: unknown[] }).jobs, []);
  assert.equal(ctx.provider.launches.length, 0);
});

test("POST /jobs rejects non-string env/sync values with 422", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const res = await op(ctx.sock, "POST", "/jobs", {
    workOrder: WORK_ORDER,
    manifest: MANIFEST,
    env: { GOOD: "1", BAD: 42 },
  });
  assert.equal(res.status, 422);
});

test("POST /jobs creates a queued job, appends first state event with meta, launches", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  const res = await op(ctx.sock, "POST", "/jobs", {
    workOrder: WORK_ORDER,
    manifest: MANIFEST,
    env: { EXAMPLE_TOKEN: "abc" },
    sync: { ".env.development": Buffer.from("A=1\n").toString("base64") },
  });
  assert.equal(res.status, 201, res.body);
  const job = jobOf(res.json);
  assert.equal(job.state, "queued");
  assert.ok(!("runnerToken" in job), "runnerToken must never appear on operator responses");
  assert.equal(job.handle, `stub:${job.id}`);

  const launch = ctx.provider.launches[0];
  assert.equal(launch.jobId, job.id);
  assert.match(launch.daemonUrl, /^unix:/);
  assert.equal(launch.image, "node:22");
  assert.equal(launch.env.EXAMPLE_TOKEN, "abc");
  assert.ok(launch.runnerToken.length >= 64);

  const events = await op(ctx.sock, "GET", `/jobs/${job.id}/events`);
  const lines = parseNdjson(events.body) as Record<string, unknown>[];
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "state");
  assert.equal(lines[0].state, "queued");
  assert.equal(lines[0].seq, 0);
  const meta = lines[0].meta as { kind: string; target: string; fleet: unknown[] };
  assert.equal(meta.kind, "delegated");
  assert.equal(meta.target, "APP-123");

  const single = await op(ctx.sock, "GET", `/jobs/${job.id}`);
  assert.equal(single.status, 200);
  assert.ok(!("runnerToken" in jobOf(single.json)));
});

test("launch failure cancels the job and returns 500", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  ctx.provider.failNextLaunch = true;
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(res.status, 500);
  assert.equal(jobOf(res.json).state, "cancelled");
});

test("runner intake: bad token 401, schema violation / wrong job / bad seq / illegal transition 422", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  // Bad token
  const unauth = await runnerPost(ctx.sock, id, "not-the-token", event(id, 0, { type: "state", state: "running" }));
  assert.equal(unauth.status, 401);

  // Schema violation: unknown type
  const badSchema = await runnerPost(ctx.sock, id, token, event(id, 0, { type: "explode" }));
  assert.equal(badSchema.status, 422);

  // Schema violation: state event without state
  const noState = await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state" }));
  assert.equal(noState.status, 422);

  // Wrong job id in body
  const wrongJob = await runnerPost(ctx.sock, id, token, event("job-other", 0, { type: "state", state: "running" }));
  assert.equal(wrongJob.status, 422);

  // Illegal transition: queued -> done
  const illegal = await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "done" }));
  assert.equal(illegal.status, 422);
  assert.match(illegal.body, /illegal transition/);

  // Nothing appended so far: only the daemon's queued event exists.
  const events = await op(ctx.sock, "GET", `/jobs/${id}/events`);
  assert.equal((parseNdjson(events.body) as unknown[]).length, 1);

  // Legal first event
  const ok = await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  assert.equal(ok.status, 200, ok.body);
  assert.equal(jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json).state, "running");

  // Replayed seq carrying different content rejected — named for what it is
  // (#113's tripwire), not as an ordering complaint.
  const replay = await runnerPost(ctx.sock, id, token, event(id, 0, { type: "think", text: "again" }));
  assert.equal(replay.status, 422);
  assert.match(replay.body, /already recorded with different content/);

  // Lower seq rejected even after a gap. Seq 4 was never recorded, so there is
  // nothing to compare it against and the ordering rule is what refuses it.
  const gap = await runnerPost(ctx.sock, id, token, event(id, 7, { type: "think", text: "gap ok" }));
  assert.equal(gap.status, 200);
  const lower = await runnerPost(ctx.sock, id, token, event(id, 4, { type: "think", text: "backwards" }));
  assert.equal(lower.status, 422);
  assert.match(lower.body, /monotonically increasing/);

  // Runners may never post answers
  const answer = await runnerPost(ctx.sock, id, token, event(id, 8, { type: "answer", decision: "d1", by: "runner" }));
  assert.equal(answer.status, 422);
  assert.match(answer.body, /operator/);

  // Marker only on blocked
  const marker = await runnerPost(
    ctx.sock,
    id,
    token,
    event(id, 9, { type: "state", state: "cancelled", marker: "parked" }),
  );
  assert.equal(marker.status, 422);
  assert.match(marker.body, /marker/);
});

test("runner intake accepts an ndjson batch", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  const batch =
    event(id, 0, { type: "state", state: "running" }) +
    "\n" +
    event(id, 1, { type: "phase", text: "pickup" }) +
    "\n" +
    event(id, 2, { type: "think", text: "reading the ticket" }) +
    "\n";
  const res = await runnerPost(ctx.sock, id, token, batch);
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body), { appended: 3 });

  // A batch with a bad tail appends the good prefix and reports the failure.
  const mixed =
    event(id, 3, { type: "log", text: "ok" }) + "\n" + event(id, 3, { type: "log", text: "dup seq" }) + "\n";
  const partial = await runnerPost(ctx.sock, id, token, mixed);
  assert.equal(partial.status, 422);
  assert.equal((JSON.parse(partial.body) as { appended: number }).appended, 1);
});

test("decision blocks the job; operator answer validates options, resumes, wakes runner poll", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  // Decision while queued is an illegal transition.
  const early = await runnerPost(ctx.sock, id, token, event(id, 0, { type: "decision", ...DECISION }));
  assert.equal(early.status, 422);

  await runnerPost(ctx.sock, id, token, event(id, 1, { type: "state", state: "running" }));
  const blocked = await runnerPost(ctx.sock, id, token, event(id, 2, DECISION));
  assert.equal(blocked.status, 200, blocked.body);
  assert.equal(jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json).state, "blocked");

  // Runner long-poll parked before the answer arrives.
  const poll = request({
    socketPath: ctx.sock,
    path: `/internal/jobs/${id}/answer?decision=d1`,
    headers: { "x-fleet-runner-token": token },
  });

  // Invalid option id is refused — never downgraded to free text.
  const badOption = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "nope" });
  assert.equal(badOption.status, 422);
  const emptyAnswer = await op(ctx.sock, "POST", `/jobs/${id}/answer`, {});
  assert.equal(emptyAnswer.status, 422);
  const badWithText = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "nope", text: "do it anyway" });
  assert.equal(badWithText.status, 422);

  const answered = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag", text: "roll out slowly" });
  assert.equal(answered.status, 200, answered.body);
  assert.equal(jobOf(answered.json).state, "running");

  // The parked long-poll wakes with the chosen option.
  const woken = await poll;
  assert.equal(woken.status, 200);
  assert.deepEqual(JSON.parse(woken.body), { option: "flag", text: "roll out slowly" });

  // Answer event recorded with operator identity.
  const events = parseNdjson((await op(ctx.sock, "GET", `/jobs/${id}/events`)).body) as Record<string, unknown>[];
  const answerEvent = events.find((e) => e.type === "answer");
  assert.ok(answerEvent);
  assert.equal(answerEvent.by, "operator");
  assert.equal(answerEvent.decision, "d1");

  // Job no longer blocked: answering again is refused.
  const again = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(again.status, 409);
});

test("free-text answer is allowed without an option", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, DECISION));

  const res = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { text: "use the flag, remove it next sprint" });
  assert.equal(res.status, 200, res.body);
  assert.equal(jobOf(res.json).state, "running");
});

test("runner answer poll times out with 204 when unanswered", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, DECISION));

  const res = await request({
    socketPath: ctx.sock,
    path: `/internal/jobs/${id}/answer?decision=d1`,
    headers: { "x-fleet-runner-token": token },
  });
  assert.equal(res.status, 204);
  assert.equal(res.body, "");
});

test("POST /internal/jobs/:id/answer does not exist (runner token cannot answer)", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  const res = await request({
    socketPath: ctx.sock,
    method: "POST",
    path: `/internal/jobs/${id}/answer`,
    headers: { "x-fleet-runner-token": token, "content-type": "application/json" },
    body: JSON.stringify({ option: "flag" }),
  });
  assert.equal(res.status, 404);
});

test("GET /jobs orders blocked-first per RANK", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  // Created in reverse-RANK order so the sort has to do real work.
  const cancelled = await createJob(ctx);
  await op(ctx.sock, "POST", `/jobs/${cancelled.id}/cancel`);

  const done = await createJob(ctx);
  await runnerPost(ctx.sock, done.id, done.token, event(done.id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, done.id, done.token, event(done.id, 1, SETTLE));
  await runnerPost(ctx.sock, done.id, done.token, event(done.id, 2, { type: "state", state: "done" }));

  const queued = await createJob(ctx);

  const running = await createJob(ctx);
  await runnerPost(ctx.sock, running.id, running.token, event(running.id, 0, { type: "state", state: "running" }));

  const blocked = await createJob(ctx);
  await runnerPost(ctx.sock, blocked.id, blocked.token, event(blocked.id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, blocked.id, blocked.token, event(blocked.id, 1, DECISION));

  const list = (await op(ctx.sock, "GET", "/jobs")).json as { jobs: { id: string; state: string }[] };
  assert.deepEqual(
    list.jobs.map((j) => j.state),
    ["blocked", "running", "queued", "done", "cancelled"],
  );
  assert.deepEqual(
    list.jobs.map((j) => j.id),
    [blocked.id, running.id, queued.id, done.id, cancelled.id],
  );
});

test("GET /jobs/:id/events supports ?after and ?follow long-poll wake", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));

  const all = parseNdjson((await op(ctx.sock, "GET", `/jobs/${id}/events`)).body) as { seq: number }[];
  assert.deepEqual(all.map((e) => e.seq), [0, 1]);

  const after0 = parseNdjson((await op(ctx.sock, "GET", `/jobs/${id}/events?after=0`)).body) as { seq: number }[];
  assert.deepEqual(after0.map((e) => e.seq), [1]);

  // follow=1 holds the connection and streams the event posted mid-poll.
  const follow = request({ socketPath: ctx.sock, path: `/jobs/${id}/events?after=1&follow=1` });
  await sleep(50);
  await runnerPost(ctx.sock, id, token, event(id, 1, { type: "think", text: "mid-poll event" }));
  const res = await follow;
  const followed = parseNdjson(res.body) as { type: string; text?: string }[];
  assert.equal(followed.length, 1);
  assert.equal(followed[0].text, "mid-poll event");
});

test("cancel terminates via provider, appends cancelled, refuses further events", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));

  const res = await op(ctx.sock, "POST", `/jobs/${id}/cancel`);
  assert.equal(res.status, 200);
  assert.equal(jobOf(res.json).state, "cancelled");
  assert.deepEqual(ctx.provider.terminated, [`stub:${id}`]);

  const events = parseNdjson((await op(ctx.sock, "GET", `/jobs/${id}/events`)).body) as Record<string, unknown>[];
  const last = events[events.length - 1];
  assert.equal(last.type, "state");
  assert.equal(last.state, "cancelled");
  assert.equal(last.reason, "operator-cancel");

  const late = await runnerPost(ctx.sock, id, token, event(id, 1, { type: "think", text: "too late" }));
  assert.equal(late.status, 422);

  const again = await op(ctx.sock, "POST", `/jobs/${id}/cancel`);
  assert.equal(again.status, 409);
});

test("settle then done records settle and a verified doneCheck; gh rungs stay unverified", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  const local = await createJob(ctx); // finish: implemented
  await runnerPost(ctx.sock, local.id, local.token, event(local.id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, local.id, local.token, event(local.id, 1, SETTLE));
  await runnerPost(ctx.sock, local.id, local.token, event(local.id, 2, { type: "state", state: "done" }));
  const doneJob = jobOf((await op(ctx.sock, "GET", `/jobs/${local.id}`)).json);
  assert.equal(doneJob.state, "done");
  assert.equal(doneJob.settle?.rung, "implemented");
  assert.equal(doneJob.doneCheck?.verified, true);
  assert.equal(doneJob.doneCheck?.target, "implemented");

  // A pr-open job settle without a PR URL in report — daemon tried gh but
  // had no URL to call, so it stays unverified.
  const gh = await createJob(ctx, { ...WORK_ORDER, finish: "pr-open" });
  await runnerPost(ctx.sock, gh.id, gh.token, event(gh.id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, gh.id, gh.token, event(gh.id, 1, { ...SETTLE, rung: "pr-open" }));
  await runnerPost(ctx.sock, gh.id, gh.token, event(gh.id, 2, { type: "state", state: "done" }));
  const ghJob = jobOf((await op(ctx.sock, "GET", `/jobs/${gh.id}`)).json);
  assert.equal(ghJob.doneCheck?.verified, false);
  // The settle has no report.pr, so verifyWithGh returns "no PR URL" before
  // ever calling gh. A plausible regression: if the URL guard were removed,
  // gh would be called with undefined and produce a different error.
  assert.ok(
    ghJob.doneCheck?.notes[0]?.includes("no PR URL"),
    `expected "no PR URL" note, got: ${JSON.stringify(ghJob.doneCheck?.notes)}`,
  );
});

test("registry survives a daemon restart over the same FLEET_HOME", async (t) => {
  const home = tempHome();
  const first = await startDaemon(home);

  const blocked = await createJob(first);
  await runnerPost(first.sock, blocked.id, blocked.token, event(blocked.id, 0, { type: "state", state: "running" }));
  await runnerPost(first.sock, blocked.id, blocked.token, event(blocked.id, 1, DECISION));
  // Add a think event after the decision so lastActivity is stamped before the restart.
  await runnerPost(first.sock, blocked.id, blocked.token, event(blocked.id, 2, { type: "think", text: "before restart" }));

  const finished = await createJob(first);
  await runnerPost(first.sock, finished.id, finished.token, event(finished.id, 0, { type: "state", state: "running" }));
  await runnerPost(first.sock, finished.id, finished.token, event(finished.id, 1, SETTLE));
  await runnerPost(first.sock, finished.id, finished.token, event(finished.id, 2, { type: "state", state: "done" }));

  await first.daemon.stop();

  // Fresh server instance, same home: everything must be reloaded from disk.
  const second = await startDaemon(home);
  t.after(() => second.daemon.stop());

  const reloaded = jobOf((await op(second.sock, "GET", `/jobs/${blocked.id}`)).json);
  assert.equal(reloaded.state, "blocked");
  const events = parseNdjson((await op(second.sock, "GET", `/jobs/${blocked.id}/events`)).body) as unknown[];
  assert.equal(events.length, 4); // queued + running + decision + think

  // lastActivity persists across a daemon restart — stored in job.json, not recomputed from the log.
  const laAfterRestart = reloaded.lastActivity as { text: string; at: string } | undefined;
  assert.ok(laAfterRestart, "lastActivity must survive a daemon restart (persisted in job.json)");
  assert.equal(laAfterRestart!.text, "before restart", "lastActivity.text matches the pre-restart think event");

  const doneJob = jobOf((await op(second.sock, "GET", `/jobs/${finished.id}`)).json);
  assert.equal(doneJob.state, "done");
  assert.equal(doneJob.doneCheck?.verified, true);

  // The open decision survived: option validation and resume still work.
  const bad = await op(second.sock, "POST", `/jobs/${blocked.id}/answer`, { option: "nope" });
  assert.equal(bad.status, 422);
  const answered = await op(second.sock, "POST", `/jobs/${blocked.id}/answer`, { option: "direct" });
  assert.equal(answered.status, 200, answered.body);
  assert.equal(jobOf(answered.json).state, "running");

  // Runner seq continuity survives the restart too.
  const next = await runnerPost(second.sock, blocked.id, blocked.token, event(blocked.id, 3, { type: "think", text: "resuming" }));
  assert.equal(next.status, 200, next.body);
  const stale = await runnerPost(second.sock, blocked.id, blocked.token, event(blocked.id, 1, { type: "think", text: "replay" }));
  assert.equal(stale.status, 422);
});

test("running -> blocked with parked marker is accepted; blocked -> blocked re-assert is refused", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));

  // block_hot expiry: WIP committed, task exited — blocked with the parked marker.
  const parked = await runnerPost(ctx.sock, id, token, event(id, 1, { type: "state", state: "blocked", marker: "parked" }));
  assert.equal(parked.status, 200, parked.body);
  const job = jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "blocked");
  assert.equal(job.marker, "parked");

  // blocked -> blocked is not a legal transition; markers never relax that.
  const reassert = await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "stale" }));
  assert.equal(reassert.status, 422);
  assert.match(reassert.body, /illegal transition/);
});

test("wall-clock backstop terminates and cancels wedged job via daemon sweep", async (t) => {
  const home = tempHome();
  const provider = new StubProvider();
  const daemon = new FleetDaemon({
    home,
    provider,
    longPollMs: LONG_POLL_MS,
    // Fire the backstop 300ms after the 1s limit (1300ms total active).
    wallClockBackstopMarginMs: 300,
    // Sweep every 50ms so the test finishes quickly.
    wallClockSweepIntervalMs: 50,
  });
  const { socketPath } = await daemon.start();
  t.after(() => daemon.stop());
  const ctx: Ctx = { daemon, sock: socketPath, provider, home };

  // Manifest with a 1s wall_clock limit; schema now accepts 's' unit.
  const manifest = { ...MANIFEST, limits: { wall_clock: "1s" } };
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest });
  assert.equal(res.status, 201, res.body);
  const job = (res.json as { job: { id: string; handle?: string } }).job;
  const launch = provider.launches.find((l) => l.jobId === job.id);
  assert.ok(launch, "provider.launch must be called");
  const { runnerToken: token } = launch;

  // Runner signals running — this starts the active-time clock in the daemon.
  await runnerPost(ctx.sock, job.id, token, event(job.id, 0, { type: "state", state: "running" }));

  // The runner is now wedged (posts no more events). Poll for the backstop:
  // limit (1s) + margin (300ms) + sweep cycles, with headroom under load.
  await until(async () => {
    const j = jobOf((await op(ctx.sock, "GET", `/jobs/${job.id}`)).json);
    return j.state === "cancelled";
  }, 10_000);

  const cancelled = (await op(ctx.sock, "GET", `/jobs/${job.id}`)).json as { job: Record<string, unknown> };
  assert.equal(cancelled.job.state, "cancelled");

  // Provider.terminate must have been called with the job's handle.
  assert.ok(
    provider.terminated.includes(job.handle ?? `stub:${job.id}`),
    `expected handle in terminated list; got ${JSON.stringify(provider.terminated)}`,
  );

  // The daemon must have synthesised a settle event and a cancelled event.
  const eventsRes = await op(ctx.sock, "GET", `/jobs/${job.id}/events`);
  const events = parseNdjson(eventsRes.body) as Record<string, unknown>[];
  const settleEvent = events.find((e) => e.type === "settle");
  assert.ok(settleEvent, "settle event must be synthesised");
  const report = settleEvent.report as Record<string, unknown> | undefined;
  assert.ok(report, "synthesised settle must include report");
  assert.equal(report.status, "PARTIAL");

  const cancelledEvent = events.find(
    (e) => e.type === "state" && (e as Record<string, unknown>).state === "cancelled",
  );
  assert.ok(cancelledEvent, "cancelled state event must be present");
  assert.equal((cancelledEvent as Record<string, unknown>).reason, "wall-clock");
});

test("stall backstop cancels a running job whose events dried up (reason stall)", async (t) => {
  const home = tempHome();
  const provider = new StubProvider();
  const daemon = new FleetDaemon({
    home,
    provider,
    longPollMs: LONG_POLL_MS,
    // Fire 300ms past the 1s idle threshold; sweep fast so the test is quick.
    idleBackstopMarginMs: 300,
    wallClockSweepIntervalMs: 50,
  });
  const { socketPath } = await daemon.start();
  t.after(() => daemon.stop());
  const ctx: Ctx = { daemon, sock: socketPath, provider, home };

  // idle only: no wall_clock, so nothing but the stall sweep can end this job.
  const manifest = { ...MANIFEST, limits: { idle: "1s" } };
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest });
  assert.equal(res.status, 201, res.body);
  const job = (res.json as { job: { id: string; handle?: string } }).job;
  const launch = provider.launches.find((l) => l.jobId === job.id);
  assert.ok(launch, "provider.launch must be called");

  await runnerPost(ctx.sock, job.id, launch.runnerToken, event(job.id, 0, { type: "state", state: "running" }));

  // The runner is dead: no further events. Poll for the backstop (limit 1s +
  // margin 300ms + sweep cycles) with headroom under load.
  await until(async () => {
    const j = jobOf((await op(ctx.sock, "GET", `/jobs/${job.id}`)).json);
    return j.state === "cancelled";
  }, 10_000);
  const cancelled = jobOf((await op(ctx.sock, "GET", `/jobs/${job.id}`)).json);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.reason, "stall", "the record carries the reason so status/board can show cancelled(stall)");

  const events = parseNdjson((await op(ctx.sock, "GET", `/jobs/${job.id}/events`)).body) as Record<string, unknown>[];
  const settleEvent = events.find((e) => e.type === "settle");
  assert.ok(settleEvent, "settle event must be synthesised");
  const report = settleEvent.report as Record<string, unknown>;
  assert.equal(report.status, "PARTIAL");
  assert.match(String(report.next_action), /no events for \d+(\.\d+)?m \(idle limit \d+(\.\d+)?m, daemon backstop\)/);
  const cancelEvent = events.find((e) => e.type === "state" && e.state === "cancelled");
  assert.ok(cancelEvent);
  assert.equal(cancelEvent.reason, "stall");
});

test("stall backstop leaves a blocked job alone however long it waits", async (t) => {
  const home = tempHome();
  const provider = new StubProvider();
  const daemon = new FleetDaemon({
    home,
    provider,
    longPollMs: LONG_POLL_MS,
    idleBackstopMarginMs: 300,
    wallClockSweepIntervalMs: 50,
  });
  const { socketPath } = await daemon.start();
  t.after(() => daemon.stop());
  const ctx: Ctx = { daemon, sock: socketPath, provider, home };

  const manifest = { ...MANIFEST, limits: { idle: "1s" } };
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest });
  assert.equal(res.status, 201, res.body);
  const job = (res.json as { job: { id: string } }).job;
  const launch = provider.launches.find((l) => l.jobId === job.id);
  assert.ok(launch);

  await runnerPost(ctx.sock, job.id, launch.runnerToken, event(job.id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, job.id, launch.runnerToken, event(job.id, 1, DECISION));

  // Silent well past idle + margin: waiting on a human is not a stall.
  await sleep(1_600);

  const still = jobOf((await op(ctx.sock, "GET", `/jobs/${job.id}`)).json);
  assert.equal(still.state, "blocked", "a blocked job must never be cancelled by the stall sweep");
  assert.deepEqual(provider.terminated, [], "nothing may be terminated");
  const events = parseNdjson((await op(ctx.sock, "GET", `/jobs/${job.id}/events`)).body) as Record<string, unknown>[];
  assert.ok(
    !events.some((e) => e.type === "state" && e.state === "cancelled"),
    "no cancellation event may be synthesised",
  );

  // Still answerable afterwards: the wait was untouched, not merely un-cancelled.
  const answered = await op(ctx.sock, "POST", `/jobs/${job.id}/answer`, { option: "flag" });
  assert.equal(answered.status, 200, answered.body);
});

test("notify webhook fires on decision when configured", async (t) => {
  const home = tempHome();
  const posts: unknown[] = [];
  const hook = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      posts.push(JSON.parse(body));
      res.writeHead(200);
      res.end();
    });
  });
  const listening = Promise.withResolvers<void>();
  hook.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = hook.address();
  const hookPort = typeof address === "object" && address !== null ? address.port : 0;
  t.after(() => hook.close());

  const provider = new StubProvider();
  const daemon = new FleetDaemon({
    home,
    provider,
    longPollMs: LONG_POLL_MS,
    notifyWebhooks: [`http://127.0.0.1:${hookPort}/hook`],
  });
  const { socketPath } = await daemon.start();
  t.after(() => daemon.stop());
  const ctx: Ctx = { daemon, sock: socketPath, provider, home };

  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, DECISION));
  await until(() => posts.length === 1);
  const payload = posts[0] as { text: string };
  assert.match(payload.text, /blocked on a decision/);
  assert.match(payload.text, new RegExp(id));
});

// --- Dispatch-time resource check tests --------------------------------------

/** Provider stub with a configurable checkResources that throws when set. */
class CheckingProvider extends StubProvider {
  #refusal: string | null = null;

  refuseWith(message: string): void {
    this.#refusal = message;
  }

  override checkResources(_resources: ResourceRequest): void {
    if (this.#refusal !== null) throw new Error(this.#refusal);
  }
}

/** Manifest with limits.resources set to the given values. */
function manifestWithResources(resources: ResourceRequest): typeof MANIFEST & { limits: { resources: ResourceRequest } } {
  return { ...MANIFEST, limits: { resources } };
}

test("POST /jobs rejects oversized resource request at dispatch with 422 before creating a job", async (t) => {
  const provider = new CheckingProvider();
  provider.refuseWith("resource request exceeds offered capacity: requested cpu=4096, memory=3584 but max offered is cpu=2048, memory=3584");
  const daemon = new FleetDaemon({ home: tempHome(), provider });
  const { socketPath: sock } = await daemon.start();
  t.after(() => daemon.stop());

  const res = await op(sock, "POST", "/jobs", {
    workOrder: WORK_ORDER,
    manifest: manifestWithResources({ cpu: 4096, memory: 3584 }),
  });

  assert.equal(res.status, 422);
  const { errors } = res.json as { errors: { instancePath: string; message: string }[] };
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.instancePath === "/limits/resources"), `expected /limits/resources error; got: ${JSON.stringify(errors)}`);
  assert.ok(errors.some((e) => e.message.includes("cpu=4096")), `expected requested cpu in message; got: ${JSON.stringify(errors)}`);

  // No job must have been created or launched.
  const list = await op(sock, "GET", "/jobs");
  assert.deepEqual((list.json as { jobs: unknown[] }).jobs, []);
  assert.equal(provider.launches.length, 0);
});

test("POST /jobs launches normally when resources fit within offered capacity", async (t) => {
  const provider = new CheckingProvider();
  // refuseWith not called → checkResources does not throw.
  const daemon = new FleetDaemon({ home: tempHome(), provider });
  const { socketPath: sock } = await daemon.start();
  t.after(() => daemon.stop());

  const res = await op(sock, "POST", "/jobs", {
    workOrder: WORK_ORDER,
    manifest: manifestWithResources({ cpu: 1024, memory: 2048 }),
  });

  assert.equal(res.status, 201, res.body);
  assert.equal(provider.launches.length, 1);
  // resources must be carried through to the LaunchSpec.
  assert.deepEqual(provider.launches[0].resources, { cpu: 1024, memory: 2048 });
});

test("POST /jobs passes resources from manifest to the LaunchSpec", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  const manifest = manifestWithResources({ cpu: 512, memory: 1024, disk: 20 });
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest });
  assert.equal(res.status, 201, res.body);

  const launch = ctx.provider.launches[0];
  assert.ok(launch, "provider.launch must have been called");
  assert.deepEqual(launch.resources, { cpu: 512, memory: 1024, disk: 20 });
});

test("POST /jobs with no limits.resources passes undefined resources to the LaunchSpec", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(res.status, 201, res.body);

  const launch = ctx.provider.launches[0];
  assert.ok(launch, "provider.launch must have been called");
  assert.equal(launch.resources, undefined);
});

// --- Parked-job re-entry (issue #6) ---

// (No manifest helper needed for decision_timeout tests — registry is seeded directly
// because the manifest schema requires m|h units, which are too long for unit tests.)

test("answer to parked job triggers re-launch with reentryAnswer; new token issued", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  const { id, token } = await createJob(ctx);
  // Runner emits: running → decision → parked
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, DECISION));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));

  const parkedJob = jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(parkedJob.state, "blocked");
  assert.equal(parkedJob.marker, "parked");
  assert.equal(ctx.provider.launches.length, 1);

  // Operator answers. The daemon must re-launch (not just update state).
  const answered = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(answered.status, 200, answered.body);

  // A second launch must have been triggered.
  assert.equal(ctx.provider.launches.length, 2, "re-launch was expected");
  const relaunch = ctx.provider.launches[1];
  assert.equal(relaunch.jobId, id);
  // The reentryAnswer carries the decision and the chosen option.
  assert.ok(relaunch.reentryAnswer, "reentryAnswer must be set on re-launch");
  assert.equal(relaunch.reentryAnswer?.decisionId, "d1");
  assert.equal(relaunch.reentryAnswer?.answer.option, "flag");

  // The new runner token must differ from the first.
  assert.notEqual(relaunch.runnerToken, token);

  // Job state stays blocked until the new runner emits state:running.
  const relaunchedJob = jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(relaunchedJob.state, "blocked", "state must stay blocked until new runner emits running");
  assert.equal(relaunchedJob.marker, undefined, "parked marker must be cleared");

  // New runner (using the new token) can post state:running → job becomes running.
  const newToken = relaunch.runnerToken;
  const runningRes = await runnerPost(ctx.sock, id, newToken, event(id, 0, { type: "state", state: "running" }));
  assert.equal(runningRes.status, 200, runningRes.body);
  const runningJob = jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(runningJob.state, "running");
});

test("answer to stale job also triggers re-launch", async (t) => {
  // Drive stale through the real sweep path (not a direct registry mutation) so
  // the state event emitted by #markStale is present in the event log.
  const home = tempHome();
  const provider = new StubProvider();
  const daemon = new FleetDaemon({
    home,
    provider,
    longPollMs: LONG_POLL_MS,
    wallClockSweepIntervalMs: 100,
  });
  const { socketPath: sock } = await daemon.start();
  t.after(() => daemon.stop());

  const res = await op(sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(res.status, 201, res.body);
  const id = jobOf(res.json).id;
  const token = provider.launches[0].runnerToken;

  await runnerPost(sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(sock, id, token, event(id, 1, DECISION));
  await runnerPost(sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));

  // Seed an already-elapsed decision_timeout so the next sweep fires immediately.
  daemon.registry.initDecisionTimeout(id, 100);
  daemon.registry.setDecisionBlockedAt(id, Date.now() - 500);

  // Wait for the sweep to mark it stale via #markStale (appends the state event).
  await until(async () => {
    const j = jobOf((await op(sock, "GET", `/jobs/${id}`)).json);
    return j.state === "blocked" && j.marker === "stale";
  }, 2_000);

  // The stale state event must appear in the event log (proving #markStale ran).
  const eventsRes = await op(sock, "GET", `/jobs/${id}/events`);
  const events = parseNdjson(eventsRes.body) as Array<{ type: string; state?: string; marker?: string }>;
  const staleEvent = events.find((e) => e.type === "state" && e.state === "blocked" && e.marker === "stale");
  assert.ok(staleEvent, "stale state event must be in the log");

  // Answering a stale job must re-launch with a fresh runner and reentryAnswer.
  const answered = await op(sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(answered.status, 200, answered.body);
  assert.equal(provider.launches.length, 2, "stale job must trigger re-launch");
  assert.equal(provider.launches[1].reentryAnswer?.decisionId, "d1");
  assert.equal(provider.launches[1].reentryAnswer?.answer.option, "flag");

  // Job state stays blocked until the new runner emits state:running.
  const relaunchedJob = jobOf((await op(sock, "GET", `/jobs/${id}`)).json);
  assert.equal(relaunchedJob.state, "blocked");
  assert.equal(relaunchedJob.marker, undefined, "stale marker must be cleared after answer");
});

test("decision_timeout sweep marks parked job stale; job remains answerable", async (t) => {
  const home = tempHome();
  const provider = new StubProvider();
  const daemon = new FleetDaemon({
    home,
    provider,
    longPollMs: LONG_POLL_MS,
    // Fast sweep (200ms) so the stale marking fires quickly in the test.
    wallClockSweepIntervalMs: 200,
  });
  const { socketPath: sock } = await daemon.start();
  t.after(() => daemon.stop());

  // Create a job and let it progress to blocked+parked.
  const res = await op(sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(res.status, 201, res.body);
  const id = jobOf(res.json).id;
  const token = provider.launches[0].runnerToken;

  await runnerPost(sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(sock, id, token, event(id, 1, DECISION));
  // Parked: block_hot expired, runner exited.
  await runnerPost(sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));

  // Seed a very short decision_timeout (500ms) and a past decisionBlockedAt
  // so the sweep fires immediately on its next tick.
  daemon.registry.initDecisionTimeout(id, 500);
  daemon.registry.setDecisionBlockedAt(id, Date.now() - 1000); // already elapsed

  // The next sweep (≤ 200ms) must mark it stale.
  await until(async () => {
    const j = jobOf((await op(sock, "GET", `/jobs/${id}`)).json);
    return j.state === "blocked" && j.marker === "stale";
  }, 2_000);

  const staleJob = jobOf((await op(sock, "GET", `/jobs/${id}`)).json);
  assert.equal(staleJob.state, "blocked");
  assert.equal(staleJob.marker, "stale");

  // Stale job is still answerable — it re-launches.
  const answered = await op(sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(answered.status, 200, answered.body);
  assert.equal(provider.launches.length, 2, "stale job must re-launch on answer");
});

test("re-launch failure after answer cancels the job — not stuck in blocked", async (t) => {
  // If provider.launch throws during re-entry, the old runner is dead and no new
  // one is starting. The daemon must cancel the job so it reaches a terminal state
  // instead of hanging in blocked with no live runner and no open decision.
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, DECISION));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));

  // Simulate a provider failure on the next launch.
  ctx.provider.failNextLaunch = true;
  const answered = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(answered.status, 500, answered.body);

  // The job must be cancelled — not stuck in blocked.
  const afterFail = jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(afterFail.state, "cancelled", "job must be cancelled when re-launch fails");
  assert.equal(afterFail.marker, undefined, "marker must be cleared");

  // No open decision remains (job is terminal, second answer attempt returns 409).
  const second = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(second.status, 409);
});

test("lastActivity: present after think/log event; absent for queued-never-ran job; no log scan at list time", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  // Create two jobs: one that gets a think event, one that never runs.
  const { id: runId, token } = await createJob(ctx);
  const { id: queuedId } = await createJob(ctx);

  // Verify the queued job has no lastActivity.
  const queuedRes = await op(ctx.sock, "GET", `/jobs/${queuedId}`);
  const queuedJob = jobOf(queuedRes.json) as Record<string, unknown>;
  assert.equal(queuedJob.lastActivity, undefined, "queued-never-ran job must have no lastActivity");

  // Transition the run job to running, then emit a think event.
  await runnerPost(ctx.sock, runId, token, event(runId, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, runId, token, event(runId, 1, { type: "think", text: "analysing the codebase" }));

  const runRes = await op(ctx.sock, "GET", `/jobs/${runId}`);
  const runJob = jobOf(runRes.json) as Record<string, unknown>;
  const lastActivity = runJob.lastActivity as { text: string; at: string } | undefined;
  assert.ok(lastActivity, "running job with think event must have lastActivity");
  assert.equal(lastActivity.text, "analysing the codebase", "lastActivity.text matches think event");
  assert.ok(typeof lastActivity.at === "string" && lastActivity.at.length > 0, "lastActivity.at is a timestamp string");

  // Verify lastActivity appears on the jobs listing (no log-file scan needed).
  const listRes = await op(ctx.sock, "GET", "/jobs");
  const jobs = (listRes.json as { jobs: Array<Record<string, unknown>> }).jobs;
  const runInList = jobs.find((j) => j.id === runId);
  assert.ok(runInList, "running job in listing");
  assert.ok(runInList!.lastActivity, "lastActivity present in jobs listing without log scan");

  // A subsequent log event updates lastActivity.
  await runnerPost(ctx.sock, runId, token, event(runId, 2, { type: "log", text: "ran npm test" }));
  const updated = jobOf((await op(ctx.sock, "GET", `/jobs/${runId}`)).json) as Record<string, unknown>;
  const updatedActivity = updated.lastActivity as { text: string } | undefined;
  assert.equal(updatedActivity?.text, "ran npm test", "lastActivity updates to latest log event");
});

// --- Issue #110: decision id recycling after park/resume ---

test("re-entry: new runner's decision does not receive the previous question's answer (#110)", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  // Generation 1: running → decision(d1) → parked.
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, DECISION));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));

  // Operator answers d1 → daemon re-launches with reentryAnswer + decision count seed.
  const answered = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(answered.status, 200, answered.body);
  assert.equal(ctx.provider.launches.length, 2, "re-launch expected");
  const relaunch = ctx.provider.launches[1]!;
  assert.equal(relaunch.reentryAnswer?.decisionId, "d1");
  assert.equal(relaunch.reentryDecisionSeed, 1, "re-launch must seed the counter past prior ids");

  // Generation 2: the fresh runner's counter is seeded at 1, so its first
  // decision is d2 — not a recycled d1.
  const newToken = relaunch.runnerToken;
  await runnerPost(ctx.sock, id, newToken, event(id, 0, { type: "state", state: "running" }));
  const DECISION_2 = {
    type: "decision",
    id: "d2",
    question: "How should we roll this out?",
    options: [
      { id: "gradual", label: "Gradual rollout", recommended: true },
      { id: "big-bang", label: "Big bang" },
    ],
  };
  const blocked2 = await runnerPost(ctx.sock, id, newToken, event(id, 1, DECISION_2));
  assert.equal(blocked2.status, 200, blocked2.body);
  assert.equal(jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json).state, "blocked");

  // The runner long-polls for d2's answer. It must NOT receive d1's answer —
  // findAnswer only matches an answer recorded after the d2 decision event,
  // and no such answer exists yet. The poll should time out (204).
  const poll = request({
    socketPath: ctx.sock,
    path: `/internal/jobs/${id}/answer?decision=d2`,
    headers: { "x-fleet-runner-token": newToken },
  });
  const pollRes = await poll;
  assert.equal(pollRes.status, 204, "d2 poll must time out — d1's answer must not leak");

  // Now the operator answers d2 → the poll on a second request returns it.
  const answered2 = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "big-bang" });
  assert.equal(answered2.status, 200, answered2.body);

  // Verify the answer event in the log is for d2, and d1's answer is distinct.
  const events = parseNdjson((await op(ctx.sock, "GET", `/jobs/${id}/events`)).body) as Array<Record<string, unknown>>;
  const answerEvents = events.filter((e) => e.type === "answer");
  assert.equal(answerEvents.length, 2, "two answers in the log");
  assert.equal(answerEvents[0]!.decision, "d1");
  assert.equal(answerEvents[0]!.option, "flag");
  assert.equal(answerEvents[1]!.decision, "d2");
  assert.equal(answerEvents[1]!.option, "big-bang");

  // Decision ids are unique across the whole log.
  const decisionIds = events.filter((e) => e.type === "decision").map((e) => e.id);
  assert.deepEqual(decisionIds, ["d1", "d2"], "decision ids must be unique across generations");
});

test("re-entry: happy path — the legitimate answer to the parked question still delivers (#110)", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  // Park on d1, answer it, re-enter.
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, DECISION));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));

  const answered = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(answered.status, 200);

  // The reentryAnswer carries the correct decision id and answer — the new
  // runner writes answer-d1.json and the harness picks it up immediately.
  const relaunch = ctx.provider.launches[1]!;
  assert.equal(relaunch.reentryAnswer?.decisionId, "d1");
  assert.equal(relaunch.reentryAnswer?.answer.option, "flag");

  // The answer event for d1 is in the log.
  const events = parseNdjson((await op(ctx.sock, "GET", `/jobs/${id}/events`)).body) as Array<Record<string, unknown>>;
  const d1Answer = events.find((e) => e.type === "answer" && e.decision === "d1");
  assert.ok(d1Answer, "d1 answer event must be in the log");
  assert.equal(d1Answer!.option, "flag");
});

test("re-entry: a recycled decision id is rejected, so no answer can be inherited (#110)", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, DECISION));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));
  assert.equal((await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" })).status, 200);

  // A runner that ignores the seed — an older build, or a harness numbering its
  // own ids — raises a NEW question and calls it d1 again. The counter fix keeps
  // the shipped runner off this path; the daemon has to refuse it anyway, or the
  // answer a human gave to the first question is inherited by the second.
  const newToken = ctx.provider.launches[1]!.runnerToken;
  await runnerPost(ctx.sock, id, newToken, event(id, 0, { type: "state", state: "running" }));
  const recycled = await runnerPost(ctx.sock, id, newToken, event(id, 1, {
    ...DECISION,
    question: "A completely different question",
  }));
  assert.equal(recycled.status, 422, recycled.body);
  assert.match(recycled.body, /already used by this job/);

  // The job stayed running: no second decision was opened, so there is nothing
  // holding a stale answer.
  assert.equal(jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json).state, "running");
  const decisions = (parseNdjson((await op(ctx.sock, "GET", `/jobs/${id}/events`)).body) as Array<Record<string, unknown>>)
    .filter((e) => e.type === "decision");
  assert.equal(decisions.length, 1, "the recycled decision must not reach the log");
});

test("findAnswer ignores an answer recorded before its decision (#110)", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, DECISION));
  assert.equal((await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" })).status, 200);
  assert.ok(ctx.daemon.registry.findAnswer(id, "d1"), "the real answer resolves");

  // Belt and braces behind the id-uniqueness rule: even handed a log where a
  // decision id repeats — a journal written by an older daemon that allowed it —
  // only an answer recorded AFTER the current decision may satisfy the poll.
  // A first-match scan returns the previous generation's answer instantly.
  ctx.daemon.registry.appendEvent(id, {
    type: "decision",
    id: "d1",
    question: "A second question wearing the first one's id",
    options: [{ id: "flag", label: "Flag", recommended: true }, { id: "skip", label: "Skip" }],
  });
  assert.equal(
    ctx.daemon.registry.findAnswer(id, "d1"),
    undefined,
    "the earlier answer must not resolve the later decision",
  );
});

test("the re-entry seed is the highest decision ordinal, not the decision count (#110)", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  // A journal that skips an ordinal: the runner raised d1 and d2, but only d2
  // reached the log (a 422 on the first attempt, a dropped batch, an older
  // build). There is one decision event carrying ordinal 2.
  await runnerPost(ctx.sock, id, token, event(id, 1, { ...DECISION, id: "d2" }));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));
  assert.equal((await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "flag" })).status, 200);

  // Counting decision events gives 1, which seeds the fresh runner to emit d2 —
  // the id already in the log, carrying an answer. The ordinal gives 2.
  assert.equal(ctx.provider.launches[1]!.reentryDecisionSeed, 2);
});
