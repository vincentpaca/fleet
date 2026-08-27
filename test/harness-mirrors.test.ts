// Canonical agents live in agents/; per-harness files are pointers and carry
// no content. A mirror that stops referencing its canonical is drift — fail.
//
// The fleet skill (integrations/SKILL.md) follows the same rule from the other
// direction: nothing per-harness is checked in at all, because `fleet setup
// harness` generates every variant from the canonical. Both halves are enforced
// here, so "one canonical, no content forks" is a checkpoint and not a habit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkill, renderVariant, readStamp, isGenerated } from '../src/cli/setup.ts';
import { HARNESS_TARGETS } from '../src/cli/setup-harnesses.ts';

const MIRRORS: Record<string, string> = {
  '.claude/commands/dev.md': 'agents/dev.md',
  '.claude/commands/release.md': 'agents/release.md',
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

// ---------- the fleet skill and its per-harness variants (#17) ----------

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_SKILL = 'integrations/SKILL.md';
const canonicalText = readFileSync(join(root, CANONICAL_SKILL), 'utf8');
const canonical = parseSkill(canonicalText, CANONICAL_SKILL);
const roots = { home: '/home/operator', cwd: '/home/operator/project' };

for (const harness of HARNESS_TARGETS) {
  test(`the ${harness.id} variant is generated from ${CANONICAL_SKILL}, not forked from it`, () => {
    const variant = renderVariant({ canonical, harness, scope: 'user', version: '9.9.9', roots });

    // The whole canonical body, contiguous and unaltered. A variant that
    // paraphrases one sentence is exactly the drift this test exists to catch,
    // and it would read as fine.
    assert.ok(variant.text.includes(canonical.body), `${harness.id} variant does not carry the canonical body verbatim`);
    assert.ok(variant.text.includes(CANONICAL_SKILL), `${harness.id} variant does not name its canonical`);
    assert.ok(isGenerated(variant.text), `${harness.id} variant is not recognisable as fleet-generated`);

    // Everything the variant adds on top of the canonical, once the stamp is
    // gone: the generated harness note, and nothing else. That budget is the
    // difference between a generated variant and a second copy of the skill.
    // The stamp is stripped by readStamp rather than by a second regex here —
    // one spelling of that boundary, or this budget quietly starts measuring
    // something else the day the stamp changes shape.
    const added = readStamp(variant.text)!.content.replace(canonical.frontmatter, '').replace(canonical.body, '').trim();
    assert.ok(added.includes(harness.ask), `${harness.id} variant does not state this harness's ask mechanism`);
    assert.ok(
      added.length < 900,
      `${harness.id} variant adds ${added.length} chars beyond the canonical — per-harness content belongs in the harness record`,
    );
  });
}

test('every harness variant is discoverable: frontmatter first, name matching its directory', () => {
  for (const harness of HARNESS_TARGETS) {
    for (const scope of ['user', 'project'] as const) {
      const variant = renderVariant({ canonical, harness, scope, version: '9.9.9', roots });
      // Frontmatter has to be the first bytes of the file: every convention
      // Fleet installs into parses it there, so a stamp or a comment ahead of
      // it is a skill silently ignored by all three harnesses at once.
      assert.match(variant.text, /^---\nname: fleet-delegate\n/, `${harness.id}/${scope}: frontmatter is not first`);
      assert.equal(
        basename(dirname(variant.destination)),
        canonical.name,
        `${harness.id}/${scope}: skill directory must be named for the frontmatter name`,
      );
    }
  }
});

test('the fleet skill has exactly one checked-in copy', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((rel) => rel.endsWith('.md'));
  const copies = tracked.filter((rel) => /^---\n[\s\S]*?^name: fleet-delegate$/m.test(readFileSync(join(root, rel), 'utf8')));
  assert.deepStrictEqual(
    copies,
    [CANONICAL_SKILL],
    'a per-harness skill file is checked in — variants are generated by `fleet setup harness`, never committed',
  );
});
