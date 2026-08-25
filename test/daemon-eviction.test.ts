// Issue #118: the daemon must not keep every event of every job it has ever
// run in memory, and boot must not re-parse the whole lifetime history. A
// settled job's events leave memory and its journal is not read at boot; the
// file on disk stays the source of truth, so replay (`?after=`) re-reads it on
// demand with the exact daemon seqs. GET /jobs gets a default bound: every
// live job, plus the most recently updated settled ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FleetDaemon, LIST_TERMINAL_LIMIT } from "../src/daemon/server.ts";
import { request } from "../src/shared/http.ts";
import { parseNdjson } from "../src/shared/ndjson.ts";
import { jobDir } from "../src/shared/home.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost } from "./daemon-helpers.ts";

const LONG_POLL_MS = 300;

type Ctx = { daemon: FleetDaemon; sock: string; provider: StubProvider; home: string };

async function startDaemon(home = tempHome()): Promise<Ctx> {
  const provider = new StubProvider();
  const daemon = new FleetDaemon({ home, provider, longPollMs: LONG_POLL_MS });
  const { socketPath } = await daemon.start();
  return { daemon, sock: socketPath, provider, home };
}

async function createJob(ctx: Ctx): Promise<{ id: string; token: string }> {
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(res.status, 201, res.body);
  const { id } = (res.json as { job: { id: string } }).job;
  return { id, token: ctx.provider.launches.find((l) => l.jobId === id)!.runnerToken };
}

/** Drive a job to `done`: running, settle, done — the normal clean lifecycle. */
async function settleJob(ctx: Ctx, id: string, token: string): Promise<void> {
  const events: Record<string, unknown>[] = [
    { type: "state", state: "running" },
    { type: "settle", rung: "implemented", minutes: 1, outcome: { produced: [], findings: 0, decisions: 0 } },
    { type: "state", state: "done" },
  ];
  for (const [seq, payload] of events.entries()) {
    const res = await runnerPost(ctx.sock, id, token, JSON.stringify({ job: id, seq, ...payload }));
    assert.equal(res.status, 200, res.body);
  }
}

/** Fetch the raw ndjson replay for a job over the operator socket. */
async function replay(sock: string, id: string, after?: number): Promise<unknown[]> {
  const query = after === undefined ? "" : `?after=${after}`;
  const res = await request({ socketPath: sock, method: "GET", path: `/jobs/${id}/events${query}` });
  assert.equal(res.status, 200, res.body);
  return parseNdjson(res.body);
}

test("boot does not read a settled job's journal", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await settleJob(ctx, id, token);
  await ctx.daemon.stop();

  // Corrupt the settled journal mid-file. A boot that parses it quarantines
  // the job (that is what corruption means for a LIVE job) — so a settled job
  // that survives this untouched proves its journal was never read, which is
  // the cost requirement: boot work is proportional to live jobs, not history.
  const path = join(jobDir(home, id), "events.jsonl");
  const lines = readFileSync(path, "utf8").split("\n");
  lines[1] = "{ not json — a read would quarantine this job";
  writeFileSync(path, lines.join("\n"));

  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());
  const res = await op(ctx2.sock, "GET", `/jobs/${id}`);
  assert.equal(res.status, 200, res.body);
  assert.equal((res.json as { job: { state: string } }).job.state, "done");
  assert.ok(
    !existsSync(join(home, "jobs", `${id}.corrupt`)),
    "the settled journal must not have been read, let alone quarantined",
  );
});

test("a settled job's events are not in memory after boot, yet ?after= replays from disk with exact seqs", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const { id, token } = await createJob(ctx);
  await settleJob(ctx, id, token);
  await ctx.daemon.stop();
  const onDisk = parseNdjson(readFileSync(join(jobDir(home, id), "events.jsonl"), "utf8"));

  const ctx2 = await startDaemon(home);
  t.after(() => ctx2.daemon.stop());
  assert.equal(
    ctx2.daemon.registry.eventsRetained(id),
    false,
    "a settled job's events must not be resident after boot",
  );

  // The reload path is the new failure surface this change introduces: the
  // replay must come from the file, byte-for-byte the events the daemon
  // stamped — same seqs, same order — because `?after=` consumers resume on
  // daemon seqs and a renumbered replay would corrupt every follower.
  const events = await replay(ctx2.sock, id) as { seq: number; type: string }[];
  assert.deepEqual(events, onDisk, "the replay must be exactly the journal on disk");
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3], "daemon seqs must be preserved");

  const tail = await replay(ctx2.sock, id, 1) as { seq: number }[];
  assert.deepEqual(tail.map((e) => e.seq), [2, 3], "?after= must honour the stored seqs");
});

test("events leave memory the moment a job settles, without a restart", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);
  assert.equal(ctx.daemon.registry.eventsRetained(id), true, "a live job's events are resident");

  await settleJob(ctx, id, token);
  // This is the "RSS does not grow with lifetime usage" half of #118: a daemon
  // that only evicted at boot would still hold every settled job it ran.
  assert.equal(
    ctx.daemon.registry.eventsRetained(id),
    false,
    "settling must release the job's events",
  );
  // ...and the log is still fully served, from disk.
  const events = await replay(ctx.sock, id) as { seq: number; type: string }[];
  assert.deepEqual(events.map((e) => e.type), ["state", "state", "settle", "state"]);
});

test("GET /jobs bounds settled history by default; ?all=1 returns everything", async (t) => {
  const ctx = await startDaemon();
  t.after(() => ctx.daemon.stop());

  // One live job and LIST_TERMINAL_LIMIT + 3 settled ones.
  const live = await createJob(ctx);
  const settledCount = LIST_TERMINAL_LIMIT + 3;
  let last = "";
  for (let i = 0; i < settledCount; i++) {
    const { id } = await createJob(ctx);
    // Make the final job's updatedAt strictly the latest, so "most recently
    // updated settled jobs win" is assertable without millisecond ties.
    if (i === settledCount - 1) await sleep(5);
    const cancelled = await op(ctx.sock, "POST", `/jobs/${id}/cancel`);
    assert.equal(cancelled.status, 200, cancelled.body);
    last = id;
  }

  const bounded = await op(ctx.sock, "GET", "/jobs");
  assert.equal(bounded.status, 200, bounded.body);
  const jobs = (bounded.json as { jobs: { id: string; state: string }[] }).jobs;
  assert.equal(
    jobs.length,
    1 + LIST_TERMINAL_LIMIT,
    `default listing must carry the live job plus ${LIST_TERMINAL_LIMIT} settled ones`,
  );
  assert.ok(jobs.some((j) => j.id === live.id), "a live job is never dropped from the listing");
  assert.ok(jobs.some((j) => j.id === last), "the most recently settled job makes the cut");

  const all = await op(ctx.sock, "GET", "/jobs?all=1");
  const everything = (all.json as { jobs: unknown[] }).jobs;
  assert.equal(everything.length, 1 + settledCount, "?all=1 keeps the full history reachable");
});
