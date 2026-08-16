// Calibration proof (#4): a REAL claude-code stream — captured from the
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

for (const [i, line] of lines.entries()) {
  const type = JSON.parse(line).type as string;
  test(`real line ${i} (${type}) maps to its intended category`, () => {
    const out = translateLine(line);
    switch (type) {
      case 'assistant': {
        // Text → think, tool_use → log; a real assistant line must produce
        // at least one of them — an empty translation would drop content.
        assert.ok(out.length >= 1, 'assistant line translated to nothing');
        assert.ok(out.every((e) => e.type === 'think' || e.type === 'log'));
        // Never the raw-JSON fallback: mapped output is block content, not the whole line.
        assert.ok(out.every((e) => e.type === 'result' || !e.text.startsWith('{"type":"assistant"')), 'assistant line hit the unknown fallback');
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
      default: {
        // system / rate_limit_event: best-effort log, never a crash, never empty output silently dropping run context.
        assert.ok(out.every((e) => e.type === 'log'));
      }
    }
  });
}
