import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
const SKIP = new Set(['node_modules', '.git', 'sanitized.test.mjs']);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

test('repo content carries no client- or operator-specific material', () => {
  const hits = [];
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of DENYLIST) {
      if (pattern.test(text)) hits.push(`${file.slice(root.length + 1)}: ${pattern}`);
    }
  }
  assert.deepStrictEqual(hits, [], `client-derived content found:\n${hits.join('\n')}`);
});
