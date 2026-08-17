// Calibration proof (#4 / #32): a REAL claude-code stream — captured from the
// first fleet-delegated job on this repo, sanitized — replays through the
// translator with every known type mapped to its intended category, never
// the generic unknown fallback, and never a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translateLine } from '../src/runner/translate.ts';

const lines = readFileSync(new URL('./fixtures/claude-stream-real.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n');

test('the fixture is a real spread of stream types', () => {
  const types = new Set(lines.map((l) => JSON.parse(l).type));
  for (const required of ['system', 'assistant', 'user', 'result']) {
    assert.ok(types.has(required), `fixture lost its ${required} lines`);
  }
});

test('noise reduction is measurable: fixture produces fewer events than input lines', () => {
  const total = lines.flatMap((l) => translateLine(l)).length;
  // Before this fix: 22 lines → 22 events (1:1).
  // After: thinking_tokens (×2), hook_started (×1), hook_response (×1) are dropped → 18 events.
  // Pin the count so regressions are immediately visible.
  assert.equal(total, 18, `expected 18 translated events, got ${total}`);
});

test('zero raw-JSON log lines from the fixture', () => {
  const rawJsonLogs = lines
    .flatMap((l) => translateLine(l))
    .filter((e) => {
      if (e.type !== 'log') return false;
      // A raw-JSON log is one whose text IS the original top-level event JSON (not just JSON-containing text).
      // These are the harness system events that leaked as-is before this fix.
      try {
        const parsed = JSON.parse(e.text) as Record<string, unknown>;
        // Detect by the presence of type+subtype from the harness system event shapes.
        return (
          (parsed.type === 'system' && typeof parsed.subtype === 'string') ||
          parsed.type === 'thinking'
        );
      } catch {
        return false;
      }
    });
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
          out.every((e) => e.type === 'result' || !e.text.startsWith('{"type":"assistant"')),
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
          case 'init':
            // Tersed: one log line, no UUIDs.
            assert.equal(out.length, 1, `system/init must produce exactly one log`);
            assert.equal(out[0].type, 'log');
            assert.match(out[0].text, /harness session started model=/);
            assert.doesNotMatch(out[0].text, /session_id|uuid/i, 'system/init log must not contain UUIDs');
            break;
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
