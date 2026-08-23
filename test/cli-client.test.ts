// The CLI transport is a thin wrapper over src/shared/http.ts (#127): exactly
// one http.request call site, pooling disabled everywhere the daemon socket is
// spoken to, NDJSON streaming folded into the shared client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { FleetDaemon } from "../src/daemon/server.ts";
import { request as cliRequest } from "../src/cli/client.ts";
import { request } from "../src/shared/http.ts";

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

test("the shared client still refuses connection pooling", () => {
  const src = readFileSync(join(import.meta.dirname ?? ".", "..", "src", "shared", "http.ts"), "utf8");
  assert.match(src, /agent:\s*false/);
});
