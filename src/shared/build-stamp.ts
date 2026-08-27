// The build stamp Fleet's own images carry (#207).
//
// images/build.sh resolves the checkout's git SHA and bakes it into both
// images as the FLEET_BUILD_SHA environment value (images/*/Dockerfile). The
// daemon exposes it on /health, the runner logs it at job start, and `fleet
// doctor` compares it against the CLI's own checkout — the #197 incident was a
// runner image that predated an already-merged fix, and nothing named the gap.
// A process running outside an image (a checkout daemon, the test suite) has
// no stamp, and that absence is reported honestly, never invented.

/** The git SHA baked into this image at build, or undefined when unstamped. */
export function buildStamp(env: Record<string, string | undefined> = process.env): string | undefined {
  const sha = env.FLEET_BUILD_SHA?.trim();
  return sha ? sha : undefined;
}
