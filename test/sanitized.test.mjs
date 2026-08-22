import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sanitization gate: this repo is a standalone tool. It must contain ZERO
 * client- or engagement-derived content — no client names, project keys,
 * client domains, or material copied from engagement repos. Knowledge from
 * real deployments informs the DESIGN (shapes, invariants); the CONTENT
 * stays outside this repo, permanently.
 *
 * A gate that has never been seen to fail is indistinguishable from one
 * that cannot: this gate failed on first run against the pre-cleanup tree.
 */
const DENYLIST = [
  /\buob\b/i,
  /ugp2cb/i,
  /pbai/i,
  /bcgx/i,
  /\bccf\b/i,
  /\bacx\b/i,
  /vincentpaca|pacavincentpaul|vincent\.paca|paca\.vincentpaul/i,
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Scan everything COMMITTABLE: tracked + untracked-unignored, per git.
// Deliberately-ignored local files (.envrc, editor droppings) are the
// operator's own; the gate defends what could reach the repo.
function* files() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8',
  });
  for (const rel of out.split('\n')) {
    if (!rel || rel === 'test/sanitized.test.mjs') continue;
    // `--others` reports a nested repository as one directory entry, not as
    // its files: git will not commit through it, so neither does this gate.
    // Reading it as a file throws EISDIR and takes the whole gate down.
    const abs = join(root, rel);
    if (statSync(abs).isDirectory()) continue;
    yield abs;
  }
}

test('repo content carries no client- or operator-specific material', () => {
  const hits = [];
  for (const file of files()) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of DENYLIST) {
      if (pattern.test(text)) hits.push(`${file.slice(root.length + 1)}: ${pattern}`);
    }
  }
  assert.deepStrictEqual(hits, [], `client-derived content found:\n${hits.join('\n')}`);
});
