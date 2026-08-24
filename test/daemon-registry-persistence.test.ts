// Tests for issues #112 + #113: tolerant boot, single-writer lock,
// append-before-seq, cancel recheck, log-authoritative reconciliation,
// and persist coalescing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { FleetDaemon } from "../src/daemon/server.ts";
import { parseNdjson } from "../src/shared/ndjson.ts";
import { stableStringify } from "../src/shared/json.ts";
import { hostname } from "node:os";
import { jobDir, daemonLockPath } from "../src/shared/home.ts";
import { STALE_AFTER_MS } from "../src/daemon/lock.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost, until } from "./daemon-helpers.ts";
import type { LaunchSpec, Provider } from "../src/providers/provider.ts";

const LONG_POLL_MS = 300;

type Ctx = { daemon: FleetDaemon; sock: string; provider: StubProvider; home: string };

async function startDaemon(home = tempHome(), provider?: Provider): Promise<Ctx> {
  const p = provider ?? new StubProvider();
  const daemon = new FleetDaemon({ home, provider: p, longPollMs: LONG_POLL_MS });
  const { socketPath } = await daemon.start();
  return { daemon, sock: socketPath, provider: p as StubProvider, home };
}

type Job = { id: string; state: string; marker?: string } & Record<string, unknown>;

function jobOf(json: unknown): Job {
  const body = json as { job: Job };
  assert.ok(body.job, `expected {job} body, got ${JSON.stringify(json)}`);
  return body.job;
}

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

const SETTLE = {
  type: "settle",
  rung: "implemented",
  minutes: 1,
  outcome: { produced: [], findings: 0, decisions: 0 },
};

// --- #112: Tolerant boot ----------------------------------------------------

test("truncated final NDJSON line is dropped, job loads and serves", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, { type: "think", text: "first" }));
  await ctx.daemon.stop();

  // Tear the final line: append a partial JSON line to events.jsonl.
  const eventsPath = join(jobDir(home, id), "events.jsonl");
  appendFileSync(eventsPath, '{"job":"');
  assert.ok(existsSync(eventsPath), "events file exists");

  // Boot must tolerate the torn line — no throw.
  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  const job = jobOf((await op(ctx2.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "running");
  // The torn line was dropped; the two good events are intact.
  const events = parseNdjson(
    readFileSync(join(jobDir(home, id), "events.jsonl"), "utf8"),
  ) as unknown[];
  assert.equal(events.length, 3); // queued + running + think
});

test("empty job.json quarantines the job; other jobs load normally", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id: goodId, token: goodToken } = await createJob(ctx);
  await runnerPost(ctx.sock, goodId, goodToken, event(goodId, 0, { type: "state", state: "running" }));

  const { id: badId } = await createJob(ctx);
  await ctx.daemon.stop();

  // Corrupt the second job's job.json: truncate to empty.
  const badPath = join(jobDir(home, badId), "job.json");
  writeFileSync(badPath, "");

  // Boot must quarantine the bad job and still serve the good one.
  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  const good = jobOf((await op(ctx2.sock, "GET", `/jobs/${goodId}`)).json);
  assert.equal(good.state, "running");

  const bad = await op(ctx2.sock, "GET", `/jobs/${badId}`);
  assert.equal(bad.status, 404);

  // The corrupt job dir was renamed to <id>.corrupt.
  assert.ok(
    existsSync(join(home, "jobs", `${badId}.corrupt`)),
    "corrupt job dir was quarantined",
  );
});

test("garbage job.json quarantines the job", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await ctx.daemon.stop();

  // Write garbage to job.json.
  const recordPath = join(jobDir(home, id), "job.json");
  writeFileSync(recordPath, "{not valid json");

  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  const res = await op(ctx2.sock, "GET", `/jobs/${id}`);
  assert.equal(res.status, 404);
  assert.ok(existsSync(join(home, "jobs", `${id}.corrupt`)));
});

