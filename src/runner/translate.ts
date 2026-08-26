/**
 * Claude Code stream-json → Fleet event translation.
 *
 * Pure function over lines; never throws.
 *
 * **This translator fails closed.** Every claude-code release adds stream
 * types, so a default branch that forwards the payload guarantees the log
 * fills with raw JSON dumps (#50). The unknown path therefore takes only the
 * record's `type`/`subtype` — never the record — and renders a bounded tag.
 * Leaking a payload is impossible by construction, not by string-filtering.
 *
 * Mapping (the stream contract, recalibrated against the 2026-08 CLI):
 * - assistant text block            → think
 * - assistant thinking block        → think (text only, signature dropped)
 * - assistant tool_use block        → log, `tool_use <name>: <primary arg>`
 * - user tool_result block          → log, first meaningful line; errors loud
 * - user text block                 → log, one clipped line (interrupt echoes)
 * - result line                     → pre-settle marker (not an event itself)
 * - system/init                     → terse log (harness session started model=<m>)
 * - known harness noise (see DROPPED) → dropped
 * - top-level thinking event        → think (text only, signature dropped)
 * - any other JSON record           → log, bounded `<type>(<subtype>)` tag
 * - non-JSON line                   → log verbatim (harness's own plain output,
 *   e.g. a crash trace — not a structured dump, and the only trace we'd have)
 */

import {
  pickPrimaryArg,
  clipArg,
  MAX_TOOL_ARG,
  MAX_RESULT_LINE,
  MAX_RESULT_ERROR,
} from '../shared/tool-text.ts';

export type Translated = // contract pin: test-only export, asserted by the suite
  | { type: 'think'; text: string; who?: string }
  | { type: 'log'; text: string; who?: string }
  | { type: 'result'; payload: Record<string, unknown> };

const MAX_TEXT = 4000;
/** Echoes of harness-level notices (interrupts, notifications) stay short. */
const MAX_NOTICE = 200;
/** A bounded tag is a shape name, never content. */
const MAX_TAG_PART = 40;
/** Model names, tool names, tool_use_ids: identifiers, so short by nature. */
const MAX_ID = 60;

/**
 * Harness bookkeeping with zero evidence value. Matched on the record's
 * *name* — `subtype` for `system` records, `type` otherwise — because the CLI
 * has moved these between the two levels across releases.
 *
 * - `thinking_tokens`, `hook_started`, `hook_response`: original calibration (#4).
 * - `tool_progress`: a heartbeat every 30s of every long tool call. At one
 *   line per heartbeat this alone floods a job's log (#50).
 * - `task_*`, `background_tasks_changed`: background-task bookkeeping; the
 *   task's own output already arrives as tool_result.
 * - `stream_event`: an SSE delta wrapper — one per *token*. The completed
 *   message arrives again as an `assistant` record, so this is pure duplication
 *   at the highest volume of anything on the stream. A bounded tag would still
 *   be one event per token, so this one has to be dropped, not tagged.
 */
const DROPPED = new Set([
  'thinking_tokens',
  'hook_started',
  'hook_response',
  'tool_progress',
  'stream_event',
  'task_started',
  'task_updated',
  'task_completed',
  'task_notification',
  'background_tasks_changed',
]);

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Sanitize one tag component: shape names are short identifier-ish tokens, so
 * anything else is not a shape name and does not get rendered. This is what
 * makes the unknown path safe even when a record puts payload text in `type`.
 */
function tagPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const kept = value.replace(/[^A-Za-z0-9_.:-]/g, '');
  if (kept === '' || kept !== value) return null;
  return kept.length > MAX_TAG_PART ? kept.slice(0, MAX_TAG_PART) : kept;
}

/**
 * Sanitize a known identifier field we *do* intend to show — a model name, a
 * tool name, a tool_use_id. Unlike `tagPart` this clips rather than rejects,
 * because rejecting would silently blank a legitimate value: model ids carry
 * brackets (`claude-opus-5[1m]`), MCP tool names carry slashes. Bounded is the
 * requirement here; strictness is only load-bearing on the fail-closed path.
 */
function idPart(value: unknown, maxLen = MAX_ID): string | null {
  if (typeof value !== 'string') return null;
  const kept = value.replace(/[^A-Za-z0-9_.:@/[\]-]/g, '');
  if (kept === '') return null;
  return kept.length > maxLen ? kept.slice(0, maxLen) : kept;
}

/**
 * The fail-closed default. Deliberately takes the two shape fields, not the
 * record: there is no expression in this function that could reach a payload.
 */
function unknownTag(type: unknown, subtype: unknown): Translated[] {
  const t = tagPart(type) ?? 'unknown';
  const s = tagPart(subtype);
  return [{ type: 'log', text: s ? `${t}(${s})` : t }];
}

function meaningfulLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

function more(count: number): string {
  return count === 0 ? '' : ` (+${count} ${count === 1 ? 'line' : 'lines'})`;
}

/** First non-empty line of a block of text, plus a count of what was cut. */
function firstMeaningfulLine(text: string, maxLen: number): string {
  const lines = meaningfulLines(text);
  if (lines.length === 0) return '(no output)';
  const head = lines[0].length > maxLen ? `${lines[0].slice(0, maxLen)}…` : lines[0];
  return `${head}${more(lines.length - 1)}`;
}

