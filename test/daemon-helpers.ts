// Shared fixtures/utilities for daemon-*.test.ts (not itself a test file).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { requestJson, request } from "../src/shared/http.ts";
import type { HttpResponse } from "../src/shared/http.ts";
import type { LaunchSpec, Provider } from "../src/providers/provider.ts";

/** Minimal valid manifest (generic content only). */
export const MANIFEST = {
  version: 1,
  setup: { image: "node:22" },
  workspace: { repo: "git@github.com:acme/webapp.git", strategy: "branch-per-job" },
  harness: {
    cli: "claude-code",
    commands: [{ path: ".claude/commands/dev-sprint.md", critic: "code-reviewer" }],
  },
  gates: { pickup: "node .fleet/check-ready.js" },
};

/** Minimal valid work order targeting a locally verifiable rung. */
export const WORK_ORDER = {
  mode: "implement",
  target: "APP-123",
  finish: "implemented",
};

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "fleet-home-"));
}

/** Provider stub recording launches/terminations without spawning anything. */
export class StubProvider implements Provider {
  readonly name = "process";
  launches: LaunchSpec[] = [];
  terminated: string[] = [];
  failNextLaunch = false;

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
  }
}

/** Operator request over the daemon unix socket. */
export function op(
  sock: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResponse & { json: unknown }> {
  return requestJson({ socketPath: sock, method, path, body });
}

/** Runner request carrying the per-job token. */
export function runnerPost(sock: string, jobId: string, token: string, body: string): Promise<HttpResponse> {
  return request({
    socketPath: sock,
    method: "POST",
    path: `/internal/jobs/${jobId}/events`,
    headers: { "x-fleet-runner-token": token, "content-type": "application/json" },
    body,
  });
}

/** Poll until `check` returns truthy or timeoutMs elapses (throws on timeout). */
export async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("condition not met in time");
}
