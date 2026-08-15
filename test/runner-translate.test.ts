import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translateLine } from '../src/runner/translate.ts';
import type { Translated } from '../src/runner/translate.ts';

const fixturePath = fileURLToPath(
  new URL('./fixtures/harness-stream.ndjson', import.meta.url),
);
const lines = readFileSync(fixturePath, 'utf8').split('\n');

/** Narrow to a text-bearing event or fail the test. */
function textOf(translated: Translated): string {
  if (translated.type === 'result') {
    assert.fail('expected a think/log event, got a result marker');
  }
  return translated.text;
}

test('fixture translates to the contract mapping, line by line', () => {
  const perLine = lines
    .filter((line) => line.trim() !== '')
    .map((line) => translateLine(line));

  assert.equal(perLine.length, 9);

  // 1. system init line: unknown type → log
  assert.deepEqual(perLine[0].map((t) => t.type), ['log']);

  // 2. assistant text → think
  assert.deepEqual(perLine[1].map((t) => t.type), ['think']);
  assert.match(textOf(perLine[1][0]), /Planning the change/);

  // 3. assistant tool_use → log naming the tool
  assert.deepEqual(perLine[2].map((t) => t.type), ['log']);
  assert.match(textOf(perLine[2][0]), /tool_use Read/);

  // 4. user tool_result → log carrying the result content
  assert.deepEqual(perLine[3].map((t) => t.type), ['log']);
  assert.match(textOf(perLine[3][0]), /tool_result toolu_01/);
  assert.match(textOf(perLine[3][0]), /hello from example\.com/);

  // 5. mixed assistant message → think + log, in block order
  assert.deepEqual(perLine[4].map((t) => t.type), ['think', 'log']);
  assert.match(textOf(perLine[4][1]), /tool_use Write/);

  // 6. tool_result with plain-string content → log
  assert.deepEqual(perLine[5].map((t) => t.type), ['log']);
  assert.match(textOf(perLine[5][0]), /tool_result toolu_02: ok/);

  // 7. unknown structured line → log, never crash
  assert.deepEqual(perLine[6].map((t) => t.type), ['log']);
  assert.match(textOf(perLine[6][0]), /mystery/);

  // 8. non-JSON garbage → log verbatim
  assert.deepEqual(perLine[7].map((t) => t.type), ['log']);
  assert.equal(textOf(perLine[7][0]), 'this line is not json at all');

  // 9. result line → pre-settle marker, not an event
  assert.deepEqual(perLine[8].map((t) => t.type), ['result']);
  const marker = perLine[8][0];
  assert.ok(marker.type === 'result');
  assert.equal(marker.payload.subtype, 'success');
});

test('empty and whitespace lines translate to nothing', () => {
  assert.deepEqual(translateLine(''), []);
  assert.deepEqual(translateLine('   '), []);
});

test('malformed shapes degrade to log without throwing', () => {
  for (const line of [
    '{"type":"assistant"}',
    '{"type":"assistant","message":{"content":"not-an-array"}}',
    '{"type":"user","message":{}}',
    'null',
    '42',
    '[1,2,3]',
  ]) {
    const out = translateLine(line);
    assert.ok(out.length >= 1, `expected output for: ${line}`);
    assert.ok(out.every((t) => t.type === 'log'), `expected logs for: ${line}`);
  }
});

test('oversized text is clipped, not dropped', () => {
  const big = 'x'.repeat(10000);
  const out = translateLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: big }] } }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'think');
  const text = textOf(out[0]);
  assert.ok(text.length < 5000);
  assert.ok(text.startsWith('xxx'));
});
