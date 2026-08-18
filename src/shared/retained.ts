/**
 * Retained workspaces (issue #38): when the work push fails, the workspace is
 * the only copy of the job's output — the branch never reached the remote. Two
 * files carry that fact across the sandbox boundary:
 *
 *   <workspace>/.fleet/out/retain-workspace.json — the runner's request, read
 *     by the provider when the sandbox exits. It lives inside the out/ channel,
 *     which git already excludes, so it can never be committed or pushed.
 *   <FLEET_HOME>/retained/<jobId>.json — the host-side record, written by the
 *     provider when it honours the request. `fleet doctor` lists these so a
 *     kept workspace never leaks silently; `fleet resume-push <job>` retries
 *     the push and removes both the record and the directory once the remote
 *     has the work.
 *
 * FLEET_KEEP_WORKSPACE=1 stays a separate, unconditional debugging override: it
 * keeps the directory but writes no record — an explicitly requested keep is
 * not a lost delivery.
 *
 * These are host-local bookkeeping files, not wire contracts: reads are
 * tolerant (a malformed file is ignored, exactly like a malformed line in
 * .fleet/dispatched.jsonl) and no schema owns them.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What the runner asks the provider to keep, and why.
 *
 * Only jobId, reason, and at are guaranteed: a request file that exists but
 * cannot be parsed still keeps the workspace (the whole point), and the record
 * written for it carries what little is known. `fleet resume-push` refuses to
 * push a record without target and branch rather than guessing.
 */
export type RetainRequest = {
  jobId: string;
  /** Work-order target; the retry reuses it for the commit message. */
  target?: string;
  /** Job branch the failed push targeted. */
  branch?: string;
  /** Base branch, so the retry can judge delivery the same way the runner does. */
  base?: string;
  /** false when the harness exited nonzero — the retry keeps the (partial) marker. */
  ok?: boolean;
  /** First line of the push failure. */
  reason: string;
  /** ISO timestamp of the failure. */
  at: string;
};

/** A retain request the provider honoured, plus the path it kept. */
export type RetainedRecord = RetainRequest & { workspace: string };

/** Runner → provider request file, inside the git-excluded out/ channel. */
export function retainRequestPath(workspace: string): string {
  return join(workspace, ".fleet", "out", "retain-workspace.json");
}

/** Ask the provider to keep this workspace (runner side, at push failure). */
export function writeRetainRequest(workspace: string, request: RetainRequest): void {
  const path = retainRequestPath(workspace);
  // out/ can be gone by settle time (a harness that tidies, a git clean): its
  // absence must not turn a failed push back into a deleted workspace.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(request, null, 2) + "\n");
}

/**
 * Was a retain request left behind? This — not whether it parses — is the
 * keep-or-delete decision: a workspace kept without a usable record is
 * recoverable by hand, a deleted one is not.
 */
export function hasRetainRequest(workspace: string): boolean {
  return existsSync(retainRequestPath(workspace));
}

/** Read the request, or undefined when absent or unusable (provider side). */
export function readRetainRequest(workspace: string): RetainRequest | undefined {
  return parseRetain(retainRequestPath(workspace));
}

/** Host-side registry directory: $FLEET_HOME/retained. */
export function retainedDir(home: string): string {
  return join(home, "retained");
}

function recordPath(home: string, jobId: string): string {
  return join(retainedDir(home), `${jobId}.json`);
}

/** Register a kept workspace so it cannot leak unnoticed. */
export function writeRetainedRecord(home: string, record: RetainedRecord): string {
  const path = recordPath(home, record.jobId);
  mkdirSync(retainedDir(home), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return path;
}

/** The record for one job, or undefined when nothing is retained for it. */
export function readRetainedRecord(home: string, jobId: string): RetainedRecord | undefined {
  const parsed = parseRetain(recordPath(home, jobId));
  return parsed !== undefined && typeof (parsed as RetainedRecord).workspace === "string"
    ? (parsed as RetainedRecord)
    : undefined;
}

/** Every retained record, oldest failure first. Empty when the registry is absent. */
export function listRetainedRecords(home: string): RetainedRecord[] {
  const dir = retainedDir(home);
  if (!existsSync(dir)) return [];
  const records: RetainedRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseRetain(join(dir, name));
    if (parsed !== undefined && typeof (parsed as RetainedRecord).workspace === "string") {
      records.push(parsed as RetainedRecord);
    }
  }
  return records.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Drop the record for a job (called once the remote actually has the work). */
export function clearRetainedRecord(home: string, jobId: string): void {
  rmSync(recordPath(home, jobId), { force: true });
}

/** Tolerant read: an unreadable, non-JSON, or jobId-less file is simply absent. */
function parseRetain(path: string): RetainRequest | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    if (typeof parsed.jobId !== "string" || parsed.jobId === "") return undefined;
    return parsed as unknown as RetainRequest;
  } catch {
    return undefined;
  }
}