/** Loud form: keep the first few lines — a stack trace's point is its head. */
function errorLines(text: string, maxLen: number): string {
  const lines = meaningfulLines(text);
  if (lines.length === 0) return '(no output)';
  const joined = lines.slice(0, 5).join(' / ');
  const head = joined.length > maxLen ? `${joined.slice(0, maxLen)}…` : joined;
  return `${head}${more(Math.max(0, lines.length - 5))}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Only text blocks carry readable output; image/other blocks are named,
    // not serialized — a base64 image must never reach the log.
    return content
      .map((block) => {
        const rec = asRecord(block);
        if (rec && typeof rec.text === 'string') return rec.text;
        const kind = tagPart(rec?.type) ?? 'block';
        return `(${kind})`;
      })
      .filter((line) => line !== '')
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  // Numbers/booleans are safe and tiny; objects are payload and stay out.
  return typeof content === 'object' ? '(structured content)' : String(content);
}

function renderToolUse(rec: Record<string, unknown>): Translated {
  const name = idPart(rec.name) ?? 'unknown';
  const input = asRecord(rec.input);
  const arg = input ? pickPrimaryArg(input, MAX_TOOL_ARG) : null;
  return {
    type: 'log',
    text: arg ? `tool_use ${name}: ${arg.value}` : `tool_use ${name}`,
    who: 'assistant',
  };
}

function renderToolResult(rec: Record<string, unknown>): Translated {
  const id = idPart(rec.tool_use_id) ?? '?';
  const body = toolResultText(rec.content);
  const failed = rec.is_error === true;
  const text = failed
    ? `tool_result ${id} ERROR: ${errorLines(body, MAX_RESULT_ERROR)}`
    : `tool_result ${id}: ${firstMeaningfulLine(body, MAX_RESULT_LINE)}`;
  return { type: 'log', text, who: 'tool' };
}

/**
 * Append a think event unless there is nothing to think about: an empty bubble
 * is the same exhaust this translator exists to remove.
 */
function pushThink(out: Translated[], text: string): void {
  if (text.trim() === '') return;
  out.push({ type: 'think', text: clip(text), who: 'assistant' });
}

function fromAssistant(msg: Record<string, unknown>): Translated[] {
  const message = asRecord(msg.message);
  const content = message?.content;
  if (!Array.isArray(content)) return unknownTag(msg.type, msg.subtype);
  const out: Translated[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      pushThink(out, rec.text);
    } else if (rec.type === 'thinking') {
      // Extended thinking block: keep text, drop signature blob.
      pushThink(out, typeof rec.thinking === 'string' ? rec.thinking : '');
    } else if (rec.type === 'tool_use') {
      out.push(renderToolUse(rec));
    } else {
      // Unknown content block: named, never serialized.
      out.push({ type: 'log', text: `assistant block(${tagPart(rec.type) ?? 'unknown'})`, who: 'assistant' });
    }
  }
  return out;
}

function fromUser(msg: Record<string, unknown>): Translated[] {
  const message = asRecord(msg.message);
  const content = message?.content;
  if (typeof content === 'string') {
    // Whole-message string form: the interrupt echo arrives this way.
    return [{ type: 'log', text: clipArg(content, MAX_NOTICE), who: 'harness' }];
  }
  if (!Array.isArray(content)) return unknownTag(msg.type, msg.subtype);
  const out: Translated[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === 'tool_result') {
      out.push(renderToolResult(rec));
    } else if (rec.type === 'text' && typeof rec.text === 'string') {
      // Harness-injected notice — interrupt echoes, system reminders. One line.
      out.push({ type: 'log', text: clipArg(rec.text, MAX_NOTICE), who: 'harness' });
    } else {
      out.push({ type: 'log', text: `user block(${tagPart(rec.type) ?? 'unknown'})`, who: 'harness' });
    }
  }
  // A user line we recognized nothing in is still worth its shape tag.
  if (out.length === 0) return unknownTag(msg.type, msg.subtype);
  return out;
}

function fromSystem(msg: Record<string, unknown>): Translated[] {
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
  if (subtype === 'init') {
    // One terse line — model name useful, UUIDs/paths are not.
    const model = idPart(msg.model) ?? 'unknown';
    return [{ type: 'log', text: `harness session started model=${model}` }];
  }
  return unknownTag(msg.type, msg.subtype);
}

/** Dispatch a parsed message record by type. */
function dispatchMsg(msg: Record<string, unknown>): Translated[] {
  switch (msg.type) {
    case 'assistant': return fromAssistant(msg);
    case 'user': return fromUser(msg);
    case 'system': return fromSystem(msg);
    case 'thinking': {
      // Top-level thinking event: keep text, drop signature blob.
      const out: Translated[] = [];
      pushThink(out, typeof msg.thinking === 'string' ? msg.thinking : '');
      return out;
    }
    case 'result': return [{ type: 'result', payload: msg }];
    default: return unknownTag(msg.type, msg.subtype);
  }
}

/** Filter known noise then dispatch. */
function filterAndDispatch(msg: Record<string, unknown>): Translated[] {
  // Known noise, checked before dispatch: the CLI has moved these between
  // top-level `type` and `system.subtype` across releases.
  const name = msg.type === 'system' ? msg.subtype : msg.type;
  if (typeof name === 'string' && DROPPED.has(name)) return [];
  return dispatchMsg(msg);
}

/** Translate one stream line into zero or more event bodies. Never throws. */
export function translateLine(line: string): Translated[] {
  const raw = line.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not a stream record at all: the harness's own plain output. Keeping it
    // is how a crash trace survives; it is not a structured payload dump.
    return [{ type: 'log', text: clip(raw) }];
  }
  const msg = asRecord(parsed);
  if (!msg) return unknownTag(undefined, undefined);
  return filterAndDispatch(msg);
}
