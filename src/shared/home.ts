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
