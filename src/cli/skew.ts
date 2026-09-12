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
// The CLI's own identity depends on how it was installed (#239): a checkout
// identifies by its HEAD commit; an npm install carries no commit, so it
// identifies by the release tag its package.json version names — `v<version>`
// is tagged on every publish, a tag is a valid `?ref=`, and the remote resolves
// it to the commit every comparison below runs on. A version with no such tag
// (a prerelease, a locally-built package) has no identity a deployment could
// be converged to, and both consumers refuse it by name rather than inventing
// one. `fleet upgrade` (src/cli/upgrade.ts) owns the fix for every gap doctor
// names: the component, both identities, and the command that converges them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitValue } from '../shared/git.ts';
import { toHttpsGitUrl } from '../shared/giturl.ts';
import { packageRepository, pinnedSource } from './setup.ts';

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

/**
 * How this CLI identifies itself to a deployment (#239). A checkout is its
 * HEAD commit (ref and sha are the same string). An npm install is the
 * `v<version>` tag its package.json names, resolved on the package's own
 * repository to the commit the tag pins — a tag is a valid `?ref=`, so it can
 * be pinned, cloned, and compared exactly as a sha can. `unreleased` is the
 * one identity-less state: the version has no tag on the remote (a prerelease,
 * a locally-built package) or the remote could not be asked; both consumers
 * name that rather than pinning a ref nothing can clone.
 */
export type CliIdentity =
  | { kind: 'checkout'; ref: string; sha: string }
  | { kind: 'release'; ref: string; sha: string; repository: string }
  | { kind: 'unreleased'; version: string; repository: string; reason: 'no such tag' | 'unreachable remote' };

/** The identity of the installation rooted at `root`, however it was installed. */
export function cliIdentity(root: string): CliIdentity {
  // Only the install's own .git counts: an `npm i` into some project's
  // node_modules sits inside THAT repo, and its HEAD is not this CLI.
  if (fs.existsSync(path.join(root, '.git'))) {
    const sha = gitValue(['rev-parse', 'HEAD'], root);
    if (sha !== undefined) return { kind: 'checkout', ref: sha, sha };
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  // The same repository derivation the release module source uses (setup.ts):
  // strip npm's git+ prefix, normalise a github ssh remote to anonymous https.
  const repository = toHttpsGitUrl((packageRepository(pkg) ?? '').replace(/^git\+/, ''));
  const tag = `v${pkg.version as string}`;
  const found = remoteTagCommit(repository, tag);
  if (found.kind === 'found') return { kind: 'release', ref: tag, sha: found.sha, repository };
  return {
    kind: 'unreleased',
    version: pkg.version,
    repository,
    reason: found.kind === 'missing' ? 'no such tag' : 'unreachable remote',
  };
}

/** The commit a tag names on `repository`, asked over ls-remote — no clone, no checkout. */
function remoteTagCommit(
  repository: string,
  tag: string,
): { kind: 'found'; sha: string } | { kind: 'missing' } | { kind: 'unreachable' } {
  const res = spawnSync('git', ['ls-remote', repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    encoding: 'utf8',
    // A remote that wants credentials must fail, not park doctor on a prompt.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.status !== 0) return { kind: 'unreachable' };
  const rows = res.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('\t'));
  // An annotated tag lists two rows; the peeled ^{} one is the commit itself.
  const peeled = rows.find(([, name]) => name?.endsWith('^{}'));
  const sha = (peeled ?? rows[0])?.[0];
  return sha !== undefined ? { kind: 'found', sha } : { kind: 'missing' };
}

export type SkewInput = {
  /** What this CLI is: a checkout's commit or a release tag with its commit. */
  cli: { ref: string; sha: string };
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
  const findings: string[] = [];
  const notes: string[] = [];
  const matched: string[] = [];
  for (const pin of input.pins) comparePin(pin, input.cli, input.resolveRef, { findings, notes, matched });
  compareDaemon(input.daemon, input.cli, { findings, matched });
  if (findings.length === 0 && matched.length > 0) {
    notes.push(`skew: deployment matches this CLI at ${shortSha(input.cli.ref)} (${matched.join(', ')})`);
  }
  return { notes, findings };
}

/** One unit pin against the CLI's identity: a match, a named gap, or "nothing pinned". */
function comparePin(
  pin: UnitPin,
  cli: SkewInput['cli'],
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
  // A pin at the CLI's own tag matches by name — no resolution needed, which
  // is what lets a version-identified CLI call a tag-pinned deployment clean.
  if (pin.ref === cli.ref || sameCommit(refSha ?? pin.ref, cli.sha)) {
    out.matched.push(`unit ref ${shortSha(pin.ref)}`);
    return;
  }
  const resolved = refSha !== undefined && refSha !== pin.ref ? ` (${shortSha(refSha)})` : '';
  out.findings.push(
    `deployment skew: ${pin.provider} unit is applied at ref ${shortSha(pin.ref)}${resolved}, this CLI is at ${shortSha(cli.ref)}` +
      " — run fleet upgrade to re-pin and re-apply it at this CLI's version (#207)",
  );
}

/** The daemon image's stamp against the CLI's commit; unknown is the tunnel section's story. */
function compareDaemon(
  daemon: DaemonBuild,
  cli: SkewInput['cli'],
  out: { findings: string[]; matched: string[] },
): void {
  if (daemon.kind === 'unknown') return;
  if (daemon.kind === 'unstamped') {
    out.findings.push(
      'deployment skew: daemon image is unstamped — it predates skew detection; rebuild it (images/build.sh --redeploy-daemon) to enable the check',
    );
    return;
  }
  if (sameCommit(daemon.sha, cli.sha)) {
    out.matched.push(`daemon image ${shortSha(daemon.sha)}`);
    return;
  }
  out.findings.push(
    `deployment skew: daemon image was built at ${shortSha(daemon.sha)}, this CLI is at ${shortSha(cli.ref)}` +
      ' — rebuild it at the applied ref (fleet upgrade --rebuild-images, or images/build.sh --redeploy-daemon from a checkout) and roll the service (#207)',
  );
}
