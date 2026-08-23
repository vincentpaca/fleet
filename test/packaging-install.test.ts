// Installability gate (#66): the packed artifact must actually run from an
// installed location. packaging.test.ts proves the right files ship; this
// proves the shipped files work where npm puts them. The bugs it hunts:
//   1. a .ts bin — Node refuses type stripping under node_modules, so an
//      entry that works from a checkout dies the moment npm installs it;
//   2. a files-allowlist gap — the CLI here sees only what `npm pack` packed;
//   3. cwd-relative resolution of presets/ or schemas/ — every command runs
//      from a directory that is not the package root.
// The layout is built by hand (real tarball extracted under a node_modules/
// directory, deps linked, npm-style bin symlink) instead of `npm install`ing
// the tarball, so the gate never depends on the registry or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = (JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

// -- build the installed layout once, shared by every test below --

const prefix = fs.mkdtempSync(join(os.tmpdir(), 'fleet-install-'));

// Real npm produces the artifact; a hand-copied tree would test our
// assumptions about packing, not the truth.
// `npm pack --json` returns an array on npm <= 11 and an object keyed by
// package name on npm >= 12; accept both so the gate tracks npm's truth on
// either version.
const packReport = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--pack-destination', prefix], { cwd: root, encoding: 'utf8' }),
) as Array<{ filename: string }> | Record<string, { filename: string }>;
const packed = (Array.isArray(packReport) ? packReport : Object.values(packReport)) as Array<{ filename: string }>;
const tarball = join(prefix, packed[0].filename);

const pkgDir = join(prefix, 'node_modules', 'fleet');
fs.mkdirSync(pkgDir, { recursive: true });
execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', pkgDir]);

// Runtime deps resolve up the tree from node_modules/fleet: link this
// checkout's already-installed dependency tree beside the extracted package.
for (const entry of fs.readdirSync(join(root, 'node_modules'))) {
  if (entry === 'fleet' || entry.startsWith('.')) continue;
  fs.symlinkSync(join(root, 'node_modules', entry), join(prefix, 'node_modules', entry));
}

// The bin link exactly as npm lays it on disk: bin/fleet -> the manifest's
// bin target inside the package. Read the target from the *packed* manifest
// so this gate follows the package, not a copy of its value.
const packedManifest = JSON.parse(fs.readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
};
fs.mkdirSync(join(prefix, 'bin'));
fs.symlinkSync(join('..', 'node_modules', 'fleet', packedManifest.bin.fleet), join(prefix, 'bin', 'fleet'));

/** Run the installed bin from a given cwd, the way a user's shell would. */
function fleet(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [join(prefix, 'bin', 'fleet'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FLEET_HOME: join(prefix, 'fleet-home') },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('installed fleet --version runs and reports the package version', () => {
  const cwd = fs.mkdtempSync(join(os.tmpdir(), 'fleet-user-'));
  const res = fleet(cwd, '--version');
  assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.equal(res.stdout.trim(), version);
  assert.equal(res.stderr, '', 'a clean invocation must not warn on stderr');
});

test('installed fleet init scaffolds .fleet/ in a foreign cwd, and lint accepts it', () => {
  const cwd = fs.mkdtempSync(join(os.tmpdir(), 'fleet-user-'));
  const init = fleet(cwd, 'init');
  assert.equal(init.status, 0, `exit ${init.status}: ${init.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(join(cwd, '.fleet', 'manifest.json'), 'utf8')) as { version: number };
  assert.equal(manifest.version, 1);
  // lint loads the shipped schemas through the installed validator — the
  // assertion that schema resolution is module-relative, not cwd-relative.
  const lint = fleet(cwd, 'lint');
  assert.equal(lint.status, 0, `exit ${lint.status}: ${lint.stderr}`);
});
