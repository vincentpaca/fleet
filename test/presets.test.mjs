import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWorkOrder } from '../src/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

const modes = read('presets/modes.json').modes;
const orders = read('examples/work-orders.json').orders;
const MODE_NAMES = ['assess', 'implement', 'investigate', 'followthrough', 'review', 'compare'];

test('all six modes have presets and validate with a target', () => {
  assert.deepStrictEqual(Object.keys(modes).sort(), [...MODE_NAMES].sort());
  for (const [name, preset] of Object.entries(modes)) {
    const { ok, errors } = validateWorkOrder({ ...preset, target: 'X-1' });
    assert.ok(ok, `${name}: ${JSON.stringify(errors)}`);
  }
});

test('read-only modes grant no write capabilities', () => {
  for (const name of ['assess', 'review', 'compare']) {
    const a = modes[name].authority;
    assert.equal(a.edit, false, name);
    assert.equal(a.publish, false, name);
    assert.deepStrictEqual(a.jira, ['read'], name);
  }
});

test('reference work orders cover every mode and validate', () => {
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
  assert.ok(all.some((o) => o.authority.runtime_read === true), 'investigate must exercise runtime_read');
  assert.ok(all.some((o) => o.scope?.exclude?.length), 'scope fences must be exercised');
});
