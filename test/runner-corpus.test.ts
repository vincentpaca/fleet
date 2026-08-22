/**
 * Calibration corpus (#50). The translator is only as good as the last CLI
 * release it was measured against; #4 calibrated it once and it drifted until
 * an operator called the drill-down unreadable.
 *
 * Two tiers, the same pattern as the history round-trip (`docs/decisions.md#d10`):
 *
 * 1. `fixtures/harness-corpus.ndjson` — an in-repo corpus reconstructed from
 *    the shapes reported on 2026-08-18/20, with generic content. Its rendered
 *    transcript is committed as `harness-corpus.expected.txt` and IS the
 *    contract: a CLI upgrade that adds a type shows up here as a corpus diff
 *    instead of as an unreadable live job.
 * 2. `FLEET_HARNESS_CORPUS=<path>` — a real captured stream, held outside the
 *    repo, never vendored. Replayed for the structural properties only
 *    (no passthrough, bounded lines); its content never becomes a snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translateLine } from '../src/runner/translate.ts';
import type { Translated } from '../src/runner/translate.ts';
import { isPassthrough, isTextEvent, shapeOf } from './translate-helpers.ts';

const corpusPath = fileURLToPath(new URL('./fixtures/harness-corpus.ndjson', import.meta.url));
const snapshotPath = fileURLToPath(new URL('./fixtures/harness-corpus.expected.txt', import.meta.url));

function inputLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function describe(events: Translated[]): string[] {
  if (events.length === 0) return ['(dropped)'];
  return events.map((e) =>
    isTextEvent(e) ? `${e.type}${e.who ? `[${e.who}]` : ''} ${e.text}` : 'result (pre-settle marker)',
  );
}

/** The rendered transcript, one block per source line, shape-labelled. */
function renderTranscript(lines: string[]): string {
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    const idx = String(i).padStart(2, '0');
    for (const rendered of describe(translateLine(line))) out.push(`${idx} ${shapeOf(line)} → ${rendered}`);
  }
  return `${out.join('\n')}\n`;
}

function renderedText(path: string): Array<Exclude<Translated, { type: 'result' }>> {
  return inputLines(path).flatMap((l) => translateLine(l)).filter(isTextEvent);
}

test('the in-repo corpus still covers the shapes it was built for', () => {
  const shapes = new Set(inputLines(corpusPath).map(shapeOf));
  for (const required of [
    'system/init',
    'system/tool_progress',
    'system/task_started',
    'system/task_notification',
    'system/background_tasks_changed',
    'assistant',
    'user',
    'rate_limit_event',
    'stream_event',
    'result/success',
    // The one deliberate fail-open path: the harness's own plain output.
    'non-json',
  ]) {
    assert.ok(shapes.has(required), `corpus lost its ${required} lines`);
  }
});

test('corpus replay matches the committed snapshot', () => {
  const actual = renderTranscript(inputLines(corpusPath));
  if (process.env.FLEET_UPDATE_CORPUS_SNAPSHOT === '1') {
    writeFileSync(snapshotPath, actual);
    return;
  }
  const expected = readFileSync(snapshotPath, 'utf8');
  assert.equal(
    actual,
    expected,
    'corpus rendering drifted. Review the diff — then, if intended, regenerate with FLEET_UPDATE_CORPUS_SNAPSHOT=1',
  );
});

test('corpus replay produces zero passthrough lines', () => {
  const leaks = renderedText(corpusPath).filter((e) => isPassthrough(e.text));
  assert.deepEqual(leaks, [], 'a stream record was forwarded verbatim');
});

test('corpus replay never leaks a payload blob or a heartbeat', () => {
  const text = renderedText(corpusPath).map((e) => e.text).join('\n');
  // Sentinels planted in the corpus at the places the old default branches leaked.
  for (const sentinel of [
    'SIGNATURE_BLOB_MUST_NOT_APPEAR',
    'BASE64_BLOB_MUST_NOT_APPEAR',
    'DELTA_TOKEN_MUST_NOT_APPEAR',
    'partial_output',
    'thirty seconds in',
    'session_id',
    '11111111-1111',
  ]) {
    assert.ok(!text.includes(sentinel), `corpus rendering leaked ${sentinel}`);
  }
});

test("corpus keeps the harness's own plain output, bounded", () => {
  // The deliberate exception: a non-JSON line is a crash trace or a CLI notice,
  // not a structured dump, and dropping it would leave no trace of the crash.
  const kept = renderedText(corpusPath).filter((e) => e.text.includes('claude: command not found'));
  assert.equal(kept.length, 1, 'a non-JSON harness line must survive translation');
  for (const event of renderedText(corpusPath)) {
    assert.ok(event.text.length <= 4001, `line exceeded the clip budget: ${event.text.length} chars`);
  }
});

test('external captured corpus replays clean when FLEET_HARNESS_CORPUS is set', (t) => {
  const path = process.env.FLEET_HARNESS_CORPUS;
  if (!path || !existsSync(path)) return t.skip('FLEET_HARNESS_CORPUS not set');
  assert.ok(inputLines(path).length > 0, 'external corpus is empty');
  const events = renderedText(path);
  // Report counts, not content: a real capture never becomes a snapshot.
  const leaks = events.filter((e) => isPassthrough(e.text));
  assert.equal(leaks.length, 0, `${leaks.length}/${events.length} external lines were forwarded verbatim`);
  const oversized = events.filter((e) => e.text.length > 4001);
  assert.equal(oversized.length, 0, `${oversized.length} external lines exceeded the clip budget`);
});
