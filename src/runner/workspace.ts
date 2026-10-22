/**
 * Workspace materialisation for container providers (docker, ECS).
 *
 * When a job container starts there are no files on disk — the workspace is
 * an empty directory. The runner fetches the manifest, work order, and any
 * synced files from the daemon (`GET /internal/jobs/:id/launch`, authorised
 * by its own runner token) and writes them to FLEET_WORKSPACE before reading
 * any files. They once travelled as base64 container env, and ECS caps the
 * whole overrides block at 8192 characters — a ~2KB prompt failed run-task
 * (#296).
 *
 * ProcessProvider already writes the files before launch, so this is a no-op
 * on the process path.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createIfAbsent } from "../shared/fs.ts";

/** What GET /internal/jobs/:id/launch answers: the validated POST /jobs fields. */
type LaunchPayload = { manifest?: unknown; workOrder?: unknown; sync?: Record<string, string> };

/** Where the runner fetches its launch payload from. */
type LaunchSource = { daemonUrl: string; jobId: string; token: string };

/** Per-request timeout for the launch fetch. */
const FETCH_TIMEOUT_MS = 10_000;
/**
 * Per-request timeout for the re-entry answer. The answer route long-polls
 * (the daemon's DEFAULT_LONG_POLL_MS, 25s) before it answers 204, so a shorter
 * client timeout would abort every "no answer" reply and retry it as an outage.
 */
export const ANSWER_FETCH_TIMEOUT_MS = 60_000; // contract pin: test-only export, asserted by the suite
/**
 * Transient failures retry with capped exponential backoff for about two
 * minutes. A runner that cannot stage its workspace is finished either way,
 * so waiting out a daemon restart or a slow network path costs nothing.
 */
const RETRY_BUDGET_MS = 120_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Write manifest, work order, and synced files into the workspace. No-op when
 * the manifest already exists on disk (ProcessProvider path, or a runner
 * invoked directly against a staged workspace).
 *
 * Throws when the payload cannot be had; the caller logs it as a job event and
 * settles the job blocked.
 *
 * Path-traversal guard: the daemon refuses unsafe sync keys at POST /jobs, and
 * any sync path whose resolved target still lands outside the workspace is
 * dropped here rather than written. Dropped entries come back as notes for the
 * caller to put in the job's log — one bad key should not sink the job, but it
 * must not vanish into a container's stderr either.
 */
export async function materializeWorkspace(workspace: string, source: LaunchSource): Promise<string[]> {
  const fleetDir = join(workspace, ".fleet");
  const manifestPath = join(fleetDir, "manifest.json");
  if (existsSync(manifestPath)) return [];

  const payload = (launchFromEnv() ?? (await getInternal(source, "launch"))) as LaunchPayload;
  // A lost launch half (D15) serves `manifest: null`; anything but an object
  // is no manifest, and must fail here rather than as a TypeError later.
  if (typeof payload.manifest !== "object" || payload.manifest === null) {
    throw new Error("daemon launch payload carries no manifest (the job's launch details may be lost; see its log)");
  }

  mkdirSync(join(fleetDir, "out"), { recursive: true });
  // The manifest is the marker for "this workspace is already staged", so the
  // create is also the test: if it appeared meanwhile, everything below it
  // belongs to that staging too.
  if (!createIfAbsent(manifestPath, JSON.stringify(payload.manifest, null, 2))) return [];
  if (payload.workOrder !== undefined) {
    writeFileSync(join(fleetDir, "order.json"), JSON.stringify(payload.workOrder, null, 2));
  }
  return writeSync(workspace, payload.sync ?? {});
}

/**
 * Skew compatibility (#296): a daemon predating the launch route still sends
 * the payload as base64 env, and `images/build.sh` pushes the runner image
 * before it rolls the daemon — so a job launched in that window runs this
 * runner under the old daemon. Read-only; delete once no supported daemon
 * sends FLEET_MANIFEST_JSON.
 */
