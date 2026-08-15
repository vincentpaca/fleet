import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { historyToEvents, eventsToHistory } from '../src/history-events.mjs';
import { validateEvent } from '../src/validate.mjs';

/**
 * Round-trip exit test: run-history records re-express losslessly in the
 * Fleet event schema. The in-repo fixture is SYNTHETIC and covers every
 * shape variant (delegated/brainstorm, gate object/null, `more`, cancelled,
 * decidedBy). Compatibility with a real Operating Plane deployment's
 * history is verified by pointing FLEET_DEMO_HISTORY at its history.json —
 * that data never ships in this repo.
 */
const roundTrip = (run, label) => {
  const events = historyToEvents(run);
  for (const e of events) {
    const { ok, errors } = validateEvent(e);
    assert.ok(ok, `${label} ${run.id} seq ${e.seq} (${e.type}): ${JSON.stringify(errors)}`);
  }
  assert.deepStrictEqual(eventsToHistory(events), run, `${label} ${run.id} lost information in round-trip`);
};

const synthetic = JSON.parse(readFileSync(new URL('../fixtures/synthetic-history.json', import.meta.url), 'utf8'));

test('synthetic fixture covers the shape variants', () => {
  assert.ok(synthetic.some((r) => r.kind === 'brainstorm'), 'brainstorm variant');
  assert.ok(synthetic.some((r) => r.outcome.gate !== null), 'gate-object variant');
  assert.ok(synthetic.some((r) => r.outcome.more !== undefined), 'more-field variant');
  assert.ok(synthetic.some((r) => r.state === 'cancelled'), 'cancelled variant');
});

for (const run of synthetic) {
  test(`round-trip ${run.id} (${run.kind}, ${run.state})`, () => roundTrip(run, 'synthetic'));
}

test('external history round-trips when FLEET_DEMO_HISTORY is set', (t) => {
  const path = process.env.FLEET_DEMO_HISTORY;
  if (!path || !existsSync(path)) return t.skip('FLEET_DEMO_HISTORY not set');
  const runs = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(runs.length > 0);
  for (const run of runs) roundTrip(run, 'external');
});
