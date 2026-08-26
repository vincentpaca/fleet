// presets/modes.json and examples/work-orders.json, both deprecated by #36 and
// both still load-bearing for the migration window.
//
// The presets file is now the `--mode` mapping table and nothing else: the
// names the deprecated flag accepts, and — via each entry's authority.publish —
// whether a name asks for a read-only `inspected` job or just for delivery with
// no opinion on the rung. Order construction reads src/cli/dispatch.ts.
//
// The reference orders are the pre-migration shape the window schema must keep
// accepting. Both files, their loaders and these tests go in the follow-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWorkOrder } from '../src/validate.mjs';
import { SHAPE_DEFAULTS } from '../src/cli/dispatch.ts';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

const modes = read('presets/modes.json').modes;
const orders = read('examples/work-orders.json').orders;
const MODE_NAMES = ['assess', 'implement', 'investigate', 'followthrough', 'review', 'compare'];
/** The names that ask for a read-only job — the ones granting no publish. */
const READ_ONLY_NAMES = ['assess', 'investigate', 'review', 'compare'];

test('the mapping table still knows every name --mode accepts', () => {
  // Drop a name here and `fleet delegate --mode <name>` starts refusing a flag
  // it documented as deprecated-but-working for the whole window.
  assert.deepStrictEqual(Object.keys(modes).sort(), [...MODE_NAMES].sort());
});

test('publish is what the mapping reads, and it splits the names as documented', () => {
  // resolveModeFlag (src/cli/main.ts) branches on authority.publish alone: false
  // means "read-only, inspected", true means "publish, no rung opinion". A
  // preset that gained or lost publish would silently move a name across that
  // split — this is the checkpoint.
  const noPublish = Object.entries(modes)
    .filter(([, preset]) => preset.authority.publish !== true)
    .map(([name]) => name);
  assert.deepStrictEqual(noPublish.sort(), [...READ_ONLY_NAMES].sort());
  // And the rung the read-only names ask for is the prose row's, which is where
  // resolveModeFlag reads it from rather than hardcoding a second copy.
  assert.equal(SHAPE_DEFAULTS.prose.finish, 'inspected');
});

test('read-only names grant no write capabilities', () => {
  for (const name of READ_ONLY_NAMES) {
    const a = modes[name].authority;
    assert.equal(a.edit, false, name);
    assert.equal(a.publish, false, name);
  }
});

test('every preset still merges with a target into a valid work order', () => {
  // The window schema accepts the legacy fields; this is what proves it, from
  // the producer shape that actually exists in the wild.
  for (const [name, preset] of Object.entries(modes)) {
    const { ok, errors } = validateWorkOrder({ ...preset, target: 'X-1' });
    assert.ok(ok, `${name}: ${JSON.stringify(errors)}`);
  }
});

test('reference work orders cover every legacy mode and validate', () => {
  assert.deepStrictEqual(Object.keys(orders).sort(), [...MODE_NAMES].sort());
  for (const [name, order] of Object.entries(orders)) {
    const { ok, errors } = validateWorkOrder(order);
    assert.ok(ok, `${name}: ${JSON.stringify(errors, null, 2)}`);
    assert.equal(order.mode, name);
  }
});

test('contract fields are exercised across the reference work orders', () => {
  const all = Object.values(orders);
  for (const field of ['mode', 'target', 'truth', 'authority', 'scope', 'finish', 'report', 'limits']) {
    assert.ok(all.some((o) => o[field] !== undefined), `no reference order exercises "${field}"`);
  }
  assert.ok(all.some((o) => o.authority.runtime_read === true), 'a deprecated runtime_read must stay exercised');
  assert.ok(all.some((o) => o.scope?.exclude?.length), 'scope fences must be exercised');
});
