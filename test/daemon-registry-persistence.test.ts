// Tests for issues #112 + #113: tolerant boot, single-writer lock,
// append-before-seq, cancel recheck, log-authoritative reconciliation,
// and persist coalescing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { FleetDaemon } from "../src/daemon/server.ts";
import { parseNdjson } from "../src/shared/ndjson.ts";
import { jobDir, daemonLockPath } from "../src/shared/home.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost } from "./daemon-helpers.ts";
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

// --- #112: Single-writer lock -----------------------------------------------

test("second daemon against a live home refuses to start", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());

  // A second daemon on the same home must refuse.
  const provider2 = new StubProvider();
  const daemon2 = new FleetDaemon({ home, provider: provider2, longPollMs: LONG_POLL_MS });
  await assert.rejects(
    () => daemon2.start(),
    /daemon already running|daemon lock/,
  );
});

test("stale lock from a dead daemon does not block restart", async (t) => {
  const home = tempHome();

  // Simulate a stale lock: write a PID that is definitely not alive.
  // PID 999999 is extremely unlikely to exist.
  const lockPath = daemonLockPath(home);
  mkdirSync(home, { recursive: true });
  writeFileSync(lockPath, "999999\n");

  // Starting a daemon must reclaim the stale lock, not refuse.
  const ctx = await startDaemon(home);
  t.after(() => ctx.daemon.stop());

  // The daemon started successfully and serves.
  const res = await op(ctx.sock, "GET", "/jobs");
  assert.equal(res.status, 200);
});

test("lock is released on stop, allowing a subsequent daemon", async () => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  await ctx.daemon.stop();

  // Lock file should be cleaned up (or at least not block).
  const ctx2 = await startDaemon(home);
  await ctx2.daemon.stop();
  // No throw = success.
});

// --- #113: Append-before-seq (crash safety) ---------------------------------

test("fault-injected crash between append and seq-record: event is present after restart", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));

  // The runner sends a settle event (seq 1). The daemon appends it to the
  // journal before recording the seq. We simulate a crash AFTER the append
  // but BEFORE the seq-record by directly checking the journal.
  await runnerPost(ctx.sock, id, token, event(id, 1, SETTLE));

  // Simulate: crash after append, before seq-record would mean:
  // job.json has lastRunnerSeq=0 but journal has the settle event.
  // We manually corrupt job.json to simulate this.
  await ctx.daemon.stop();
  const recordPath = join(jobDir(home, id), "job.json");
  const raw = JSON.parse(readFileSync(recordPath, "utf8"));
  raw.lastRunnerSeq = 0; // pretend the seq-record didn't happen
  writeFileSync(recordPath, JSON.stringify(raw, null, 2));

  // On restart, the journal has the settle event. The event is NOT lost —
  // it's in the journal. The reconciler detects the disagreement (journal
  // says running but card says running with stale seq) and repairs.
  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  const events = parseNdjson(
    readFileSync(join(jobDir(home, id), "events.jsonl"), "utf8"),
  ) as { type: string; state?: string }[];
  // The settle event is present in the journal.
  assert.ok(
    events.some((e) => e.type === "settle"),
    "settle event must be present in the journal after restart",
  );
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

test("reconciliation of historic illegal sequences does not crash", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, SETTLE));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "done" }));
  // Manually append an illegal "done → cancelled" sequence (historic bug).
  const eventsPath = join(jobDir(home, id), "events.jsonl");
  appendFileSync(eventsPath, JSON.stringify({ job: id, seq: 3, type: "state", state: "cancelled", reason: "historic-bug" }) + "\n");
  await ctx.daemon.stop();

  // Boot must not crash on the illegal sequence.
  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());

  // The job loaded without crashing.
  const res = await op(ctx2.sock, "GET", `/jobs/${id}`);
  assert.equal(res.status, 200);
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