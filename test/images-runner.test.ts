// The runner image's harness layer, pinned (#228). `npm install -g opencode`
// failed every opencode image build because the published package is
// `opencode-ai` — and nothing in the suite could see it, because the cli→npm
// mapping lived only inside the Dockerfile. The suite cannot docker-build, so
// the pin is a fixture: the Dockerfile's case arms, its own comment block, and
// the manifest schema's harness enum must all agree with
// fixtures/harness-packages.json. A rename is a visible diff here, not a
// build-time surprise at the next deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dockerfile = fs.readFileSync(new URL('../images/runner/Dockerfile', import.meta.url), 'utf8');
const pinned = JSON.parse(
  fs.readFileSync(new URL('../fixtures/harness-packages.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const schema = JSON.parse(fs.readFileSync(new URL('../schemas/manifest.schema.json', import.meta.url), 'utf8'));

test('the Dockerfile installs the pinned npm package for every harness the schema names', () => {
  const arms = Object.fromEntries(
    [...dockerfile.matchAll(/^\s*([a-z-]+)\)\s+pkg="([^"]+)"/gm)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(arms, pinned, 'the case arms drifted from fixtures/harness-packages.json');

  const enumClis = schema.properties.harness.properties.cli.enum as string[];
  assert.deepEqual(
    [...enumClis].sort(),
    Object.keys(pinned).sort(),
    'a harness the manifest accepts has no runner-image install arm (or the fixture names one the schema dropped)',
  );
});

test('the Dockerfile comment tells the truth about the mapping', () => {
  // The #228 arm was fixed while the comment above it kept naming the package
  // that does not exist — a comment is what the next editor reads first.
  for (const [cli, pkg] of Object.entries(pinned)) {
    const commented = new RegExp(`^#\\s+${cli.replace(/[-]/g, '\\-')}\\s+→ ${pkg.replace(/[$@/.\-]/g, (c) => '\\' + c)}$`, 'm');
    if (dockerfile.includes(`#   ${cli}`)) {
      assert.match(dockerfile, commented, `the comment for ${cli} does not name ${pkg}`);
    }
  }
});
