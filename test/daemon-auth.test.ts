// Operator-secret enforcement on /jobs/* (issue #133): both listeners require
// the boot secret, /health stays open, /internal/* keeps its per-job token and
// stops leaking job existence through a 404-vs-401 oracle. Plus the CLI
// end-to-end path: token file present → requests just work; absent → clear
// failure, not a silent 200.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { FleetDaemon, loadOrCreateOperatorToken } from "../src/daemon/server.ts";
import { operatorTokenPath } from "../src/shared/home.ts";
import { request } from "../src/shared/http.ts";
import { MANIFEST, WORK_ORDER, StubProvider, tempHome, op, runnerPost, requestJson } from "./daemon-helpers.ts";
import { runCli } from "./cli-helpers.ts";

const OPERATOR_TOKEN = "op-secret-0123456789abcdef0123456789abcdef";
const LONG_POLL_MS = 300;

type Ctx = {
  daemon: FleetDaemon;
  sock: string;
  port: number;
  home: string;
  provider: StubProvider;
};

async function startSecuredDaemon(home: string = tempHome(), token: string = OPERATOR_TOKEN): Promise<Ctx> {
  const provider = new StubProvider();
  const daemon = new FleetDaemon({ home, provider, port: 0, longPollMs: LONG_POLL_MS, operatorToken: token });
  const { socketPath, port } = await daemon.start();
  assert.ok(port !== null);
  return { daemon, sock: socketPath, port, home, provider };
}

/** Raw TCP request against the daemon's listener. Body is JSON-encoded here. */
function tcp(
  ctx: Ctx,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: string; json: unknown }> {
  return requestJson({ host: "127.0.0.1", port: ctx.port, method, path, headers, body });
}

/** Operator request over the socket carrying the secret. */
function opAuthed(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string; json: unknown }> {
  return requestJson({
    socketPath: ctx.sock,
    method,
    path,
    headers: { "x-fleet-operator-token": OPERATOR_TOKEN },
    body,
  });
}

