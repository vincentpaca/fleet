import { randomBytes } from "node:crypto";

/** Short random id with a prefix, time-ordered for stable listing. */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** Per-job runner bearer token. 256 bits of entropy, hex-encoded. */
export function newRunnerToken(): string {
  return randomBytes(32).toString("hex");
}
