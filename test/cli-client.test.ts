// The CLI transport is a thin wrapper over src/shared/http.ts (#127): exactly
// one http.request call site, pooling disabled everywhere the daemon socket is
// spoken to, NDJSON streaming folded into the shared client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { FleetDaemon, DEFAULT_LONG_POLL_MS } from "../src/daemon/server.ts";
import { request as cliRequest, daemonTarget, DaemonTargetError } from "../src/cli/client.ts";
import { request, DEFAULT_TIMEOUT_MS } from "../src/shared/http.ts";
import { FOLLOW_TIMEOUT_MS } from "../src/cli/board.ts";
import { runCli, makeTempDir, startMockDaemon, sendJson } from "./cli-helpers.ts";

test("a CLI call succeeds after the daemon socket is restarted under the same home", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "cli-client-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { FLEET_HOME: home };

  const first = new FleetDaemon({ home });
  await first.start();
  const before = await cliRequest("GET", "/health", undefined, { env });
  assert.equal(before.status, 200);

  // Restart: the old listener closes its sockets and a fresh daemon binds the
  // same path. A pooled keep-alive agent hands back the stale connection here,
  // and the next call dies writing into it.
  await first.stop();
  const second = new FleetDaemon({ home });
  await second.start();
  t.after(() => second.stop());

  const after = await cliRequest("GET", "/health", undefined, { env });
  assert.equal(after.status, 200);
});

test("shared request streams complete NDJSON lines through onLine, tail included", async (t) => {
  const sockPath = join(mkdtempSync(join(tmpdir(), "cli-ndjson-")), "d.sock");
  t.after(() => rmSync(sockPath, { force: true }));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    // One line split across writes, then an unterminated final line.
    res.write('{"seq":1}\n{"se');
    res.end('q":2}\n{"seq":3}');
  });
  server.listen(sockPath);
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());

  const lines: string[] = [];
  const res = await request({
    socketPath: sockPath,
    path: "/events",
    onLine: (line) => lines.push(line),
    timeoutMs: 5_000,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(lines, ['{"seq":1}', '{"seq":2}', '{"seq":3}']);
  assert.equal(res.body, '{"seq":1}\n{"seq":2}\n{"seq":3}');
});

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(p);
    else if (entry.name.endsWith(".ts")) yield p;
  }
}

test("exactly one http.request wrapper exists codebase-wide", () => {
  const srcDir = join(import.meta.dirname ?? ".", "..", "src");
  const offenders = [...tsFiles(srcDir)].filter(
    (f) => !f.endsWith(join("shared", "http.ts")) && /http\.request\(/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(offenders, [], "HTTP clients must delegate to src/shared/http.ts");
});

test("every client timeout outlives the daemon's long-poll window", () => {
  // A healthy `follow=1` read transfers no bytes for the daemon's whole
  // long-poll window. The client timeout is an idle timeout, so setting either
  // at or below the window destroys every healthy long-poll mid-hold with
  // "request timed out" — a regression no functional test catches quickly,
  // because it needs a 25s wait to surface.
  assert.ok(
    DEFAULT_TIMEOUT_MS > DEFAULT_LONG_POLL_MS,
    `shared default timeout ${DEFAULT_TIMEOUT_MS}ms must exceed the daemon long-poll window ${DEFAULT_LONG_POLL_MS}ms`,
  );
  assert.ok(
    FOLLOW_TIMEOUT_MS > DEFAULT_LONG_POLL_MS,
    `board follow timeout ${FOLLOW_TIMEOUT_MS}ms must exceed the daemon long-poll window ${DEFAULT_LONG_POLL_MS}ms`,
  );
});

test("a silent-but-healthy long-poll survives an idle timeout longer than the hold", async (t) => {
  // Scaled-down long-poll: the server sends nothing for 400ms, then answers.
  // The timeout is idle-based — a hold shorter than it must succeed, and one
  // longer than it must die as "request timed out", not hang.
  const dir = mkdtempSync(join(tmpdir(), "cli-longpoll-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sockPath = join(dir, "d.sock");
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      if (res.destroyed) return; // the timed-out client already hung up
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, 400);
  });
  server.listen(sockPath);
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());

  const held = await request({ socketPath: sockPath, path: "/hold", timeoutMs: 5_000 });
  assert.equal(held.status, 200);

  await assert.rejects(
    request({ socketPath: sockPath, path: "/hold", timeoutMs: 100 }),
    /request timed out/,
  );
});

test("the shared client still refuses connection pooling", () => {
  const src = readFileSync(join(import.meta.dirname ?? ".", "..", "src", "shared", "http.ts"), "utf8");
  assert.match(src, /agent:\s*false/);
});

// ── Daemon-target resolution: memoized, validated, trust-checked (#125/#135) ──

/** A checkout with one provider config naming `daemonUrl`. */
function checkoutWithDaemonUrl(daemonUrl: string): string {
  const cwd = makeTempDir("cli-target-cwd-");
  const infraDir = join(cwd, ".fleet", "infra", "aws");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(join(infraDir, "fleet-config.json"), JSON.stringify({ daemon_url: daemonUrl }));
  return cwd;
}