test("a mid-file-corrupt events.jsonl quarantines that job; other jobs load", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id: goodId, token: goodToken } = await createJob(ctx);
  await runnerPost(ctx.sock, goodId, goodToken, event(goodId, 0, { type: "state", state: "running" }));
  const { id: badId, token: badToken } = await createJob(ctx);
  await runnerPost(ctx.sock, badId, badToken, event(badId, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, badId, badToken, event(badId, 1, { type: "think", text: "second" }));
  await ctx.daemon.stop();

  // Corruption in the middle of the log, not a torn tail: the journal is the
  // source of truth (D15), so a job whose journal cannot be read whole must not
  // be served — but it must not take the other jobs down with it either.
  const badPath = join(jobDir(home, badId), "events.jsonl");
  const lines = readFileSync(badPath, "utf8").split("\n");
  lines[1] = "{ this is not json";
  writeFileSync(badPath, lines.join("\n"));

  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  assert.equal(jobOf((await op(ctx2.sock, "GET", `/jobs/${goodId}`)).json).state, "running");
  assert.equal((await op(ctx2.sock, "GET", `/jobs/${badId}`)).status, 404);
  assert.ok(existsSync(join(home, "jobs", `${badId}.corrupt`)));
});

test("a quarantined job dir is not re-quarantined on the next boot", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id } = await createJob(ctx);
  await ctx.daemon.stop();
  writeFileSync(join(jobDir(home, id), "job.json"), "");

  const ctx2 = await startDaemon(home);
  await ctx2.daemon.stop();
  assert.ok(existsSync(join(home, "jobs", `${id}.corrupt`)));

  // A quarantine dir still holds the corrupt job.json that caused it. Loading
  // it again renames it again — `<id>.corrupt.corrupt`, then `.corrupt` once
  // more every boot forever, and each pass churns the EFS the daemon boots from.
  const ctx3 = await startDaemon(home);
  t.after(() => ctx3.daemon.stop());
  assert.deepEqual(
    readdirSync(join(home, "jobs")).sort(),
    [`${id}.corrupt`],
    "the quarantine must be left exactly as it was",
  );
});

// --- #112: Single-writer lock -----------------------------------------------

test("a second daemon refuses the home before it writes anything into it", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  const { id } = await createJob(ctx);

  // Tear the live daemon's job.json. A second daemon that got as far as loading
  // would quarantine this dir — inside a home it does not own.
  writeFileSync(join(jobDir(home, id), "job.json"), "");

  // The refusal must land at construction: loading the registry quarantines
  // torn dirs and reconciliation rewrites job.json, so a lock taken later
  // (in start()) would refuse only after the damage was done.
  assert.throws(
    () => new FleetDaemon({ home, provider: new StubProvider(), longPollMs: LONG_POLL_MS }),
    /another daemon holds/,
  );
  assert.ok(
    !existsSync(join(home, "jobs", `${id}.corrupt`)),
    "the refused daemon must not have quarantined a job in a home it does not own",
  );
});

test("stale lock from a dead daemon does not block restart", async (t) => {
  const home = tempHome();

  // A crashed daemon's lock: well-formed, but its heartbeat stopped long ago.
  // Deliberately carrying THIS process's pid — on ECS the daemon is pid 1 of
  // its task and the replacement task is pid 1 too, so a liveness test that
  // asks "is that pid alive?" answers yes about itself and never lets the
  // daemon boot again. Staleness is the clock, not the pid.
  mkdirSync(home, { recursive: true });
  writeFileSync(
    daemonLockPath(home),
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      updatedAt: Date.now() - (STALE_AFTER_MS + 1_000),
    }),
  );

  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());

  const res = await op(ctx.sock, "GET", "/jobs");
  assert.equal(res.status, 200);
});

