/**
 * Fleet event formatting for the CLI renderer (fleet logs / fleet attach).
 *
 * Split from main.ts so tests can import without triggering the CLI entry point.
 */

export type FleetEvent = {
  seq: number;
  type: string;
  state?: string;
  reason?: string;
  marker?: string;
  text?: string;
  value?: number;
  id?: string;
  question?: string;
  options?: Array<{ id: string; label?: string; recommended?: boolean }>;
  decision?: string;
  option?: string;
  by?: string;
  rung?: string;
  minutes?: number;
  report?: { status?: string; next_action?: string };
};

// ANSI helpers — gated on noColor. Stdout pipe ⇒ no TTY ⇒ no color.
const RESET = '\x1b[0m';
function ansiCode(...codes: number[]): string {
  return `\x1b[${codes.join(';')}m`;
}
function makeStyledText(noColor: boolean): (text: string, ...codes: number[]) => string {
  return (text, ...codes) => (noColor ? text : `${ansiCode(...codes)}${text}${RESET}`);
}

/**
 * Detect whether color output should be suppressed: NO_COLOR env var, non-TTY
 * stdout, or TERM=dumb all disable color. Accepts an env map so tests can
 * inject overrides without touching process.env.
 */
export function logsNoColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  return !isTTY || env.NO_COLOR !== undefined || env.TERM === 'dumb';
}

/**
 * Parse a log event's text for tool_use and tool_result prefixes and return a
 * compact one-liner. Falls back to returning the text unchanged.
 *
 * tool_use Read: {"file_path":"/p"} → tool_use Read file_path=/p
 * tool_result toolu_01: <body>      → tool_result toolu_01 (N bytes)
 */
export function formatLogText(text: string): string {
  if (text.startsWith('tool_use ')) {
    // Format: "tool_use <Name>: <json-input>"
    const colonIdx = text.indexOf(': ');
    if (colonIdx !== -1) {
      const namepart = text.slice('tool_use '.length, colonIdx); // e.g. "Read"
      const jsonPart = text.slice(colonIdx + 2);
      try {
        const input = JSON.parse(jsonPart) as Record<string, unknown>;
        // Pick first meaningful arg: command, file_path, pattern, path, url, then any first key.
        const PRIORITY = ['command', 'file_path', 'pattern', 'path', 'url'];
        let arg = '';
        for (const key of PRIORITY) {
          if (typeof input[key] === 'string') {
            const val = (input[key] as string).slice(0, 120);
            arg = `${key}=${val}`;
            break;
          }
        }
        if (!arg) {
          const firstKey = Object.keys(input)[0];
          if (firstKey !== undefined) {
            const val = String(input[firstKey]).slice(0, 120);
            arg = `${firstKey}=${val}`;
          }
        }
        return arg ? `tool_use ${namepart} ${arg}` : `tool_use ${namepart}`;
      } catch {
        // Not valid JSON — fall through to raw text.
      }
    }
  } else if (text.startsWith('tool_result ')) {
    // Format: "tool_result <id>: <body>"
    const colonIdx = text.indexOf(': ');
    if (colonIdx !== -1) {
      const idpart = text.slice('tool_result '.length, colonIdx);
      const body = text.slice(colonIdx + 2);
      return `tool_result ${idpart} (${body.length} bytes)`;
    }
  }
  return text;
}

/**
 * Return true when the event belongs in the narrative spine (default logs view).
 * Narrative = state, phase, think, decision, answer, settle + log lines that are
 * NOT tool_use/tool_result. With tools=true, tool lines are included too.
 * progress/pair/agent are always omitted — they're operational noise.
 */
export function isNarrativeEvent(event: FleetEvent, tools: boolean): boolean {
  if (event.type === 'progress' || event.type === 'pair' || event.type === 'agent') return false;
  if (event.type === 'log') {
    const text = event.text ?? '';
    const isToolLine = text.startsWith('tool_use ') || text.startsWith('tool_result ');
    return tools || !isToolLine;
  }
  return true;
}

/**
 * State with its qualifier for job listings: the marker on blocked
 * (parked/stale), the cancellation reason on cancelled — `cancelled(stall)`
 * reads differently from `cancelled(wall-clock)`, and that difference is the
 * whole diagnosis. Shared by `fleet status` and the board.
 */
export function formatJobState(job: { state: string; marker?: string; reason?: string }): string {
  const qualifier = job.marker ?? (job.state === 'cancelled' ? job.reason : undefined);
  return typeof qualifier === 'string' && qualifier !== '' ? `${job.state}(${qualifier})` : job.state;
}

/** Format one persisted Fleet event for human display. Never throws. */
export function formatEvent(event: FleetEvent, noColor: boolean): string {
  const col = makeStyledText(noColor);
  const head = `[${event.seq}] ${event.type}`;
  switch (event.type) {
    case 'state': {
      const extras = [event.reason && `reason=${event.reason}`, event.marker && `marker=${event.marker}`]
        .filter(Boolean)
        .join(' ');
      const body = `→ ${event.state}${extras ? ` ${extras}` : ''}`;
      return col(`${head} ${body}`, 1); // bold
    }
    case 'phase':
      return `${head} ${event.text ?? ''}`;
    case 'think':
      return col(`${head} ${event.text ?? ''}`, 2); // dim
    case 'log':
      return `${head} ${formatLogText(event.text ?? '')}`;
    case 'progress':
      return `${head} ${Math.round((event.value ?? 0) * 100)}%`;
    case 'decision': {
      const options = (event.options ?? [])
        .map((o) => `  - ${o.id}${o.recommended ? ' (recommended)' : ''}${o.label ? `: ${o.label}` : ''}`)
        .join('\n');
      const body = `${head} ${event.id}: ${event.question}\n${options}\n  answer with: fleet answer <jobId> --option <id> [--text s]`;
      return col(body, 33); // yellow
    }
    case 'answer':
      return `${head} ${event.decision} → ${event.option ?? '(free text)'}${event.text ? ` "${event.text}"` : ''}${event.by ? ` by ${event.by}` : ''}`;
    case 'settle': {
      const status = event.report?.status ?? '?';
      const body = `${head} rung=${event.rung ?? '?'} status=${status}${event.report?.next_action ? ` next: ${event.report.next_action}` : ''}`;
      // Green for success (READY), red for failure (PARTIAL/FAILED/etc.).
      const code = status === 'READY' ? 32 : 31;
      return col(body, code);
    }
    default:
      return `${head} ${JSON.stringify({ ...event, seq: undefined, type: undefined })}`;
  }
}
