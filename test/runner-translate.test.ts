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

// ---------------------------------------------------------------------------
// #50: the default path fails CLOSED. Every claude-code release adds stream
// types; a default branch that forwarded the payload made raw-JSON floods
// inevitable. These are the properties that make a leak impossible rather
// than merely absent from today's fixtures.
// ---------------------------------------------------------------------------

/** Deterministic PRNG — a property test that cannot be re-run is not evidence. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

/** Marker carrying non-identifier characters: cannot survive tag sanitization. */
const MARKER = 'LEAK/9f3!';
/** Marker that IS identifier-safe: only safe because it lives in the payload. */
const SAFE_MARKER = 'LEAK_9f3';

/** Build an arbitrary nested payload with markers buried throughout. */
function payload(rand: () => number, depth: number): unknown {
  if (depth <= 0) {
    const pick = Math.floor(rand() * 5);
    if (pick === 0) return `${MARKER} ${SAFE_MARKER} some prose`;
    if (pick === 1) return `${SAFE_MARKER.repeat(300)}`;
    if (pick === 2) return Math.floor(rand() * 1e9);
    if (pick === 3) return rand() < 0.5;
    return null;
  }
  if (rand() < 0.4) {
    return Array.from({ length: 1 + Math.floor(rand() * 4) }, () => payload(rand, depth - 1));
  }
  const obj: Record<string, unknown> = {};
  for (const key of ['message', 'content', `k_${SAFE_MARKER}`, 'partial_output', 'data', 'text']) {
    if (rand() < 0.7) obj[key] = payload(rand, depth - 1);
  }
  return obj;
}

const UNKNOWN_TYPES = [
  'tool_progress_v2', 'task_escalated', 'compaction', 'stream_event',
  'rate_limit_event', 'checkpoint_saved', 'permission_request',
  // Adversarial `type` values: payload text, control chars, absurd length.
  `${MARKER} not a shape name`, 'a\nb', 'x'.repeat(5000), '', '{"type":"system"}',
];

test('unknown records render to nothing or a bounded tag, never the payload', () => {
  const rand = rng(20260822);
  for (let i = 0; i < 600; i++) {
    const type = UNKNOWN_TYPES[i % UNKNOWN_TYPES.length];
    const record: Record<string, unknown> = { type, ...(payload(rand, 3) as object) };
    if (rand() < 0.5) record.subtype = rand() < 0.5 ? `sub_${i}` : `${MARKER}${i}`;
    // The payload markers go in on top, so no random omission can hide them.
    record.leaked = `${MARKER} ${SAFE_MARKER}`;
    record.nested = { deep: { deeper: [`${MARKER}`, SAFE_MARKER] } };
    const line = JSON.stringify(record);

    const out = translateLine(line);
    assert.ok(out.length <= 1, `unknown record fanned out to ${out.length} events: ${line.slice(0, 120)}`);
    for (const event of out) {
      assert.equal(event.type, 'log', 'an unknown record must never become a think or a result');
      const text = event.text;
      // Anti-leak: about the PAYLOAD, not about leading characters.
      assert.ok(!text.includes(MARKER), `leaked marker: ${text}`);
      assert.ok(!text.includes(SAFE_MARKER), `leaked payload token: ${text}`);
      assert.ok(!text.includes('partial_output'), `leaked a payload key: ${text}`);
      // Bounded: a shape tag, at most `<type>(<subtype>)` with 40-char parts.
      assert.ok(text.length <= 83, `unbounded tag (${text.length} chars): ${text}`);
      assert.doesNotMatch(text, /[\n\r\t]/, `tag carried control characters: ${JSON.stringify(text)}`);
      assert.doesNotMatch(text, /[{}"[\]]/, `tag carried JSON punctuation: ${text}`);
    }
  }
});

test('the tag names the shape, so a new CLI type is visible but silent', () => {
  assert.deepEqual(translateLine('{"type":"compaction","tokens_freed":9001}'), [
    { type: 'log', text: 'compaction' },
  ]);
  assert.deepEqual(translateLine('{"type":"system","subtype":"quota_warning","detail":"long prose"}'), [
    { type: 'log', text: 'system(quota_warning)' },
  ]);
});

test('known harness noise is dropped at both nesting levels', () => {
  for (const name of [
    'tool_progress', 'task_started', 'task_updated', 'task_completed',
    'task_notification', 'background_tasks_changed', 'stream_event',
  ]) {
    assert.deepEqual(
      translateLine(JSON.stringify({ type: 'system', subtype: name, partial_output: 'x'.repeat(600) })),
      [],
      `system/${name} must be dropped`,
    );
    assert.deepEqual(
      translateLine(JSON.stringify({ type: name, partial_output: 'x'.repeat(600) })),
      [],
      `top-level ${name} must be dropped`,
    );
  }
});

test('tool_use renders the primary argument, clipped and single-line', () => {
  const out = translateLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {
      command: `npm test\n${'y'.repeat(900)}`, description: 'Run the suite', timeout: 600000,
    } }] },
  }));
  assert.equal(out.length, 1);
  const text = textOf(out[0]);
  assert.match(text, /^tool_use Bash: npm test ⏎ yyy/);
  assert.ok(text.length < 260, `tool_use line was ${text.length} chars`);
  assert.doesNotMatch(text, /\n/);
  assert.doesNotMatch(text, /timeout|600000/, 'secondary args are not evidence');
});

test('tool_use with no string argument still names the tool', () => {
  const out = translateLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: {} }] },
  }));
  assert.deepEqual(out, [{ type: 'log', text: 'tool_use TodoWrite', who: 'assistant' }]);
});

test('tool_result keeps the first meaningful line and counts the rest', () => {
  const out = translateLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: '\n\n# fail 1\nfoo\nbar' }] },
  }));
  assert.deepEqual(out, [{ type: 'log', text: 'tool_result toolu_9: # fail 1 (+2 lines)', who: 'tool' }]);
});

test('a failed tool_result is loud: several lines, wider budget', () => {
  const out = translateLine(JSON.stringify({
    type: 'user',
    message: { content: [{
      type: 'tool_result', tool_use_id: 'toolu_9', is_error: true,
      content: 'Error: boom\n  at a()\n  at b()\n  at c()\n  at d()\n  at e()',
    }] },
  }));
  const text = textOf(out[0]);
  assert.match(text, /^tool_result toolu_9 ERROR: Error: boom \/ at a\(\)/);
  assert.match(text, /\(\+1 line\)$/);
});

test('a tool_result image block is named, never serialized', () => {
  const out = translateLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: [
      { type: 'text', text: 'Screenshot taken.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BLOB_MUST_NOT_APPEAR' } },
    ] }] },
  }));
  const text = textOf(out[0]);
  assert.match(text, /Screenshot taken\./);
  assert.doesNotMatch(text, /BLOB_MUST_NOT_APPEAR|base64/);
});

test('an interrupt echo is one short line, both content shapes', () => {
  const asBlock = translateLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  }));
  assert.deepEqual(asBlock, [
    { type: 'log', text: '[Request interrupted by user for tool use]', who: 'harness' },
  ]);
  const asString = translateLine(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `[Request interrupted]\n${'z'.repeat(900)}` },
  }));
  assert.equal(asString.length, 1);
  assert.ok(textOf(asString[0]).length < 210);
});
