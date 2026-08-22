// Calibration proof (#4 / #32): a REAL claude-code stream — captured from the
// first fleet-delegated job on this repo, sanitized — replays through the
// translator with every known type mapped to its intended category, never
// the generic unknown fallback, and never a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translateLine } from '../src/runner/translate.ts';
import { isPassthrough, isTextEvent } from './translate-helpers.ts';

const lines = readFileSync(new URL('./fixtures/claude-stream-real.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n');

test('the fixture is a real spread of stream types', () => {
  const types = new Set(lines.map((l) => JSON.parse(l).type));
  for (const required of ['system', 'assistant', 'user', 'result']) {
    assert.ok(types.has(required), `fixture lost its ${required} lines`);
  }
});

test('zero raw-JSON log lines from the fixture', () => {
  // One detector for this property, shared with the calibration corpus (#50).
  const rawJsonLogs = lines
    .flatMap((l) => translateLine(l))
    .filter(isTextEvent)
    .filter((e) => isPassthrough(e.text));
  assert.equal(
    rawJsonLogs.length,
    0,
    `expected zero raw-JSON harness-system log lines; got: ${JSON.stringify(rawJsonLogs)}`,
  );
});

for (const [i, line] of lines.entries()) {
  const parsed = JSON.parse(line) as { type: string; subtype?: string };
  const { type, subtype } = parsed;
  const label = subtype ? `${type}/${subtype}` : type;

  test(`real line ${i} (${label}) maps to its intended category`, () => {
    const out = translateLine(line);
    switch (type) {
      case 'assistant': {
        // Text block → think, thinking block → think, tool_use → log;
        // a real assistant line must produce at least one event.
        assert.ok(out.length >= 1, 'assistant line translated to nothing');
        assert.ok(out.every((e) => e.type === 'think' || e.type === 'log'));
        // Never the raw-JSON fallback: mapped output is block content, not the whole line.
        assert.ok(
          out.filter(isTextEvent).every((e) => !e.text.startsWith('{"type":"assistant"')),
          'assistant line hit the unknown fallback',
        );
        break;
      }
      case 'user': {
        assert.ok(out.every((e) => e.type === 'log'));
        break;
      }
      case 'result': {
        assert.deepStrictEqual(out.map((e) => e.type), ['result'], 'result must become the pre-settle marker only');
        break;
      }
      case 'system': {
        switch (subtype) {
          case 'thinking_tokens':
          case 'hook_started':
          case 'hook_response':
            // Noise: must be dropped entirely.
            assert.deepStrictEqual(out, [], `${label} must be dropped, got ${JSON.stringify(out)}`);
            break;
          case 'init': {
            // Tersed: one log line, no UUIDs.
            assert.equal(out.length, 1, `system/init must produce exactly one log`);
            const [init] = out;
            assert.ok(isTextEvent(init) && init.type === 'log');
            assert.match(init.text, /harness session started model=/);
            assert.doesNotMatch(init.text, /session_id|uuid/i, 'system/init log must not contain UUIDs');
            break;
          }
          default:
            // Unknown system subtype: best-effort log, never a crash.
            assert.ok(out.every((e) => e.type === 'log'));
        }
        break;
      }
      default: {
        // rate_limit_event and any future unknowns: best-effort log, never empty.
        assert.ok(out.length >= 1, `${label} produced no output`);
        assert.ok(out.every((e) => e.type === 'log'));
      }
    }
  });
}