test("a torn lock file does not block boot", async (t) => {
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  // Half a write. A lock nobody can read names no holder, and refusing on it
  // would be one torn file bricking the daemon — the bug #112 is about.
  writeFileSync(daemonLockPath(home), '{"pid": 12');

  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  assert.equal((await op(ctx.sock, "GET", "/jobs")).status, 200);
});

test("lock is released on stop, allowing a subsequent daemon", async () => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  await ctx.daemon.stop();
  assert.ok(!existsSync(daemonLockPath(home)), "stop must release the lock");

  const ctx2 = await startDaemon(home);
  assert.ok(existsSync(daemonLockPath(home)), "the next daemon claims it");
  await ctx2.daemon.stop();
});

// --- #113: Append-before-seq (crash safety) ---------------------------------

test("a retry after a crash between append and seq-record is deduped, not appended twice", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, SETTLE));
  await ctx.daemon.stop();

  // Reconstruct the on-disk state that a crash in the append-before-seq window
  // leaves behind: the journal holds seq 1, job.json never got to record it.
  // This state is only reachable BECAUSE the append moved first — under the old
  // ordering the event would simply be gone, which is the bug.
  const recordPath = join(jobDir(home, id), "job.json");
  const raw = JSON.parse(readFileSync(recordPath, "utf8"));
  raw.lastRunnerSeq = 0;
  writeFileSync(recordPath, JSON.stringify(raw, null, 2));

  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  // The runner never saw a response, so it retries seq 1 verbatim. The daemon
  // must recognise its own stored copy. The retried seq is ABOVE the recorded
  // lastRunnerSeq — a dedup check gated on `seq <= lastRunnerSeq` never runs
  // here and the settle lands a second time.
  const retry = await runnerPost(ctx2.sock, id, token, event(id, 1, SETTLE));
  assert.equal(retry.status, 200, retry.body);
  assert.ok(JSON.parse(retry.body).deduped, `retry must be deduped; got ${retry.body}`);

  const settles = (parseNdjson(
    readFileSync(join(jobDir(home, id), "events.jsonl"), "utf8"),
  ) as { type: string }[]).filter((e) => e.type === "settle");
  assert.equal(settles.length, 1, "the settle must appear exactly once in the journal");
});

test("a re-entered runner's seq 0 is not deduped against the previous generation's", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  // Generation 1 parks. Its first event is `state running` at claimed seq 0.
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, {
    type: "decision",
    id: "d1",
    question: "Proceed?",
    options: [{ id: "go", label: "Go", recommended: true }, { id: "stop", label: "Stop" }],
  }));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));

  const answered = await op(ctx.sock, "POST", `/jobs/${id}/answer`, { option: "go" });
  assert.equal(answered.status, 200, answered.body);

  // Generation 2 starts its own seq at 0, and its first event is byte-identical
  // to generation 1's. Dedup must be scoped to the current generation or the
  // fresh runner's `running` is swallowed as a duplicate and the job never
  // leaves blocked.
  const relaunch = ctx.provider.launches.at(-1)!;
  const res = await runnerPost(ctx.sock, id, relaunch.runnerToken, event(id, 0, { type: "state", state: "running" }));
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).deduped, undefined, "generation 2's first event is not a duplicate");
  assert.equal(jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json).state, "running");
});

test("retried duplicate event with same payload gets 200 deduped", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));

  // Send a think event (seq 1).
  const think = event(id, 1, { type: "think", text: "same content" });
  const res1 = await runnerPost(ctx.sock, id, token, think);
  assert.equal(res1.status, 200, res1.body);

  // Retry the same event (same seq, same payload).
  const res2 = await runnerPost(ctx.sock, id, token, think);
  assert.equal(res2.status, 200, res2.body);
  const body = JSON.parse(res2.body);
  assert.ok(body.deduped, "retried event should be deduped");
});