test("daemonTarget memoizes per process: a config rewrite mid-run does not re-read the disk", () => {
  // The cockpit's 2s poll resolved the target inside every request, re-walking
  // .fleet/infra with sync fs reads on the resident loop (#125). Resolution is
  // now once per (env, cwd) for the life of the process — nothing changes a
  // daemon_url mid-process (`fleet setup infra` writes it and exits), so a
  // rewrite mid-run staying invisible IS the documented behaviour.
  const cwd = checkoutWithDaemonUrl("http://127.0.0.1:1234");
  const env = { FLEET_HOME: makeTempDir("cli-target-home-") };
  const first = daemonTarget(env, { cwd });
  assert.ok(first.kind === "tcp" && first.port === 1234);

  writeFileSync(
    join(cwd, ".fleet", "infra", "aws", "fleet-config.json"),
    JSON.stringify({ daemon_url: "http://127.0.0.1:5678" }),
  );
  const second = daemonTarget(env, { cwd });
  assert.ok(second.kind === "tcp" && second.port === 1234, "resolved once, served from memory after");
});

test("a repo config naming a non-loopback daemon_url is refused without the override (#135)", () => {
  // dispatchDelegate POSTs env secrets and synced files to whatever daemon_url
  // the checkout's config names — a cloned malicious repo must not get to pick
  // a remote plain-http address for that.
  const cwd = checkoutWithDaemonUrl("http://fleet-remote.invalid:9000");
  const env = { FLEET_HOME: makeTempDir("cli-target-home-") };
  assert.throws(() => daemonTarget(env, { cwd }), (err: unknown) => {
    assert.ok(err instanceof DaemonTargetError);
    assert.match(err.message, /refusing daemon_url http:\/\/fleet-remote\.invalid:9000/);
    assert.match(err.message, /FLEET_ALLOW_REMOTE_DAEMON=1/, "the refusal names its override");
    return true;
  });
  // The refusal repeats — a failed resolution must never be memoized away.
  assert.throws(() => daemonTarget(env, { cwd }), DaemonTargetError);

  const allowed = daemonTarget({ ...env, FLEET_ALLOW_REMOTE_DAEMON: "1" }, { cwd });
  assert.ok(allowed.kind === "tcp" && allowed.host === "fleet-remote.invalid", "the explicit override is honoured");
});

test("an https daemon_url is refused readably — this client cannot actually speak it", () => {
  // src/shared/http.ts is node:http; an https:// value used to be silently
  // spoken as plain HTTP to port 80.
  const cwd = checkoutWithDaemonUrl("https://fleet-remote.invalid");
  assert.throws(
    () => daemonTarget({ FLEET_HOME: makeTempDir("cli-target-home-") }, { cwd }),
    /plain HTTP only/,
  );
});

test("a bad FLEET_DAEMON_URL is a one-line failure, exit 1, no stack (#125)", async () => {
  const garbage = await runCli(["status"], { env: { FLEET_DAEMON_URL: "garbage" } });
  assert.equal(garbage.code, 1);
  assert.match(garbage.stderr, /FLEET_DAEMON_URL is not a valid URL: "garbage"/);
  assert.doesNotMatch(garbage.stderr, /TypeError|node:internal|at .*\.ts:\d/, "no stack trace");

  const https = await runCli(["status"], { env: { FLEET_DAEMON_URL: "https://127.0.0.1:9" } });
  assert.equal(https.code, 1);
  assert.match(https.stderr, /FLEET_DAEMON_URL must be an http:\/\/ URL/);
  assert.doesNotMatch(https.stderr, /TypeError|node:internal/, "no stack trace");
});

test("an untrusted daemon_url refusal reaches the operator as one line, and the override lifts it", async () => {
  const cwd = checkoutWithDaemonUrl("http://fleet-remote.invalid:9000");

  const refused = await runCli(["status"], { cwd });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /refusing daemon_url http:\/\/fleet-remote\.invalid:9000/);
  assert.doesNotMatch(refused.stderr, /node:internal|at .*\.ts:\d/, "no stack trace");

  // With the override the refusal is gone: the CLI goes on to (fail to) reach
  // that daemon, which proves the address was accepted and attempted.
  const allowed = await runCli(["status"], { cwd, env: { FLEET_ALLOW_REMOTE_DAEMON: "1" } });
  assert.equal(allowed.code, 1);
  assert.match(allowed.stderr, /cannot reach daemon at http:\/\/fleet-remote\.invalid:9000/);
});

test("the first use of a config daemon_url in a checkout warns loudly, and only the first (#135)", async (t) => {
  const daemon = await startMockDaemon({
    "GET /jobs": (_req, res) => sendJson(res, 200, { jobs: [] }),
  });
  t.after(daemon.close);
  const cwd = checkoutWithDaemonUrl(daemon.url);
  // One FLEET_HOME across both runs: the record of seen URLs lives there —
  // never under .fleet/, because the repo is the untrusted party here.
  const home = makeTempDir("cli-target-home-");

  const first = await runCli(["status"], { cwd, env: { FLEET_HOME: home } });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /first use of daemon_url/, "the first run warns");

  const second = await runCli(["status"], { cwd, env: { FLEET_HOME: home } });
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /first use of daemon_url/, "a seen URL does not warn again");
});
