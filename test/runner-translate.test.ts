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

  // 1. system/init → terse log (not raw JSON, just the model name)
  assert.deepEqual(perLine[0].map((t) => t.type), ['log']);
  assert.match(textOf(perLine[0][0]), /harness session started model=generic-model/);

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

test('system/init produces a terse log without UUIDs or paths', () => {
  const line = JSON.stringify({
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-6',
    cwd: '/workspace/sensitive',
    session_id: '00000000-0000-0000-0000-000000000000',
    tools: ['Read', 'Write'],
  });
  const out = translateLine(line);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'log');
  assert.match(out[0].text, /harness session started model=claude-sonnet-4-6/);
  assert.doesNotMatch(out[0].text, /00000000|sensitive|cwd/);
});

test('system/thinking_tokens, hook_started, hook_response are dropped', () => {
  for (const subtype of ['thinking_tokens', 'hook_started', 'hook_response']) {
    const line = JSON.stringify({ type: 'system', subtype, uuid: 'some-uuid', session_id: 'sid' });
    const out = translateLine(line);
    assert.deepEqual(out, [], `${subtype} must be dropped`);
  }
});

test('assistant thinking block → think event without signature', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'Reasoning about the problem.', signature: 'BLOB_THAT_MUST_NOT_APPEAR' },
      ],
    },
  });
  const out = translateLine(line);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'think');
  assert.match(out[0].text, /Reasoning about the problem/);
  assert.doesNotMatch(out[0].text, /BLOB_THAT_MUST_NOT_APPEAR/);
  assert.doesNotMatch(out[0].text, /signature/);
});

test('assistant mixed thinking + tool_use → think then log', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'First I will read.', signature: 'SIG' },
        { type: 'tool_use', id: 'toolu_99', name: 'Read', input: { file_path: '/src/main.ts' } },
      ],
    },
  });
  const out = translateLine(line);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'think');
  assert.match(out[0].text, /First I will read/);
  assert.equal(out[1].type, 'log');
  assert.match(out[1].text, /tool_use Read/);
});

test('top-level thinking event → think event without signature', () => {
  const line = JSON.stringify({
    type: 'thinking',
    thinking: 'Extended reasoning text here.',
    signature: 'BLOB_MUST_NOT_APPEAR',
  });
  const out = translateLine(line);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'think');
  assert.match(out[0].text, /Extended reasoning text/);
  assert.doesNotMatch(out[0].text, /BLOB_MUST_NOT_APPEAR/);
});