function launchFromEnv(): LaunchPayload | undefined {
  const decode = (name: string): unknown => {
    const b64 = process.env[name];
    return b64 ? JSON.parse(Buffer.from(b64, "base64").toString("utf8")) : undefined;
  };
  if (!process.env.FLEET_MANIFEST_JSON) return undefined;
  return {
    manifest: decode("FLEET_MANIFEST_JSON"),
    workOrder: decode("FLEET_WORK_ORDER_JSON"),
    sync: decode("FLEET_SYNC_JSON") as Record<string, string> | undefined,
  };
}

/** The answer a re-entering runner pre-materialises for its harness (#6). */
export type ReentryAnswer = { decisionId: string; answer: { option?: string; text?: string } };

/**
 * The re-entry answer this launch carries, or undefined on any other launch.
 * The daemon names the decision (FLEET_REENTRY_DECISION); the answer itself
 * is read from the journal through the existing answer route, because a
 * free-text answer of any length cannot ride ECS's 8192-character overrides
 * (#296). An old daemon still sends the whole answer as base64 env (skew
 * compat, same expiry as launchFromEnv).
 */
export async function loadReentryAnswer(source: LaunchSource): Promise<ReentryAnswer | undefined> {
  const legacy = process.env.FLEET_REENTRY_ANSWER_JSON;
  if (legacy) return JSON.parse(Buffer.from(legacy, "base64").toString("utf8")) as ReentryAnswer;
  const decisionId = process.env.FLEET_REENTRY_DECISION;
  if (!decisionId) return undefined;
  // Answered before the re-launch, so the poll returns at once; a 204 means
  // the journal has no answer for it.
  const answer = await getInternal(source, `answer?decision=${encodeURIComponent(decisionId)}`, ANSWER_FETCH_TIMEOUT_MS);
  if (answer === undefined) throw new Error(`daemon holds no answer for re-entry decision ${decisionId}`);
  return { decisionId, answer: answer as ReentryAnswer["answer"] };
}

/** One GET's outcome: a value (undefined on 204), or an error and whether to retry it. */
type Attempt = { value: unknown } | { error: string; transient: boolean };

async function getOnce(url: string, token: string, timeoutMs: number): Promise<Attempt> {
  try {
    const response = await fetch(url, {
      headers: { "x-fleet-runner-token": token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 204) return { value: undefined };
    if (response.ok) return { value: await response.json() };
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    // The same transient set as the event sink's postWithRetry: 5xx and 429.
    // Any other 4xx is a deterministic refusal and fails at once.
    return { error: `HTTP ${response.status}: ${detail}`, transient: response.status >= 500 || response.status === 429 };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err), transient: true };
  }
}

/**
 * GET one of the job's own /internal routes with the runner token; undefined
 * on 204. Transient failures retry under RETRY_BUDGET_MS — the container can
 * start before its route to the daemon settles, or during a daemon restart.
 */
async function getInternal(source: LaunchSource, route: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const url = `${source.daemonUrl}/internal/jobs/${encodeURIComponent(source.jobId)}/${route}`;
  const deadline = Date.now() + RETRY_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    const result = await getOnce(url, source.token, timeoutMs);
    if ("value" in result) return result.value;
    const wait = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    if (!result.transient || Date.now() + wait > deadline) {
      throw new Error(`cannot fetch ${route.split("?")[0]} from ${url}: ${result.error}`);
    }
    await delay(wait);
  }
}

/** Write the sync map under the workspace; returns a note per dropped entry. */
function writeSync(workspace: string, sync: Record<string, string>): string[] {
  const dropped: string[] = [];
  const root = resolve(workspace);
  for (const [rel, b64] of Object.entries(sync)) {
    const target = resolve(root, rel);
    // Strict containment (#139): the target must live *inside* the workspace.
    // The old guard (`target !== workspace && !startsWith`) admitted the
    // workspace root itself, so a sync key of "." reached writeFileSync(root)
    // and crashed EISDIR before any EventSink existed — an opaque
    // pre-running death. Root and escape are the same rejection: neither is
    // a file inside the workspace.
    if (!target.startsWith(root + sep)) {
      dropped.push(`dropped sync entry "${rel}": it resolves to the workspace root or escapes it (${target})`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(b64, "base64"));
  }
  return dropped;
}
