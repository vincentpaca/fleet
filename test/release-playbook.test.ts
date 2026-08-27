// The release pipeline is prose (agents/release.md) plus one deterministic
// workflow (.github/workflows/release.yml) meeting over CHANGELOG.md. Prose
// rules drift, so the load-bearing agreements are pinned here: the playbook
// keeps its required sections, the changelog keeps the heading shape the
// workflow extracts by, and the workflow keeps OIDC instead of growing a
// long-lived registry token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const playbook = readFileSync(join(root, 'agents/release.md'), 'utf8');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

test('the playbook carries the four changelog sections, the bump, and the draft PR', () => {
  const required = [
    "What's new for you",
    'Upgrade notes',
    'Breaking changes',
    'All merged PRs',
    'package.json', // the version-bump step
    'draft release PR', // the finish line
  ];
  for (const needle of required) {
    assert.ok(playbook.includes(needle), `agents/release.md lost its "${needle}" contract`);
  }
});

test('the upgrade-note derivation names all three diff shapes', () => {
  for (const trigger of ['infra/', 'images/', 'schemas/']) {
    assert.ok(playbook.includes(trigger), `agents/release.md dropped the ${trigger} upgrade-note rule`);
  }
});

// The workflow extracts the release body with an awk match on "## <version> ".
// A changelog heading that stops looking like that ships a release with the
// wrong (or no) notes, and nothing else would catch it before the publish run.
test('every CHANGELOG.md release heading is "## <semver> — <date>"', () => {
  const headings = changelog.match(/^## .*$/gm) ?? [];
  assert.ok(headings.length > 0, 'CHANGELOG.md has no release headings');
  for (const heading of headings) {
    assert.match(
      heading,
      /^## \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? — \d{4}-\d{2}-\d{2}$/,
      `heading does not match the shape the publish workflow extracts by: ${heading}`,
    );
  }
});

test('the publish workflow authenticates by OIDC, never a stored registry token', () => {
  assert.ok(workflow.includes('id-token: write'), 'release.yml lost the OIDC permission');
  assert.ok(workflow.includes('--provenance'), 'release.yml no longer publishes with provenance');
  // github.token is the job's own ephemeral credential; `secrets.` anywhere
  // means a stored one crept in — NPM_TOKEN under any name.
  assert.ok(!/secrets\./.test(workflow), 'release.yml grew a stored secret');
});

// package.json needs a repository URL matching this repo or `npm publish
// --provenance` fails inside the one environment that can run it.
test('package.json names the repository provenance validates against', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    repository?: { url?: string };
  };
  assert.ok(
    (pkg.repository?.url ?? '').includes('github.com/vincentpaca/fleet'),
    'repository.url missing or wrong',
  );
});
