/**
 * Shared assertions for translator replay tests. Export-only: `node --test`
 * collects every file under `test/`, so a helper with top-level effects runs
 * as a test file (we shipped that bug once).
 *
 * Both replay corpora — the in-repo calibration corpus and the captured real
 * stream — check the same property with the same detector. Two detectors for
 * one property drift, and the drift hides the leak.
 */

import type { Translated } from '../src/runner/translate.ts';

/** Narrow away the `result` marker so `.text` is reachable. */
export function isTextEvent(event: Translated): event is Exclude<Translated, { type: 'result' }> {
  return event.type !== 'result';
}

/**
 * A passthrough line is one whose text IS a serialized stream record — the raw
 * single-line JSON dump an operator sees when the translator fails open (#50).
 *
 * The check is on the WHOLE event text: a tool_result whose *output* happens to
 * be JSON is legitimate content, and arrives prefixed by `tool_result <id>: `.
 */
export function isPassthrough(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/** Label a source line by its shape — how a corpus snapshot indexes it. */
export function shapeOf(line: string): string {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return 'non-object';
    const rec = parsed as Record<string, unknown>;
    const type = typeof rec.type === 'string' ? rec.type : '?';
    return typeof rec.subtype === 'string' ? `${type}/${rec.subtype}` : type;
  } catch {
    return 'non-json';
  }
}