test("reused seq with different content gets 422", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));

  // Send a think event (seq 1).
  const res1 = await runnerPost(ctx.sock, id, token, event(id, 1, { type: "think", text: "original" }));
  assert.equal(res1.status, 200, res1.body);

  // Reuse seq 1 with different content — must 422 (tripwire).
  const res2 = await runnerPost(ctx.sock, id, token, event(id, 1, { type: "think", text: "different" }));
  assert.equal(res2.status, 422);
});

test("a reused seq whose difference is nested inside the payload gets 422", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));

  const first = await runnerPost(ctx.sock, id, token, event(id, 1, {
    ...SETTLE,
    report: { status: "READY", next_action: "open the PR" },
  }));
  assert.equal(first.status, 200, first.body);

  // Same type, same top-level keys — a different report. Comparing only the
  // key names (or only the top level) calls these two events identical and
  // silently drops the second, which is the opposite of the contract: dedup
  // means "I already have exactly this", never "I'll ignore whatever this is".
  const conflicting = await runnerPost(ctx.sock, id, token, event(id, 1, {
    ...SETTLE,
    report: { status: "PARTIAL", next_action: "something else entirely" },
  }));
  assert.equal(conflicting.status, 422, conflicting.body);

  const settles = ctx.daemon.registry.eventsAfter(id, -1).filter((e) => e.type === "settle");
  assert.equal(settles.length, 1);
  assert.deepEqual(settles[0]!.report, { status: "READY", next_action: "open the PR" });
});

// --- #113: Log-authoritative reconciliation ---------------------------------

test("record/journal disagreement reconciles at boot via effects replay", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, SETTLE));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "done" }));
  await ctx.daemon.stop();

  // Corrupt: set the card's state back to "running" — the journal says "done".
  const recordPath = join(jobDir(home, id), "job.json");
  const raw = JSON.parse(readFileSync(recordPath, "utf8"));
  raw.state = "running";
  // Remove settle and doneCheck so the replay can rebuild them.
  delete raw.settle;
  delete raw.doneCheck;
  writeFileSync(recordPath, JSON.stringify(raw, null, 2));

  // On boot, the reconciler should detect the disagreement and replay.
  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  const job = jobOf((await op(ctx2.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "done", "reconciliation must repair the card to match the journal");
});

test("reconciliation of a journal with historic illegal sequences neither crashes nor invents state", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, SETTLE));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "done" }));
  // The sequence these very bugs produced in live journals: a backstop cancel
  // appended after the runner had already settled done.
  appendFileSync(
    join(jobDir(home, id), "events.jsonl"),
    JSON.stringify({ job: id, seq: 3, type: "state", state: "cancelled", reason: "historic-bug" }) + "\n",
  );
  await ctx.daemon.stop();

  // Force the card non-terminal so the reconciler actually runs: a terminal
  // card short-circuits (#118 — settled journals are not re-read), so leaving
  // it at `done` would assert nothing about the replay at all.
  const recordPath = join(jobDir(home, id), "job.json");
  const raw = JSON.parse(readFileSync(recordPath, "utf8"));
  raw.state = "running";
  delete raw.settle;
  delete raw.doneCheck;
  writeFileSync(recordPath, JSON.stringify(raw, null, 2));

  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  const job = jobOf((await op(ctx2.sock, "GET", `/jobs/${id}`)).json);
  // The replay follows the journal to its end and stops there. It does not
  // refuse the illegal step, and it does not invent a state no event recorded.
  assert.equal(job.state, "cancelled");
  assert.equal(job.reason, "historic-bug");
});

