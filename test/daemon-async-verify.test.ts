// Deferred rung verification (#117). gh is a network call; the old design ran
// it synchronously inside event intake (and inside the backstop sweep), so a
// slow or hung gh froze the whole daemon — /health, every runner's POST — for
// the duration. These tests inject gh runners that hang or answer late and
// assert the daemon stays responsive, records the honest interim
// "unverified: requires gh", lands the real verdict once gh answers, and
// re-runs a verification lost to a restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetDaemon } from "../src/daemon/server.ts";
import type { DaemonOptions } from "../src/daemon/server.ts";
import type { GhRunnerAsync } from "../src/shared/git.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost, until } from "./daemon-helpers.ts";

const PR = "https://github.com/owner/repo/pull/7";

/** Work order targeting a gh-dependent rung. */
const GH_ORDER = { ...WORK_ORDER, finish: "pr-open" };

/** Settle claiming pr-open with a PR URL — the shape that makes gh run. */
const SETTLE_PR = {
  type: "settle",
  rung: "pr-open",
  outcome: { produced: [], findings: 0, decisions: 0 },
  report: { status: "READY", next_action: "review the PR", pr: PR },
};

/** Generous bound for "did not wait on gh": a real gh round-trip is 2–5s. */
const PROMPT_MS = 1_000;

type Ctx = { daemon: FleetDaemon; sock: string; provider: StubProvider; home: string };

async function startDaemon(options: Partial<DaemonOptions> & { ghRunner: GhRunnerAsync }, home = tempHome()): Promise<Ctx> {
  const provider = new StubProvider();
  const daemon = new FleetDaemon({ home, provider, longPollMs: 300, ...options });
  const { socketPath } = await daemon.start();
  return { daemon, sock: socketPath, provider, home };
}

async function createJob(ctx: Ctx, workOrder: unknown = GH_ORDER): Promise<{ id: string; token: string }> {
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder, manifest: MANIFEST });
  assert.equal(res.status, 201, res.body);
  const { job } = res.json as { job: { id: string } };
  const launch = ctx.provider.launches.find((l) => l.jobId === job.id);
  assert.ok(launch, "provider.launch not called");
  return { id: job.id, token: launch.runnerToken };
}

function event(job: string, seq: number, rest: Record<string, unknown>): string {
  return JSON.stringify({ job, seq, ...rest });
}

type DoneCheck = { verified: boolean; notes: string[]; target: string };

async function doneCheckOf(ctx: Ctx, id: string): Promise<DoneCheck | undefined> {
  const res = await op(ctx.sock, "GET", `/jobs/${id}`);
  return (res.json as { job: { doneCheck?: DoneCheck } }).job.doneCheck;
}

test("terminal intake and /health stay prompt while the gh runner hangs", async (t) => {
  let ghCalls = 0;
  // A gh that never answers — the worst network blip. Old code ran it
  // synchronously inside the runner's POST, freezing every listener.
  const hungGh: GhRunnerAsync = () => {
    ghCalls += 1;
    return new Promise<string>(() => {});
  };
  const ctx = await startDaemon({ ghRunner: hungGh });
  t.after(() => ctx.daemon.stop());

  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, SETTLE_PR));

  const started = Date.now();
  const done = await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "done" }));
  assert.equal(done.status, 200, done.body);
  assert.ok(Date.now() - started < PROMPT_MS, "terminal event intake must not wait on gh");

  // The deferred verification is now in flight (and hung).
  await until(() => ghCalls >= 1);

  // /health answers while gh hangs — this is the SSM tunnel's liveness poll.
  const healthStart = Date.now();
  const health = await op(ctx.sock, "GET", "/health");
  assert.equal(health.status, 200);
  assert.ok(Date.now() - healthStart < PROMPT_MS, "/health must not wait on gh");

  // A second job's event intake proceeds while gh hangs.
  const other = await createJob(ctx, WORK_ORDER);
  const otherStart = Date.now();
  const posted = await runnerPost(ctx.sock, other.id, other.token, event(other.id, 0, { type: "state", state: "running" }));
  assert.equal(posted.status, 200, posted.body);
  assert.ok(Date.now() - otherStart < PROMPT_MS, "other jobs' intake must not wait on gh");

  // Meanwhile the settled job says the honest interim, never a lie.
  const check = await doneCheckOf(ctx, id);
  assert.equal(check?.verified, false);
  assert.deepEqual(check?.notes, ["unverified: requires gh"]);
});

