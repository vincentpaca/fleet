// Analyzer scope is a claim about this codebase, so it belongs in git and under
// test. `paths-ignore` silences an entire tree; the failure it invites is
// someone adding `src/...` to make one alert go away, in a config file nobody
// reads closely. This gate pins each analyzer's exclusions exactly, so widening
// them costs a visible edit here and a reviewer's answer to "why is shipped code
// out of scope?".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Out of scope for every analyzer: build harness, never shipped
// (test/packaging.test.ts owns that boundary), never fed untrusted input.
const OUT_OF_SCOPE = ['test', 'fixtures'];

// A block reader, not a YAML parser — the repo takes no new runtime
// dependencies and the shape in question is one flat list of strings. Reads
// items until the first line that is not a list entry, so keep these lists
// free of interleaved comments.
function listAfter(yaml: string, key: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `${key}:`);
  assert.notStrictEqual(start, -1, `no \`${key}:\` block`);
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (!item) break;
    items.push(item[1].replace(/^['"]|['"]$/g, ''));
  }
  return items;
}

test('CodeQL excludes the build harness and nothing else', () => {
  const config = readFileSync(join(root, '.github/codeql/codeql-config.yml'), 'utf8');
  assert.deepStrictEqual(
    listAfter(config, 'paths-ignore').sort(),
    [...OUT_OF_SCOPE].sort(),
    'CodeQL paths-ignore drifted from the build-harness trees',
  );
});

test('CodeQL has no include-list — narrowing `paths:` would neuter the scan', () => {
  // `paths-ignore` is the pinned exclude-list above; a `paths:` include-list
  // is the same silencing move through the other door (scan only docs/ and
  // everything else falls out of scope without touching the exclusions).
  const config = readFileSync(join(root, '.github/codeql/codeql-config.yml'), 'utf8');
  assert.ok(
    !config.split('\n').some((line) => line.trimEnd() === 'paths:'),
    'codeql-config.yml grew a `paths:` include-list; scanning scope is a human call',
  );
});

// Codacy's list is longer than CodeQL's: it reads the vendored dependency tree,
// it lints the harness's instruction prose, and it lints the verbatim licence
// text (see .codacy.yaml for the per-path reasons). Pinned exactly, for the same
// reason as paths-ignore — its gate is a count, so one added line here is the
// difference between a meaningful zero and a lie.
const CODACY_EXCLUSIONS = [
  'test/**',
  'fixtures/**',
  'node_modules/**',
  'AGENTS.md',
  'CLAUDE.md',
  'agents/**',
  '.claude/**',
  'LICENSE.md',
  '.fleet/manifest.json',
  '.fleet/.gitignore',
];

// The pinned list above is only as good as the claim that none of it is code.
// Every entry beyond the build harness is prose, vendored licence text, or
// declarative config; that is the line the list is allowed to hold. Spelled out
// as its own assertion so that adding `src/**` to both this file and
// .codacy.yaml — the one-diff way to silence the scanner — still fails.
const CODE_BEARING = ['src/', 'schemas/', 'presets/', 'examples/', 'integrations/', 'images/', 'infra/', 'docs/'];

// .fleet/ is the awkward one: BUILD side and mostly config, so its manifest and
// .gitignore are excluded above — but gate.mjs decides whether a dispatch is
// ready to pick up, and setup.sh runs inside the sandbox. A prefix rule cannot
// express "the config but not the code", so the two executables are named. The
// move this catches is a later `.fleet/**` that quietly swallows both.
const MUST_STAY_SCANNED = ['.fleet/gate.mjs', '.fleet/setup.sh'];

/** Does an exclude_paths entry (a literal path, or a `dir/**` glob) cover this file? */
function covers(entry: string, file: string): boolean {
  return entry === file || (entry.endsWith('/**') && file.startsWith(entry.slice(0, -2)));
}

// Coverage has the same shape of hole as the analyzers, with a louder incentive
// behind it: a threshold someone has to meet is one `--test-coverage-exclude`
// away from being met. Excluding src/ raises the number and nothing about the
// diff says so.
test('coverage measures the product, not the harness', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.coverage;
  assert.ok(script, 'no coverage script');
  const excluded = [...script.matchAll(/--test-coverage-exclude=(\S+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    excluded.sort(),
    OUT_OF_SCOPE.map((dir) => `${dir}/**`).sort(),
    'coverage exclusions drifted from the build-harness trees',
  );
});

test('Codacy excludes the build harness and nothing else', () => {
  const excluded = listAfter(readFileSync(join(root, '.codacy.yaml'), 'utf8'), 'exclude_paths');
  assert.deepStrictEqual(
    [...excluded].sort(),
    [...CODACY_EXCLUSIONS].sort(),
    'Codacy exclude_paths drifted',
  );
  for (const dir of OUT_OF_SCOPE) {
    assert.ok(excluded.includes(`${dir}/**`), `Codacy still scans ${dir}/`);
  }
});

test('no Codacy exclusion reaches into a tree that carries code', () => {
  const excluded = listAfter(readFileSync(join(root, '.codacy.yaml'), 'utf8'), 'exclude_paths');
  for (const entry of excluded) {
    const reaches = CODE_BEARING.find((prefix) => entry.startsWith(prefix));
    assert.ok(
      !reaches,
      `Codacy exclusion \`${entry}\` reaches into ${reaches} — that tree ships or runs; ` +
        'silencing an analyzer over it is a human call, not a config edit',
    );
  }
});

test('the executables under .fleet/ stay in Codacy scope', () => {
  const excluded = listAfter(readFileSync(join(root, '.codacy.yaml'), 'utf8'), 'exclude_paths');
  for (const file of MUST_STAY_SCANNED) {
    assert.ok(existsSync(join(root, file)), `${file} is gone — retire it from MUST_STAY_SCANNED too`);
    const swallowed = excluded.find((entry) => covers(entry, file));
    assert.ok(
      !swallowed,
      `Codacy exclusion \`${swallowed}\` takes ${file} out of scope — it executes, so that is a human call`,
    );
  }
});