test("boot reconciliation does not re-fire the outward effects of replayed events", async (t) => {
  const home = tempHome();
  const notified: string[] = [];
  const webhook = createServer((req, res) => {
    notified.push(req.url ?? "");
    res.writeHead(200).end("{}");
  });
  const listening = Promise.withResolvers<void>();
  webhook.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const addr = webhook.address() as { port: number };
  const notifyWebhooks = [`http://127.0.0.1:${addr.port}/notify`];
  t.after(() => new Promise<void>((r) => webhook.close(() => r())));

  const provider = new StubProvider();
  const daemon = new FleetDaemon({ home, provider, longPollMs: LONG_POLL_MS, notifyWebhooks });
  const { socketPath: sock } = await daemon.start();
  const ctx: Ctx = { daemon, sock, provider, home };
  const { id, token } = await createJob(ctx);

  await runnerPost(sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(sock, id, token, event(id, 1, {
    type: "decision",
    id: "d1",
    question: "Proceed?",
    options: [{ id: "go", label: "Go", recommended: true }, { id: "stop", label: "Stop" }],
  }));
  await until(() => notified.length === 1);
  await daemon.stop();

  // Disagree the card with the journal so the reconciler replays.
  const recordPath = join(jobDir(home, id), "job.json");
  const raw = JSON.parse(readFileSync(recordPath, "utf8"));
  raw.state = "running";
  writeFileSync(recordPath, JSON.stringify(raw, null, 2));

  const provider2 = new StubProvider();
  const daemon2 = new FleetDaemon({ home, provider: provider2, longPollMs: LONG_POLL_MS, notifyWebhooks });
  const { socketPath: sock2 } = await daemon2.start();
  t.after(() => daemon2.stop());

  assert.equal(jobOf((await op(sock2, "GET", `/jobs/${id}`)).json).state, "blocked");
  // Replaying the real effects function must replay the DERIVATION only. An
  // operator paged again for every historic decision on every daemon restart
  // is a worse bug than the one reconciliation fixes.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(notified.length, 1, `boot must not re-notify; got ${notified.length} notifications`);
});

// --- #113: Cancel recheck ---------------------------------------------------

// Provider that delays terminate so a done event can land during the await.
class SlowTerminateProvider implements Provider {
  readonly name = "process";
  launches: LaunchSpec[] = [];
  terminated: string[] = [];
  failNextLaunch = false;
  // Gate that terminate awaits, letting the test control the timing.
  #terminateGate = Promise.withResolvers<void>();

  async launch(spec: LaunchSpec): Promise<{ handle: string }> {
    if (this.failNextLaunch) {
      this.failNextLaunch = false;
      throw new Error("stub launch failure");
    }
    this.launches.push(spec);
    return { handle: `stub:${spec.jobId}` };
  }

  async terminate(handle: string): Promise<void> {
    this.terminated.push(handle);
    await this.#terminateGate.promise;
  }

  /** Release the terminate gate so cancel can proceed. */
  releaseTerminate(): void {
    this.#terminateGate.resolve();
  }
}

test("cancel racing a done event leaves the job done", async (t) => {
  const home = tempHome();
  const provider = new SlowTerminateProvider();
  const ctx = await startDaemon(home, provider);
  t.after(() => ctx.daemon.stop());

  const created = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(created.status, 201, created.body);
  const { id } = jobOf(created.json);
  const launch = provider.launches.find((l) => l.jobId === id)!;
  const token = launch.runnerToken;

  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));

  // Start cancel (will await terminate which blocks on the gate).
  const cancelPromise = op(ctx.sock, "POST", `/jobs/${id}/cancel`);

  // While terminate is pending, the runner posts settle + done.
  await runnerPost(ctx.sock, id, token, event(id, 1, SETTLE));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "done" }));

  // Release terminate — cancel's post-terminate recheck will see done.
  provider.releaseTerminate();

  // Cancel completes — it must see the job is now done and NOT overwrite.
  const cancelRes = await cancelPromise;
  assert.equal(cancelRes.status, 409, "cancel must see the job is terminal and refuse");

  const job = jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "done", "job must remain done, not cancelled");
});

// --- #113: Persist coalescing ------------------------------------------------