function authed(token: string = OPERATOR_TOKEN): Record<string, string> {
  return { "x-fleet-operator-token": token };
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

/** Create a job through the authed surface; returns its id and runner token. */
async function createJob(ctx: Ctx): Promise<{ id: string; token: string }> {
  const res = await opAuthed(ctx, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(res.status, 201, res.body);
  const job = (res.json as { job: { id: string } }).job;
  const launch = ctx.provider.launches.find((l) => l.jobId === job.id);
  assert.ok(launch, "provider.launch not called");
  return { id: job.id, token: launch.runnerToken };
}

test("TCP listener rejects every /jobs/* path without or with a wrong operator secret", async (t) => {
  const ctx = await startSecuredDaemon();
  t.after(() => ctx.daemon.stop());

  const createBody = { workOrder: WORK_ORDER, manifest: MANIFEST };
  const probes: { method: string; path: string; body?: unknown }[] = [
    { method: "GET", path: "/jobs" },
    { method: "POST", path: "/jobs", body: createBody },
    { method: "GET", path: "/jobs/job-nope" },
    { method: "GET", path: "/jobs/job-nope/events" },
    { method: "POST", path: "/jobs/job-nope/cancel" },
    { method: "GET", path: "/jobs/job-nope/artifacts" },
  ];
  for (const headers of [{}, authed("wrong-secret")]) {
    for (const probe of probes) {
      const res = await tcp(ctx, probe.method, probe.path, headers, probe.body);
      assert.equal(res.status, 401, `${probe.method} ${probe.path} with ${JSON.stringify(headers)}: ${res.body}`);
      assert.deepEqual(res.json, { error: "unauthorized" });
    }
  }
  // The unauthenticated create attempt never launched anything.
  assert.equal(ctx.provider.launches.length, 0);
});

test("TCP listener serves /jobs/* with the operator secret", async (t) => {
  const ctx = await startSecuredDaemon();
  t.after(() => ctx.daemon.stop());

  const created = await tcp(ctx, "POST", "/jobs", authed(), { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(created.status, 201, created.body);
  const id = (created.json as { job: { id: string } }).job.id;

  const listed = await tcp(ctx, "GET", "/jobs", authed());
  assert.equal(listed.status, 200);
  assert.equal((listed.json as { jobs: { id: string }[] }).jobs[0].id, id);

  const shown = await tcp(ctx, "GET", `/jobs/${id}`, authed());
  assert.equal(shown.status, 200);
  assert.equal((shown.json as { job: { id: string } }).job.id, id);
});

test("socket listener enforces the same operator secret on /jobs/*", async (t) => {
  const ctx = await startSecuredDaemon();
  t.after(() => ctx.daemon.stop());

  // Same uniform refusal as TCP — socket permissions alone no longer gate /jobs/*.
  const anon = await op(ctx.sock, "GET", "/jobs");
  assert.equal(anon.status, 401);
  assert.deepEqual(anon.json, { error: "unauthorized" });

  const wrong = await requestJson({
    socketPath: ctx.sock,
    method: "POST",
    path: "/jobs",
    headers: { "x-fleet-operator-token": "wrong-secret" },
    body: { workOrder: WORK_ORDER, manifest: MANIFEST },
  });
  assert.equal(wrong.status, 401);
  assert.equal(ctx.provider.launches.length, 0);

  // With the secret the socket serves exactly as before.
  const listed = await opAuthed(ctx, "GET", "/jobs");
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.json as { jobs: unknown[] }).jobs, []);
});

test("/health stays open on both listeners without any secret", async (t) => {
  const ctx = await startSecuredDaemon();
  t.after(() => ctx.daemon.stop());

  const viaTcp = await tcp(ctx, "GET", "/health");
  assert.equal(viaTcp.status, 200);
  assert.deepEqual(viaTcp.json, { ok: true });

  const viaSocket = await op(ctx.sock, "GET", "/health");
  assert.equal(viaSocket.status, 200);
  assert.deepEqual(viaSocket.json, { ok: true });
});

test("internal token paths unchanged; unknown id and bad token are indistinguishable 401s", async (t) => {
  const ctx = await startSecuredDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  // Valid runner token still works: the answer poll long-polls to a 204.
  const poll = await request({
    socketPath: ctx.sock,
    path: `/internal/jobs/${id}/answer?decision=d1`,
    headers: { "x-fleet-runner-token": token },
  });
  assert.equal(poll.status, 204);

  // Bad runner token: 401, same as before.
  const badToken = await runnerPost(ctx.sock, id, "not-the-token", event(id, 1, { type: "state", state: "running" }));
  assert.equal(badToken.status, 401);
  const badBody = JSON.parse(badToken.body);

  // Unknown job id: also 401 with the identical body — no existence oracle.
  const unknownNoToken = await runnerPost(ctx.sock, "job-never-existed", "whatever", "{}");
  const unknownBadToken = await runnerPost(ctx.sock, "job-never-existed", "not-the-token", "{}");
  for (const res of [unknownNoToken, unknownBadToken]) {
    assert.equal(res.status, 401);
    assert.equal(res.body, badToken.body);
  }
});

test("a container-equivalent caller (valid runner token, daemon URL) cannot answer its own decision", async (t) => {
  const ctx = await startSecuredDaemon();
  t.after(() => ctx.daemon.stop());
  const { id, token } = await createJob(ctx);

  assert.equal((await runnerPost(ctx.sock, id, token, event(id, 1, { type: "state", state: "running" }))).status, 200);
  const blocked = await runnerPost(ctx.sock, id, token, event(id, 2, DECISION));
  assert.equal(blocked.status, 200, blocked.body);

  // The compromised harness holds a valid runner token and the daemon URL.
  // Answering its own decision must fail with 401 — not 404, not 200.
  const selfAnswer = await tcp(ctx, "POST", `/jobs/${id}/answer`, { "x-fleet-runner-token": token }, { option: "flag" });
  assert.equal(selfAnswer.status, 401, selfAnswer.body);

  // Sibling enumeration is equally closed to it.
  const snoop = await tcp(ctx, "GET", "/jobs", { "x-fleet-runner-token": token });
  assert.equal(snoop.status, 401);

  // The operator, holding the secret, answers the same decision fine.
  const answered = await tcp(ctx, "POST", `/jobs/${id}/answer`, authed(), { option: "flag" });
  assert.equal(answered.status, 200, answered.body);
});

test("loadOrCreateOperatorToken persists 0600 and reuses the existing secret", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-op-token-"));

  // First boot: creates the file, mode 0600, non-empty.
  const first = loadOrCreateOperatorToken(home);
  assert.ok(first.length >= 32);
  const path = operatorTokenPath(home);
  assert.ok(existsSync(path));
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // Second boot: same secret — restarts don't invalidate held tokens.
  assert.equal(loadOrCreateOperatorToken(home), first);

  // A pre-existing non-empty file wins untouched.
  const customHome = mkdtempSync(join(tmpdir(), "fleet-op-token-"));
  const customPath = operatorTokenPath(customHome);
  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(customPath, "pre-existing-secret\n");
  chmodSync(customPath, 0o600);
  assert.equal(loadOrCreateOperatorToken(customHome), "pre-existing-secret");

  // An empty file is treated as absent and regenerated.
  const emptyHome = mkdtempSync(join(tmpdir(), "fleet-op-token-"));
  writeFileSync(operatorTokenPath(emptyHome), "");
  const regenerated = loadOrCreateOperatorToken(emptyHome);
  assert.ok(regenerated.length >= 32);
  assert.notEqual(regenerated, "");
});

test("CLI end-to-end: works with the token file present, fails clearly without it", async (t) => {
  const home = tempHome();
  const ctx = await startSecuredDaemon(home, loadOrCreateOperatorToken(home));
  t.after(() => ctx.daemon.stop());
  const env = { FLEET_HOME: home, FLEET_DAEMON_URL: `http://127.0.0.1:${ctx.port}` };

  // Token file on disk (written by the daemon boot): the CLI attaches it
  // automatically and `fleet status` succeeds against the real daemon.
  assert.ok(existsSync(operatorTokenPath(home)));
  const good = await runCli(["status"], { env });
  assert.equal(good.code, 0, `stdout: ${good.stdout}\nstderr: ${good.stderr}`);
  assert.match(good.stdout, /no jobs/);

  // Token file removed: the daemon refuses with 401 and the CLI says so
  // clearly (a fresh CLI process per runCli, so no cached token).
  rmSync(operatorTokenPath(home));
  const bad = await runCli(["status"], { env });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /status failed/);
  assert.match(bad.stderr, /unauthorized|401/);
});
