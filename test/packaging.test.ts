// The ship/build boundary is the package manifest's files allowlist, not
// directory aesthetics. This gate asserts what `npm pack` would actually
// ship: the product goes out; the build harness never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Integration against the real npm CLI: the packing rules live there, so a
// mocked or reimplemented check would test our assumptions, not the truth.
// `npm pack --json` returns an array on npm <= 11 and an object keyed by
// package name on npm >= 12; accept both so the gate tracks npm's truth on
// either version.
const packReport = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })) as
  | Array<{ files: Array<{ path: string }> }>
  | Record<string, { files: Array<{ path: string }> }>;
const packed: string[] = (Array.isArray(packReport) ? packReport : Object.values(packReport))[0].files.map(
  (f) => f.path,
);

const MUST_SHIP = [
  'src/cli/bin.mjs',
  'src/cli/main.ts',
  'src/daemon/main.ts',
  'src/runner/main.ts',
  'src/providers/provider.ts',
  'src/validate.mjs',
  'schemas/manifest.schema.json',
  'schemas/work-order.schema.json',
  'schemas/events.schema.json',
  'schemas/decision-file.schema.json',
  'schemas/job-states.json',
  'presets/modes.json',
  'integrations/SKILL.md',
  'docs/architecture.md',
  'README.md',
];

// images/ ships via git source, not npm (docs/architecture.md#two-layer-job-images).
const MUST_NOT_SHIP_PREFIXES = ['test/', 'fixtures/', 'agents/', '.claude/', '.fleet/', 'infra/', 'images/'];
const MUST_NOT_SHIP_FILES = ['AGENTS.md', 'CLAUDE.md', 'tsconfig.json'];

test('the product ships', () => {
  for (const file of MUST_SHIP) {
    assert.ok(packed.includes(file), `missing from package: ${file}`);
  }
});

test('the build harness never ships', () => {
  const leaked = packed.filter(
    (p) => MUST_NOT_SHIP_PREFIXES.some((prefix) => p.startsWith(prefix)) || MUST_NOT_SHIP_FILES.includes(p),
  );
  assert.deepStrictEqual(leaked, [], `build-side files in the package:\n${leaked.join('\n')}`);
});