test("one job.json persist per intake event (verified by write counting)", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  // Snapshot the persist count after job creation.
  const countBefore = ctx.daemon.registry.persistCount();

  // Send a single state event — should produce exactly ONE job.json write.
  const res = await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  assert.equal(res.status, 200, res.body);

  const writes = ctx.daemon.registry.persistCount() - countBefore;
  assert.equal(
    writes,
    1,
    `expected exactly 1 job.json persist per intake event, got ${writes}`,
  );
});
test("one job.json persist per intake event, including the events that used to write six", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  // Each of these used to fan out to several separate serialize+write+rename
  // cycles inside one intake (setLastRunnerSeq, appendEvent, clearMarker,
  // updateJob, wallClock*, setOpenDecision, setDecisionBlockedAt). On EFS every
  // one is a network round trip. The count is the checkpoint: a new persist
  // call site inside intake fails here rather than showing up as latency.
  const cases: [string, Record<string, unknown>][] = [
    ["state", { type: "state", state: "running" }],
    ["think", { type: "think", text: "hello" }],
    ["decision", {
      type: "decision",
      id: "d1",
      question: "Proceed?",
      options: [{ id: "go", label: "Go", recommended: true }, { id: "stop", label: "Stop" }],
    }],
  ];
  let seq = 0;
  for (const [what, payload] of cases) {
    const before = ctx.daemon.registry.persistCount();
    const res = await runnerPost(ctx.sock, id, token, event(id, seq++, payload));
    assert.equal(res.status, 200, res.body);
    const writes = ctx.daemon.registry.persistCount() - before;
    assert.equal(writes, 1, `${what}: expected 1 job.json write per intake event, got ${writes}`);
  }
});

// --- #113: runnerSeq stored on events ---------------------------------------

test("runnerSeq is stored on appended events for dedup", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, { type: "think", text: "hello" }));

  const events = ctx.daemon.registry.eventsAfter(id, -1);
  // The first event (queued) is daemon-originated, no runnerSeq.
  // The running event (runner seq 0) and think event (runner seq 1) should
  // have runnerSeq stamped.
  const running = events.find((e) => e.type === "state" && e.state === "running");
  assert.equal(running?.runnerSeq, 0, "running event should have runnerSeq=0");
  const think = events.find((e) => e.type === "think");
  assert.equal(think?.runnerSeq, 1, "think event should have runnerSeq=1");
});

// --- NDJSON tolerance unit test ---------------------------------------------

test("parseNdjson drops a truncated final line without throwing", () => {
  const good = JSON.stringify({ seq: 0, type: "state", state: "running" });
  const good2 = JSON.stringify({ seq: 1, type: "think", text: "ok" });
  const torn = '{"seq": 2, "type": "thin';
  const text = `${good}\n${good2}\n${torn}\n`;

  const result = parseNdjson(text);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], JSON.parse(good));
  assert.deepEqual(result[1], JSON.parse(good2));
});

test("parseNdjson throws on mid-file corruption (not just the final line)", () => {
  const good = JSON.stringify({ seq: 0, type: "state", state: "running" });
  const bad = "{broken json here";
  const good2 = JSON.stringify({ seq: 2, type: "think", text: "ok" });
  const text = `${good}\n${bad}\n${good2}\n`;

  assert.throws(() => parseNdjson(text));
});
// --- stableStringify: the comparison dedup-by-content rests on ---------------

test("stableStringify is insertion-order independent at every depth", () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    stableStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
  );
});

test("stableStringify distinguishes values that differ only deep inside", () => {
  // The trap this function exists for: `JSON.stringify(o, Object.keys(o).sort())`
  // treats the array as a recursive property allowlist, so `report`'s contents
  // are erased and these two serialise identically. For a dedup check that
  // means accepting a retry as "already have exactly this" when it is not.
  const a = { type: "settle", report: { status: "READY", next_action: "open the PR" } };
  const b = { type: "settle", report: { status: "PARTIAL", next_action: "something else" } };
  assert.notEqual(stableStringify(a), stableStringify(b));
});

