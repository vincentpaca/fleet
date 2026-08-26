// The baked-setup marker: how a job image tells the runner "manifest
// setup.script already ran at image build" (#49).
//
// Two-layer job images run setup.script during `docker build` and leave this
// marker in the image (src/cli/images.ts). One-layer images — the ECS runner
// task definition's pinned :runner tag, a bare manifest setup.image — carry no
// marker, so the runner executes the script itself in the workspace before the
// pickup gate (src/runner/setup.ts). One constant shared by the baker and the
// checker, or the two sides drift and the script runs twice (or never).
//
// The marker lives under $HOME, not /etc: one constant has to name the same
// file at bake time and at check time on every substrate. In the runner image
// both sides are root's home — build layers run as root and the runner checks
// the marker *before* the privilege drop (#196), while $HOME still names the
// boot user's home. On the process provider $HOME is the operator's real home,
// where /etc was never writable. A flat dotfile rather than anything under
// ~/.fleet — that is FLEET_HOME's default, which tests and docs promise never
// to touch.

import { homedir } from "node:os";
import { join } from "node:path";

/** Marker file basename; the baked location is `$HOME/<basename>`. */
export const SETUP_BAKED_BASENAME = ".fleet-setup-baked";

/**
 * Where the runner looks for the marker. FLEET_SETUP_MARKER overrides —
 * a provider that knows better can point elsewhere, and tests can stage a
 * marker without writing to the real home directory.
 */
export function setupBakedMarkerPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.FLEET_SETUP_MARKER ?? join(homedir(), SETUP_BAKED_BASENAME);
}
