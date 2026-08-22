/**
 * Workspace materialisation for the Docker-provider path.
 *
 * When a job container starts there are no files on disk — the workspace is
 * an empty directory. The daemon encodes the manifest, work order, and any
 * synced files as base64 env vars and the runner writes them to
 * FLEET_WORKSPACE before reading any files.
 *
 * ProcessProvider already writes the files before launch, so this is a no-op
 * on the process path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createIfAbsent } from "../shared/fs.ts";

/**
 * Write manifest, work order, and synced files from env-var payloads into the
 * workspace. No-op when the manifest already exists on disk (ProcessProvider
 * path) or when FLEET_MANIFEST_JSON is absent.
 *
 * Path-traversal guard: any sync path whose resolved target escapes the
 * workspace root is silently dropped and logged to stderr. This mirrors the
 * explicit check in ProcessProvider.prepareWorkspace, but uses a log+skip
 * approach rather than throwing — the container cannot surface a throw to the
 * operator, so a log with a clear message is more useful.
 */
export function materializeWorkspace(workspace: string): void {
  const fleetDir = join(workspace, ".fleet");
  const manifestPath = join(fleetDir, "manifest.json");

  const manifestB64 = process.env.FLEET_MANIFEST_JSON;
  if (!manifestB64) return; // no env-based materialisation requested

  mkdirSync(join(fleetDir, "out"), { recursive: true });
  // The manifest is the marker for "this workspace is already staged", so the
  // create is also the test: if it was there, the ProcessProvider wrote it and
  // everything below it belongs to that staging too.
  const decoded = Buffer.from(manifestB64, "base64").toString("utf8");
  if (!createIfAbsent(manifestPath, decoded)) return;

  const orderB64 = process.env.FLEET_WORK_ORDER_JSON;
  if (orderB64) {
    writeFileSync(join(fleetDir, "order.json"), Buffer.from(orderB64, "base64").toString("utf8"));
  }

  const syncB64 = process.env.FLEET_SYNC_JSON;
  if (syncB64) {
    const sync = JSON.parse(Buffer.from(syncB64, "base64").toString("utf8")) as Record<
      string,
      string
    >;
    for (const [rel, b64] of Object.entries(sync)) {
      const target = resolve(workspace, rel);
      // Reject any path that escapes the workspace (security invariant).
      if (target !== workspace && !target.startsWith(workspace + sep)) {
        console.error(`runner: materializeWorkspace: dropping path-traversal sync entry: ${rel}`);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(b64, "base64"));
    }
  }
}