test("stableStringify omits undefined properties, matching JSON.stringify", () => {
  assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
  assert.equal(stableStringify({ a: 1 }), '{"a":1}');
});

// --- #113: the write-once launch data lives in its own file -----------------

test("job.json carries no manifest or work order; launch.json does", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  const { id } = await createJob(ctx);

  const card = JSON.parse(readFileSync(join(jobDir(home, id), "job.json"), "utf8"));
  assert.equal(card.workOrder, undefined, "the work order must not be in the hot record");
  assert.equal(card.launchManifest, undefined, "the manifest must not be in the hot record");
  assert.equal(card.launchEnv, undefined);
  assert.equal(card.launchSync, undefined);

  const launch = JSON.parse(readFileSync(join(jobDir(home, id), "launch.json"), "utf8"));
  assert.deepEqual(launch.workOrder, WORK_ORDER);
  assert.deepEqual(launch.launchManifest, MANIFEST);

  // The API is unchanged: the record still serves the work order, it is just
  // not re-serialised into job.json on every event.
  assert.deepEqual(jobOf((await op(ctx.sock, "GET", `/jobs/${id}`)).json).workOrder, WORK_ORDER);
});

test("the hot record does not grow with the manifest", async (t) => {
  // The reason for the split: every intake event rewrites job.json, so anything
  // in it is a per-event cost — on EFS, a per-event network round trip sized by
  // the manifest. A synced-file map makes that kilobytes.
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());

  // Synced files ride in on the dispatch body and are stored for re-entry, so
  // they are exactly the write-once bulk this split is about.
  const sync = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`FILE_${i}`, "x".repeat(200)]),
  );
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST, sync });
  assert.equal(res.status, 201, res.body);
  const { id } = jobOf(res.json);

  const cardBytes = readFileSync(join(jobDir(home, id), "job.json"), "utf8").length;
  const launchBytes = readFileSync(join(jobDir(home, id), "launch.json"), "utf8").length;
  assert.ok(launchBytes > 40_000, `the fat manifest must be somewhere: ${launchBytes} bytes`);
  assert.ok(
    cardBytes < 2_000,
    `job.json must stay small regardless of manifest size; got ${cardBytes} bytes`,
  );
});

test("launch.json is written once, not once per event", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  const before = ctx.daemon.registry.launchWriteCount();

  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, { type: "think", text: "working" }));
  await runnerPost(ctx.sock, id, token, event(id, 2, SETTLE));

  assert.equal(
    ctx.daemon.registry.launchWriteCount() - before,
    0,
    "intake must never touch the write-once file",
  );
});

test("a job dir written before the split still loads and can re-enter", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await ctx.daemon.stop();

  // Fold launch.json back into job.json and delete it — the on-disk shape every
  // existing home has. There is no migration step, so the loader has to cope.
  const dir = jobDir(home, id);
  const card = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
  const launch = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8"));
  writeFileSync(join(dir, "job.json"), JSON.stringify({ ...card, ...launch }, null, 2));
  rmSync(join(dir, "launch.json"));

  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  const job = jobOf((await op(ctx2.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "running");
  assert.deepEqual(job.workOrder, WORK_ORDER, "the work order survives from the old shape");
  // The launch details re-entry needs are intact, which is the half that would
  // silently go missing if the loader only looked at the new file.
  assert.deepEqual(ctx2.daemon.registry.getLaunchDetails(id).manifest, MANIFEST);
});

test("an unreadable launch.json does not stop the job loading", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await ctx.daemon.stop();
  writeFileSync(join(jobDir(home, id), "launch.json"), "{ torn");

  // Not quarantined: the launch half is only needed to re-launch a parked job.
  // A job whose journal is intact still serves its history and still settles,
  // and one torn file taking a live job out is the #112 failure again.
  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());
  assert.equal(jobOf((await op(ctx2.sock, "GET", `/jobs/${id}`)).json).state, "running");
});
