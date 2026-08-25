import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Temporal-state gate: shipped surfaces carry no roadmap state in their
 * prose. Comments and schema descriptions explain what reading cannot
 * ("SIGKILL, not SIGTERM: a child that traps SIGTERM wedges spawnSync");
 * they do not store progress ("Phase 1", "untested", "for now") — that
 * state lives in GitHub issues and docs/roadmap.md, which are maintained
 * as state. Rationale survives this gate; status rots behind it. This
 * gate failed on first authoring against ecs.ts's "integration untested"
 * label, which outlived its truth and was then quoted as fact by two
 * external reviews.
 */
const TOKENS = [
  /\b(?:TODO|FIXME|XXX|HACK)\b/,
  /[Pp]hase\s+[0-9]/,
  /\buntested\b/i,
  /\bfor now\b/i,
];

// Shipped surfaces only. docs/roadmap.md is where phase state belongs;
// test/ is the build harness's own home.
const SCANNED = ['src/', 'schemas/', 'presets/', 'examples/', 'integrations/', 'images/', 'infra/', 'README.md'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Markers found in one text blob, as readable pattern strings. */
export function scanText(text: string): string[] {
  return TOKENS.filter((pattern) => pattern.test(text)).map(String);
}

function* shippedFiles(): Generator<string> {
  const out = execFileSync('git', ['ls-files', '--cached'], { cwd: root, encoding: 'utf8' });
  for (const rel of out.split('\n')) {
    if (rel && SCANNED.some((p) => rel === p || rel.startsWith(p))) yield rel;
  }
}

test('shipped surfaces carry no temporal state markers', () => {
  const hits: string[] = [];
  for (const rel of shippedFiles()) {
    const found = scanText(readFileSync(join(root, rel), 'utf8'));
    if (found.length > 0) hits.push(`${rel}: ${found.join(', ')}`);
  }
  assert.deepStrictEqual(hits, [], `temporal state markers found:\n${hits.join('\n')}`);
});

// A gate that has never been seen to fail is indistinguishable from one
// that cannot: every marker class trips the scanner, and domain vocabulary
// that merely looks like it ("WIP commits", future-tense rationale) passes.
test('the scanner catches every marker class (planted violations)', () => {
  const cases: Array<[string, number]> = [
    ['// TODO rework the parser', 1],
    ['// FIXME: handle EBUSY', 1],
    ['Phase 1 ships one runner adapter', 1],
    ['phase 2 adds egress allowlists', 1],
    ['methods implemented, integration untested', 1],
    ['For now, emit a comment so the image builds', 1],
    ['commit the WIP push and settle honestly', 0],
    ['reach beyond it is governed once a broker exists', 0],
  ];
  for (const [sample, expected] of cases) {
    assert.equal(scanText(sample).length, expected, sample);
  }
});
