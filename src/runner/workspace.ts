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

const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Write manifest, work order, and synced files into the workspace. No-op when
 * the manifest already exists on disk (ProcessProvider path, or a runner
 * invoked directly against a staged workspace).
 *
 * Throws when the payload cannot be had; the caller logs it as a job event and
 * the missing manifest then settles the job blocked.
 *
 * Path-traversal guard: any sync path whose resolved target escapes the
 * workspace root is silently dropped and logged to stderr. This mirrors the
 * explicit check in ProcessProvider.prepareWorkspace, but uses a log+skip
 * approach rather than throwing — the container cannot surface a throw to the
 * operator, so a log with a clear message is more useful.
 */
export async function materializeWorkspace(workspace: string, source: LaunchSource): Promise<void> {
  const fleetDir = join(workspace, ".fleet");
  const manifestPath = join(fleetDir, "manifest.json");
  if (existsSync(manifestPath)) return;

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
  if (!createIfAbsent(manifestPath, JSON.stringify(payload.manifest, null, 2))) return;
  if (payload.workOrder !== undefined) {
    writeFileSync(join(fleetDir, "order.json"), JSON.stringify(payload.workOrder, null, 2));
  }
  writeSync(workspace, payload.sync ?? {});
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
  const answer = await getInternal(source, `answer?decision=${encodeURIComponent(decisionId)}`);
  if (answer === undefined) throw new Error(`daemon holds no answer for re-entry decision ${decisionId}`);
  return { decisionId, answer: answer as ReentryAnswer["answer"] };
}

/**
 * GET one of the job's own /internal routes with the runner token; undefined
 * on 204. Transient failures (network, timeout, 5xx) retry briefly — the
 * container can start before its route to the daemon settles; a 4xx is
 * deterministic and fails at once.
 */
async function getInternal(source: LaunchSource, route: string): Promise<unknown> {
  const url = `${source.daemonUrl}/internal/jobs/${encodeURIComponent(source.jobId)}/${route}`;
  let lastError = "";
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "x-fleet-runner-token": source.token },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 204) return undefined;
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`;
      if (response.status < 500) break;
    } catch (err) {
      lastError = String(err instanceof Error ? err.message : err);
    }
    if (attempt < FETCH_ATTEMPTS) await delay(1_000 * attempt);
  }
  throw new Error(`cannot fetch ${route.split("?")[0]} from ${url}: ${lastError}`);
}

function writeSync(workspace: string, sync: Record<string, string>): void {
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
      console.error(`runner: materializeWorkspace: dropping sync entry "${rel}" — resolves to the workspace root or escapes it (${target})`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(b64, "base64"));
  }
}
