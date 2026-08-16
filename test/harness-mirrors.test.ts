// Canonical agents live in agents/; per-harness files are pointers and carry
// no content. A mirror that stops referencing its canonical is drift — fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const MIRRORS: Record<string, string> = {
  '.claude/commands/dev.md': 'agents/dev.md',
  '.claude/agents/code-reviewer.md': 'agents/code-reviewer.md',
};

for (const [mirror, canonical] of Object.entries(MIRRORS)) {
  test(`${mirror} points at ${canonical}`, () => {
    const root = new URL('../', import.meta.url);
    assert.ok(existsSync(new URL(canonical, root)), `canonical missing: ${canonical}`);
    const text = readFileSync(new URL(mirror, root), 'utf8');
    assert.ok(text.includes(canonical), `mirror does not reference its canonical`);
    const body = text.replace(/^---[\s\S]*?---/, '').trim();
    assert.ok(body.length < 400, `mirror carries content (${body.length} chars) — content belongs in ${canonical}`);
  });
}

test('canonical agent files are harness-neutral', () => {
  for (const canonical of new Set(Object.values(MIRRORS))) {
    const text = readFileSync(new URL(`../${canonical}`, import.meta.url), 'utf8');
    assert.ok(!text.includes('$ARGUMENTS'), `${canonical} leaks a harness dialect token`);
  }
});
