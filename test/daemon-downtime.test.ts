// Issue #116: daemon downtime must not be billed to jobs. Wall-clock and idle
// tracking persist absolute timestamps, so the gap between a daemon's last
// write and its next boot — its own outage — used to land inside every
// `now - since` computation: the first sweep after a 90-minute outage read a
// healthy job as 90 minutes over budget (or 90 minutes silent) and cancelled
// it. On boot the clocks restart from boot time; accumulated active time stays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FleetDaemon } from "../src/daemon/server.ts";
import { jobDir } from "../src/shared/home.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost } from "./daemon-helpers.ts";

const LONG_POLL_MS = 300;
const HOUR_MS = 3_600_000;

type Ctx = { daemon: FleetDaemon; sock: string; provider: StubProvider; home: string };

async function startDaemon(home: string, sweeping = false): Promise<Ctx> {
  const provider = new StubProvider();
  const daemon = new FleetDaemon({
    home,
    provider,
    longPollMs: LONG_POLL_MS,
    // Sweeping daemons fire fast and with a tiny margin, so a bug that bills
    // the outage cancels within the test's first few hundred milliseconds.
    ...(sweeping
      ? { wallClockSweepIntervalMs: 50, wallClockBackstopMarginMs: 300, idleBackstopMarginMs: 300, backstopSettleWaitMs: 250 }
      : {}),
  });
  const { socketPath } = await daemon.start();
  return { daemon, sock: socketPath, provider, home };
}

/** Create a job under a manifest with the given limits and mark it running. */
async function runningJob(ctx: Ctx, limits: Record<string, string>): Promise<string> {
  const manifest = { ...MANIFEST, limits };
  const res = await op(ctx.sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest });
  assert.equal(res.status, 201, res.body);
  const { id } = (res.json as { job: { id: string } }).job;
  const token = ctx.provider.launches.find((l) => l.jobId === id)!.runnerToken;
  const posted = await runnerPost(ctx.sock, id, token, JSON.stringify({
    job: id, seq: 0, type: "state", state: "running",
  }));
  assert.equal(posted.status, 200, posted.body);
  return id;
}

/** Rewrite persisted internal clock fields, simulating time passed while down. */
function ageClocks(home: string, id: string, patch: Record<string, number>): void {
  const path = join(jobDir(home, id), "job.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...raw, ...patch }, null, 2));
}

async function jobState(sock: string, id: string): Promise<string> {
  const res = await op(sock, "GET", `/jobs/${id}`);
  assert.equal(res.status, 200, res.body);
  return (res.json as { job: { state: string } }).job.state;
}

test("a daemon outage is not billed to a running job's wall-clock budget", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  // 2h budget, 1h genuinely used and banked before the outage.
  const id = await runningJob(ctx, { wall_clock: "2h", idle: "12h" });
  await ctx.daemon.stop();

  // The on-disk state after a 90-minute outage: the active segment opened
  // 90 minutes ago (all of it daemon downtime) on top of 1h banked. Billing
  // the gap reads 2.5h against a 2h limit — an instant cancel at first sweep.
  const outageStart = Date.now() - 90 * 60_000;
  ageClocks(home, id, {
    wallClockActiveMs: HOUR_MS,
    wallClockActiveSince: outageStart,
    lastEventAt: outageStart,
  });

  const ctx2 = await startDaemon(home, true);
  t.after(() => ctx2.daemon.stop());
  await sleep(500); // several 50ms sweeps with a 300ms margin
  assert.equal(
    await jobState(ctx2.sock, id),
    "running",
    "a healthy job must not be cancelled for time the daemon was down",
  );

  // The budget is not reset either: the banked hour still counts, only the
  // outage is forgiven. Anything between 1h and 1h+1m is the restarted clock.
  const activeMs = ctx2.daemon.registry.wallClockActiveMs(id)!;
  assert.ok(
    activeMs >= HOUR_MS && activeMs < HOUR_MS + 60_000,
    `accumulated active time must survive the restart: got ${activeMs}ms`,
  );
});

test("a daemon outage is not read as runner silence by the stall backstop", async (t) => {
  const home = tempHome();
  const ctx = await startDaemon(home);
  const id = await runningJob(ctx, { idle: "30m" });
  await ctx.daemon.stop();

  // Three silent hours on the clock — all of them daemon downtime. Billing
  // them blames the runner for the daemon's own outage: cancelled, reason
  // "stall", against a runner that was never given a daemon to post to.
  ageClocks(home, id, { lastEventAt: Date.now() - 3 * HOUR_MS });

  const before = Date.now();
  const ctx2 = await startDaemon(home, true);
  t.after(() => ctx2.daemon.stop());
  await sleep(500);
  assert.equal(
    await jobState(ctx2.sock, id),
    "running",
    "daemon downtime must not count towards the idle threshold",
  );
  // The silence clock restarted from boot, so real post-boot silence still counts.
  const lastEventAt = ctx2.daemon.registry.lastEventAtMs(id)!;
  assert.ok(lastEventAt >= before, `lastEventAt must restart from boot time; got ${lastEventAt}`);
});
