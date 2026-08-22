// Analyzer scope is a claim about this codebase, so it belongs in git and under
// test. `paths-ignore` silences an entire tree; the failure it invites is
// someone adding `src/...` to make one alert go away, in a config file nobody
// reads closely. This gate pins the exclusions to the two trees that have no
// attacker, so widening them costs a visible edit here and a reviewer's answer
// to "why is shipped code out of scope?".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('Codacy excludes the same trees', () => {
  const excluded = listAfter(readFileSync(join(root, '.codacy.yaml'), 'utf8'), 'exclude_paths');
  for (const dir of OUT_OF_SCOPE) {
    assert.ok(excluded.includes(`${dir}/**`), `Codacy still scans ${dir}/`);
  }
});
