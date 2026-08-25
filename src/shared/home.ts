import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve FLEET_HOME: env override or ~/.fleet. */
export function fleetHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.FLEET_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".fleet");
}

/** On-disk job directory: $FLEET_HOME/jobs/<jobId>. */
export function jobDir(home: string, jobId: string): string {
  return join(home, "jobs", jobId);
}

/** Daemon unix socket: $FLEET_HOME/daemon.sock. */
export function socketPath(home: string): string {
  return join(home, "daemon.sock");
}

/** Artifact storage directory for a job: $FLEET_HOME/jobs/<jobId>/artifacts. */
export function artifactDir(home: string, jobId: string): string {
  return join(home, "jobs", jobId, "artifacts");
}

/** Per-file artifact size cap enforced by both daemon (intake) and runner (pre-flight). */
export const ARTIFACT_PER_FILE_CAP = 10 * 1024 * 1024; // 10 MB

/** Total artifact size cap per job, enforced by daemon at intake. */
export const ARTIFACT_TOTAL_CAP = 100 * 1024 * 1024;   // 100 MB

/**
 * File-count cap on the runner's artifact walk (#139). The byte caps bound
 * size, not count: a directory of a million empty files delays or OOMs the
 * settle inside the daemon's backstop margin, which then synthesizes PARTIAL
 * and the real settle is lost. Over-cap files are skipped with a loud note,
 * same bargain as the byte caps.
 */
export const ARTIFACT_MAX_FILES = 256;

/** Boot-generated operator secret: $FLEET_HOME/operator-token (mode 0600). */
export function operatorTokenPath(home: string): string {
  return join(home, "operator-token");
}

/** Single-writer lock: $FLEET_HOME/daemon.lock (O_EXCL pidfile, issue #112). */
export function daemonLockPath(home: string): string {
  return join(home, "daemon.lock");
}
