import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { FleetDaemon } from "../src/daemon/server.ts";
import { parseNdjson } from "../src/shared/ndjson.ts";
import { request } from "../src/shared/http.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost, until } from "./daemon-helpers.ts";

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

  // Replayed seq rejected
  const replay = await runnerPost(ctx.sock, id, token, event(id, 0, { type: "think", text: "again" }));
  assert.equal(replay.status, 422);
  assert.match(replay.body, /monotonically increasing/);

  // Lower seq rejected even after a gap
  const gap = await runnerPost(ctx.sock, id, token, event(id, 7, { type: "think", text: "gap ok" }));
  assert.equal(gap.status, 200);
  const lower = await runnerPost(ctx.sock, id, token, event(id, 4, { type: "think", text: "backwards" }));
  assert.equal(lower.status, 422);

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
  assert.equal(events.length, 3); // queued + running + decision

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
  const next = await runnerPost(second.sock, blocked.id, blocked.token, event(blocked.id, 2, { type: "think", text: "resuming" }));
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
