/**
 * Claude Code stream-json → Fleet event translation.
 *
 * Pure function over lines; never throws. Mapping (per the Phase 1 contract):
 * - assistant text block            → think
 * - assistant tool_use block        → log
 * - user tool_result block          → log
 * - result line                     → pre-settle marker (not an event itself)
 * - anything else (incl. non-JSON)  → log, best effort
 */

export type Translated =
  | { type: 'think'; text: string; who?: string }
  | { type: 'log'; text: string; who?: string }
  | { type: 'result'; payload: Record<string, unknown> };

const MAX_TEXT = 4000;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function renderToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const rec = asRecord(block);
        if (rec && typeof rec.text === 'string') return rec.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

function fromAssistant(msg: Record<string, unknown>, raw: string): Translated[] {
  const message = asRecord(msg.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [{ type: 'log', text: clip(raw) }];
  const out: Translated[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      out.push({ type: 'think', text: clip(rec.text), who: 'assistant' });
    } else if (rec.type === 'tool_use') {
      const name = typeof rec.name === 'string' ? rec.name : 'unknown';
      out.push({
        type: 'log',
        text: clip(`tool_use ${name}: ${JSON.stringify(rec.input ?? {})}`),
        who: 'assistant',
      });
    } else {
      out.push({ type: 'log', text: clip(JSON.stringify(block)), who: 'assistant' });
    }
  }
  return out;
}

function fromUser(msg: Record<string, unknown>, raw: string): Translated[] {
  const message = asRecord(msg.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [{ type: 'log', text: clip(raw) }];
  const out: Translated[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec?.type === 'tool_result') {
      const id = typeof rec.tool_use_id === 'string' ? rec.tool_use_id : '?';
      out.push({
        type: 'log',
        text: clip(`tool_result ${id}: ${renderToolResultContent(rec.content)}`),
        who: 'tool',
      });
    }
  }
  // A user line with no tool_result blocks is still worth a trace.
  if (out.length === 0) out.push({ type: 'log', text: clip(raw) });
  return out;
}

/** Translate one stream line into zero or more event bodies. Never throws. */
export function translateLine(line: string): Translated[] {
  const raw = line.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [{ type: 'log', text: clip(raw) }];
  }
  const msg = asRecord(parsed);
  if (!msg) return [{ type: 'log', text: clip(raw) }];
  switch (msg.type) {
    case 'assistant':
      return fromAssistant(msg, raw);
    case 'user':
      return fromUser(msg, raw);
    case 'result':
      return [{ type: 'result', payload: msg }];
    default:
      return [{ type: 'log', text: clip(raw) }];
  }
}
