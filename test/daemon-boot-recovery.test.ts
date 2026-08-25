// Boot-time recovery of the crash windows no sweep reaches (#115).
//
// Each test constructs the on-disk shape the crash leaves — the acceptance in
// #115 — by running a daemon to the moment before the window, stopping it, and
// editing job.json to what a crash mid-await would have persisted. The reboot
// must detect and resolve the shape, not strand it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FleetDaemon } from "../src/daemon/server.ts";
import { DockerProvider } from "../src/providers/docker.ts";
import { parseNdjson } from "../src/shared/ndjson.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost } from "./daemon-helpers.ts";

const LONG_POLL_MS = 300;

/** StubProvider with a derivable handle, like docker's fleet-<jobId> names. */
class DerivingStubProvider extends StubProvider {
  deriveHandle(jobId: string): string {
    return `derived:${jobId}`;
  }
}

type Ctx = { daemon: FleetDaemon; sock: string; provider: StubProvider; home: string };

async function startDaemon(home: string, provider: StubProvider): Promise<Ctx> {
  const daemon = new FleetDaemon({ home, provider, longPollMs: LONG_POLL_MS });
  const { socketPath } = await daemon.start();
  return { daemon, sock: socketPath, provider, home };
}

type Job = { id: string; state: string; marker?: string; reason?: string; handle?: string } & Record<string, unknown>;

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

