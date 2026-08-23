// The CLI transport is a thin wrapper over src/shared/http.ts (#127): exactly
// one http.request call site, pooling disabled everywhere the daemon socket is
// spoken to, NDJSON streaming folded into the shared client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { FleetDaemon, DEFAULT_LONG_POLL_MS } from "../src/daemon/server.ts";
import { request as cliRequest } from "../src/cli/client.ts";
import { request, DEFAULT_TIMEOUT_MS } from "../src/shared/http.ts";
import { FOLLOW_TIMEOUT_MS } from "../src/cli/board.ts";

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
