// Deployment skew detection for `fleet doctor` (#207).
//
// A live deployment has identifiable versions beyond the CLI's own checkout:
// the unit ref pinned in the deployment-local `.fleet/infra/<provider>/main.tf`
// root module, the daemon image's build stamp (baked by images/build.sh,
// reported on /health — src/shared/build-stamp.ts), and the runner image's
// stamp (logged at job start; an image at rest offers no cheap probe, so
// doctor does not reach for it). Skew between them is the recurring failure of
// the first live week: the #197 incident was a runner image predating an
// already-merged fix, and nothing named the gap until the work was lost.
//
// Until #183 mints release versions that travel together, the honest
// comparison is git SHAs — imperfect (a tag and the commit it names read
// differently until git resolves them) but never wrong about a mismatch it
// reports. `fleet upgrade` (src/cli/upgrade.ts) owns the fix: doctor names the
// component, both SHAs, and the command that converges them.
import fs from 'node:fs';
import path from 'node:path';
import { pinnedSource } from './setup.ts';

/** One deployment root module's pin: where the applied unit came from. */
export type UnitPin = {
  provider: string;
  /** The module source as written in the deployment's main.tf. */
  source: string;
  /** The git ref that source pins, when it pins one (via pinnedSource). */
  ref?: string;
};

/** What doctor could learn about the daemon image's build. */
export type DaemonBuild =
  | { kind: 'unknown' } // no deployment daemon reachable — the tunnel section owns that story
  | { kind: 'unstamped' } // /health answered without a stamp: the image predates #207
  | { kind: 'stamped'; sha: string };

/**
 * Every `.fleet/infra/<provider>/main.tf` under cwd with its module source, in
 * directory order — the same walk `fleetConfigFiles` (client.ts) does for the
 * capture beside it. Unreadable files and files without a module source are
 * skipped, never fatal: doctor diagnoses, it does not crash on a half-written
 * deployment directory.
 */
export function appliedUnitPins(cwd: string): UnitPin[] {
  const infraDir = path.join(cwd, '.fleet', 'infra');
  let providers: string[];
  try {
    providers = fs.readdirSync(infraDir);
  } catch {
    return []; // .fleet/infra/ does not exist — no deployment here
  }
  const pins: UnitPin[] = [];
  for (const provider of providers) {
    if (!fs.statSync(path.join(infraDir, provider), { throwIfNoEntry: false })?.isDirectory()) continue;
    const source = moduleSourceIn(path.join(infraDir, provider, 'main.tf'));
    if (source === undefined) continue;
    // pinnedSource deliberately matches only clonable https git sources (its
    // other consumer, the CodeBuild image project, must refuse local paths).
    // Skew has no such constraint: any ?ref= names the commit the operator
    // applied — a git::file:// dogfood pin compares exactly like a github one.
    const ref = pinnedSource(source)?.ref ?? source.match(/[?&]ref=([0-9a-f]{7,40})(?:&|$)/)?.[1];
    pins.push({ provider, source, ref });
  }
  return pins;
}

/** The `source` argument of the `module "fleet"` block, or undefined. */
function moduleSourceIn(mainTf: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(mainTf, 'utf8');
  } catch {
    return undefined;
  }
  const block = text.match(/module\s+"fleet"\s*\{([\s\S]*?)\n\}/);
  const source = block?.[1].match(/^\s*source\s*=\s*"([^"]+)"/m);
  return source?.[1];
}

/** A sha shortened for display; a ref that is not a full sha passes through. */
export function shortSha(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

/**
 * Do two identifiers name the same commit? Exact match, or one is a hex prefix
 * of the other (a short sha against a full one) — at least 7 characters, so a
 * ref like "v1" can never accidentally "match" a sha starting with v1's hex.
 * Exported for ./upgrade.ts: "already converged" is the same judgement as
 * "not skewed", made by the same function.
 */
export function sameCommit(a: string, b: string): boolean {
  if (a === b) return true;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  return short.length >= 7 && /^[0-9a-f]+$/.test(short) && long.startsWith(short);
}

export type SkewInput = {
  /** HEAD of the CLI's own checkout; undefined when the install is not one. */
  cliSha: string | undefined;
  pins: UnitPin[];
  daemon: DaemonBuild;
  /** ref → commit sha in the CLI's checkout, undefined when unresolvable. */
  resolveRef: (ref: string) => string | undefined;
};

/**
 * Compose the skew section from what the callers gathered. Pure — every git
 * call and daemon request happens in doctorSkew (src/cli/main.ts), so the
 * message contract is testable without a checkout or a daemon.
 */
export function skewReport(input: SkewInput): { notes: string[]; findings: string[] } { // contract pin: test-only export, asserted by the suite
  const { cliSha } = input;
  if (cliSha === undefined) {
    // No anchor to compare against: an npm install carries no git SHA. Honest
    // silence beats a fake identity; #183's release versions close this gap.
    return { notes: ['skew: this CLI is not a git checkout — no SHA to compare the deployment against (#183 will version releases)'], findings: [] };
  }
  const findings: string[] = [];
  const notes: string[] = [];
  const matched: string[] = [];
  for (const pin of input.pins) comparePin(pin, cliSha, input.resolveRef, { findings, notes, matched });
  compareDaemon(input.daemon, cliSha, { findings, matched });
  if (findings.length === 0 && matched.length > 0) {
    notes.push(`skew: deployment matches this CLI at ${shortSha(cliSha)} (${matched.join(', ')})`);
  }
  return { notes, findings };
}

/** One unit pin against the CLI's sha: a match, a named gap, or "nothing pinned". */
function comparePin(
  pin: UnitPin,
  cliSha: string,
  resolveRef: SkewInput['resolveRef'],
  out: { findings: string[]; notes: string[]; matched: string[] },
): void {
  if (pin.ref === undefined) {
    // A local-path source (the dogfood shape) pins no ref; there is nothing to
    // compare and inventing a verdict would be worse than saying so.
    out.notes.push(`skew: ${pin.provider} unit applied from ${pin.source} — no pinned ref to compare`);
    return;
  }
  const refSha = resolveRef(pin.ref);
  if (sameCommit(refSha ?? pin.ref, cliSha)) {
    out.matched.push(`unit ref ${shortSha(pin.ref)}`);
    return;
  }
  const resolved = refSha !== undefined && refSha !== pin.ref ? ` (${shortSha(refSha)})` : '';
  out.findings.push(
    `deployment skew: ${pin.provider} unit is applied at ref ${shortSha(pin.ref)}${resolved}, this CLI is at ${shortSha(cliSha)}` +
      " — run fleet upgrade to re-pin and re-apply it at this CLI's commit (#207)",
  );
}

/** The daemon image's stamp against the CLI's sha; unknown is the tunnel section's story. */
function compareDaemon(
  daemon: DaemonBuild,
  cliSha: string,
  out: { findings: string[]; matched: string[] },
): void {
  if (daemon.kind === 'unknown') return;
  if (daemon.kind === 'unstamped') {
    out.findings.push(
      'deployment skew: daemon image is unstamped — it predates skew detection; rebuild it (images/build.sh --redeploy-daemon) to enable the check',
    );
    return;
  }
  if (sameCommit(daemon.sha, cliSha)) {
    out.matched.push(`daemon image ${shortSha(daemon.sha)}`);
    return;
  }
  out.findings.push(
    `deployment skew: daemon image was built at ${shortSha(daemon.sha)}, this CLI is at ${shortSha(cliSha)}` +
      ' — rebuild it at the applied ref (fleet upgrade --rebuild-images, or images/build.sh --redeploy-daemon from a checkout) and roll the service (#207)',
  );
}
