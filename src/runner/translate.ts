/**
 * Claude Code stream-json → Fleet event translation.
 *
 * Pure function over lines; never throws. Mapping (per the Phase 1 contract):
 * - assistant text block            → think
 * - assistant thinking block        → think (text only, signature dropped)
 * - assistant tool_use block        → log
 * - user tool_result block          → log
 * - result line                     → pre-settle marker (not an event itself)
 * - system/init                     → terse log (harness session started model=<m>)
 * - system/thinking_tokens          → dropped (noise, never a crash)
 * - system/hook_started             → dropped (zero evidence value)
 * - system/hook_response            → dropped (zero evidence value)
 * - top-level thinking event        → think (text only, signature dropped)
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
    } else if (rec.type === 'thinking') {
      // Extended thinking block: keep text, drop signature blob.
      const text = typeof rec.thinking === 'string' ? rec.thinking : '';
      out.push({ type: 'think', text: clip(text), who: 'assistant' });
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

function fromSystem(msg: Record<string, unknown>, raw: string): Translated[] {
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
  switch (subtype) {
    // Pure noise: harness bookkeeping with no evidence value.
    case 'thinking_tokens':
    case 'hook_started':
    case 'hook_response':
      return [];
    case 'init': {
      // One terse line — model name useful, UUIDs/paths are not.
      const model = typeof msg.model === 'string' ? msg.model : 'unknown';
      return [{ type: 'log', text: `harness session started model=${model}` }];
    }
    default:
      // Unknown system subtype: best-effort log, never a crash.
      return [{ type: 'log', text: clip(raw) }];
  }
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
    case 'system':
      return fromSystem(msg, raw);
    case 'thinking': {
      // Top-level thinking event: keep text, drop signature blob.
      const text = typeof msg.thinking === 'string' ? msg.thinking : '';
      return [{ type: 'think', text: clip(text), who: 'assistant' }];
    }
    case 'result':
      return [{ type: 'result', payload: msg }];
    default:
      return [{ type: 'log', text: clip(raw) }];
  }
}