/** Rewrite fields of the persisted job.json between daemon lifetimes. */
function editJobJson(home: string, id: string, edit: (raw: Record<string, unknown>) => void): void {
  const path = join(home, "jobs", id, "job.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(raw);
  writeFileSync(path, JSON.stringify(raw, null, 2));
}

/** Append a schema-shaped event line directly to the journal. */
function appendJournal(home: string, id: string, rest: Record<string, unknown>): void {
  const path = join(home, "jobs", id, "events.jsonl");
  const events = parseNdjson(readFileSync(path, "utf8")) as { seq: number }[];
  const seq = events[events.length - 1]!.seq + 1;
  appendFileSync(path, `${JSON.stringify({ job: id, seq, at: new Date().toISOString(), ...rest })}\n`);
}

test("boot finishes a re-entry the crash interrupted: blocked, no marker, no open decision (#115)", async (t) => {
  const home = tempHome();
  const first = await startDaemon(home, new StubProvider());
  const { id, token } = await createJob(first);
  await runnerPost(first.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(first.sock, id, token, event(id, 1, { type: "decision", ...DECISION }));
  await runnerPost(first.sock, id, token, event(id, 2, { type: "state", state: "blocked", marker: "parked" }));
  await first.daemon.stop();

  // The crash shape: the answer was appended and the decision consumed, the
  // marker cleared — all durably — and the daemon died before provider.launch.
  appendJournal(home, id, { type: "answer", decision: "d1", option: "flag", by: "operator" });
  editJobJson(home, id, (raw) => {
    delete raw.marker;
    raw.openDecision = null;
    raw.decisionBlockedAt = null;
  });

  const provider = new StubProvider();
  const second = await startDaemon(home, provider);
  t.after(() => second.daemon.stop());

  // Boot completed the interrupted re-entry: fresh container, answer aboard.
  assert.equal(provider.launches.length, 1, "boot must re-launch the interrupted re-entry");
  const relaunch = provider.launches[0];
  assert.equal(relaunch.jobId, id);
  assert.equal(relaunch.reentryAnswer?.decisionId, "d1");
  assert.equal(relaunch.reentryAnswer?.answer.option, "flag");
  assert.notEqual(relaunch.runnerToken, token, "recovery must rotate the runner token");

  const job = jobOf((await op(second.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "blocked");
  assert.equal(job.marker, undefined);
  assert.ok(job.handle, "the recovered launch's handle must be persisted");

  // The fresh runner authenticates and resumes (seq reset to 0).
  const resumed = await runnerPost(second.sock, id, relaunch.runnerToken, event(id, 0, { type: "state", state: "running" }));
  assert.equal(resumed.status, 200, resumed.body);
});

test("boot restores an open decision the record lost when the journal's last decision is unanswered (#115)", async (t) => {
  const home = tempHome();
  const first = await startDaemon(home, new StubProvider());
  const { id, token } = await createJob(first);
  await runnerPost(first.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await runnerPost(first.sock, id, token, event(id, 1, { type: "decision", ...DECISION }));
  await first.daemon.stop();

  // Record lost the decision but the journal never saw an answer for it.
  editJobJson(home, id, (raw) => {
    raw.openDecision = null;
    raw.decisionBlockedAt = null;
  });

  const provider = new StubProvider();
  const second = await startDaemon(home, provider);
  t.after(() => second.daemon.stop());

  // No launch — the question is unanswered; it is reopened for the operator.
  assert.equal(provider.launches.length, 0);
  const answered = await op(second.sock, "POST", `/jobs/${id}/answer`, { option: "flag" });
  assert.equal(answered.status, 200, `restored decision must be answerable: ${answered.body}`);
});

test("boot cancels a queued job whose launch died with the daemon, terminating the derivable handle (#115)", async (t) => {
  const home = tempHome();
  const first = await startDaemon(home, new StubProvider());
  const { id } = await createJob(first);
  await first.daemon.stop();

  // The crash shape: record persisted before provider.launch, handle never saved.
  editJobJson(home, id, (raw) => {
    delete raw.handle;
  });

  const provider = new DerivingStubProvider();
  const second = await startDaemon(home, provider);
  t.after(() => second.daemon.stop());

  const job = jobOf((await op(second.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "cancelled", "a queued job with no handle must not sit invisible forever");
  assert.equal(job.reason, "launch-lost");
  // Spend control: whatever may have launched is terminated by derived handle.
  assert.ok(provider.terminated.includes(`derived:${id}`), `terminated: ${JSON.stringify(provider.terminated)}`);
});

test("boot adopts a derivable handle for a running job that lost its own; cancel can then terminate it (#115)", async (t) => {
  const home = tempHome();
  const first = await startDaemon(home, new StubProvider());
  const { id, token } = await createJob(first);
  await runnerPost(first.sock, id, token, event(id, 0, { type: "state", state: "running" }));
  await first.daemon.stop();

  // The crash shape: launch succeeded (the runner spoke), handle never saved.
  editJobJson(home, id, (raw) => {
    delete raw.handle;
  });

  const provider = new DerivingStubProvider();
  const second = await startDaemon(home, provider);
  t.after(() => second.daemon.stop());

  const job = jobOf((await op(second.sock, "GET", `/jobs/${id}`)).json);
  assert.equal(job.state, "running", "a healthy job must not be cancelled by recovery");
  assert.equal(job.handle, `derived:${id}`);

  // The formerly unkillable container is terminable by Fleet again.
  const cancelled = await op(second.sock, "POST", `/jobs/${id}/cancel`);
  assert.equal(cancelled.status, 200, cancelled.body);
  assert.ok(provider.terminated.includes(`derived:${id}`));
});

test("boot recovery leaves healthy shapes alone: parked-with-decision, queued-with-handle, running-with-handle", async (t) => {
  const home = tempHome();
  const first = await startDaemon(home, new StubProvider());
  // Parked with its decision open — the ordinary answerable parked job.
  const parked = await createJob(first);
  await runnerPost(first.sock, parked.id, parked.token, event(parked.id, 0, { type: "state", state: "running" }));
  await runnerPost(first.sock, parked.id, parked.token, event(parked.id, 1, { type: "decision", ...DECISION }));
  await runnerPost(first.sock, parked.id, parked.token, event(parked.id, 2, { type: "state", state: "blocked", marker: "parked" }));
  // Queued and running jobs whose handles persisted normally.
  const queued = await createJob(first);
  const running = await createJob(first);
  await runnerPost(first.sock, running.id, running.token, event(running.id, 0, { type: "state", state: "running" }));
  await first.daemon.stop();

  const provider = new DerivingStubProvider();
  const second = await startDaemon(home, provider);
  t.after(() => second.daemon.stop());

  assert.equal(provider.launches.length, 0, "recovery must not touch healthy jobs");
  assert.equal(provider.terminated.length, 0);
  assert.equal(jobOf((await op(second.sock, "GET", `/jobs/${parked.id}`)).json).marker, "parked");
  assert.equal(jobOf((await op(second.sock, "GET", `/jobs/${queued.id}`)).json).state, "queued");
  assert.equal(jobOf((await op(second.sock, "GET", `/jobs/${running.id}`)).json).state, "running");

  // The parked job is still answerable on the new daemon.
  const answered = await op(second.sock, "POST", `/jobs/${parked.id}/answer`, { option: "flag" });
  assert.equal(answered.status, 200, answered.body);
});

test("DockerProvider derives the deterministic container name as the recovery handle", () => {
  assert.equal(new DockerProvider().deriveHandle("job-abc123"), "fleet-job-abc123");
});