test("the verdict lands on the record once a slow gh call completes", async (t) => {
  let release: (out: string) => void = () => {};
  const gate = new Promise<string>((resolve) => { release = resolve; });
  const slowGh: GhRunnerAsync = () => gate;
  const ctx = await startDaemon({ ghRunner: slowGh });
  t.after(() => ctx.daemon.stop());

  const { id, token } = await createJob(ctx);
  await runnerPost(ctx.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, id, token, event(id, 1, SETTLE_PR));
  await runnerPost(ctx.sock, id, token, event(id, 2, { type: "state", state: "done" }));

  // Intake completed with the interim doneCheck; gh has not answered yet.
  const interim = await doneCheckOf(ctx, id);
  assert.equal(interim?.verified, false);
  assert.deepEqual(interim?.notes, ["unverified: requires gh"]);

  release(JSON.stringify({ state: "OPEN" }));
  await until(async () => (await doneCheckOf(ctx, id))?.verified === true);
  const final = await doneCheckOf(ctx, id);
  assert.equal(final?.target, "pr-open");
  assert.match(final?.notes.join(" ") ?? "", /pr-open: PR is OPEN/);
});

test("backstop cancel does not block on gh; its verdict lands later too", async (t) => {
  let release: (out: string) => void = () => {};
  const gate = new Promise<string>((resolve) => { release = resolve; });
  let ghCalls = 0;
  const slowGh: GhRunnerAsync = () => { ghCalls += 1; return gate; };
  const ctx = await startDaemon({
    ghRunner: slowGh,
    wallClockBackstopMarginMs: 300,
    wallClockSweepIntervalMs: 50,
  });
  t.after(() => ctx.daemon.stop());

  // 1s wall-clock limit; the runner settles (with a PR) but never goes
  // terminal — the wedge the backstop exists for.
  const manifest = { ...MANIFEST, limits: { wall_clock: "1s" } };
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: GH_ORDER, manifest });
  assert.equal(res.status, 201, res.body);
  const { job } = res.json as { job: { id: string } };
  const launch = ctx.provider.launches.find((l) => l.jobId === job.id);
  assert.ok(launch);
  await runnerPost(ctx.sock, job.id, launch.runnerToken, event(job.id, 0, { type: "state", state: "running" }));
  await runnerPost(ctx.sock, job.id, launch.runnerToken, event(job.id, 1, SETTLE_PR));

  await until(async () => {
    const r = await op(ctx.sock, "GET", `/jobs/${job.id}`);
    return (r.json as { job: { state: string } }).job.state === "cancelled";
  }, 10_000);
  await until(() => ghCalls >= 1);

  // gh is in flight and unanswered; the daemon still serves.
  const healthStart = Date.now();
  const health = await op(ctx.sock, "GET", "/health");
  assert.equal(health.status, 200);
  assert.ok(Date.now() - healthStart < PROMPT_MS, "/health must not wait on the backstop's gh call");
  const interim = await doneCheckOf(ctx, job.id);
  assert.deepEqual(interim?.notes, ["unverified: requires gh"]);

  release(JSON.stringify({ state: "OPEN" }));
  await until(async () => (await doneCheckOf(ctx, job.id))?.verified === true);
});

test("daemon restart before the deferred verification completes: boot re-runs it", async (t) => {
  const home = tempHome();
  const hungGh: GhRunnerAsync = () => new Promise<string>(() => {});
  const first = await startDaemon({ ghRunner: hungGh }, home);

  const { id, token } = await createJob(first);
  await runnerPost(first.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(first.sock, id, token, event(id, 1, SETTLE_PR));
  await runnerPost(first.sock, id, token, event(id, 2, { type: "state", state: "done" }));

  // The interim is persisted; the deferred gh check never completes.
  const interim = await doneCheckOf(first, id);
  assert.deepEqual(interim?.notes, ["unverified: requires gh"]);
  await first.daemon.stop();

  // Fresh daemon, same home, working gh: boot must notice the interim
  // doneCheck and finish the verification — never leave a settled job
  // claiming less (or more) than gh can prove.
  const goodGh: GhRunnerAsync = async () => JSON.stringify({ state: "OPEN" });
  const second = await startDaemon({ ghRunner: goodGh }, home);
  t.after(() => second.daemon.stop());

  await until(async () => (await doneCheckOf(second, id))?.verified === true);
  const final = await doneCheckOf(second, id);
  assert.equal(final?.target, "pr-open");
  assert.match(final?.notes.join(" ") ?? "", /pr-open: PR is OPEN/);
});
