/**
 * Harness authentication-failure recognition (#205).
 *
 * A job whose credential expired mid-flight used to die as a cryptic
 * cancelled(harness-exit); the runner now recognizes the harness's own auth
 * complaints and parks the job behind a decision instead, so the transcript
 * says "credential" rather than "exit 1".
 *
 * The signature set is deliberately conservative — each string is one the
 * claude CLI itself emits on a dead credential, not a guess:
 *
 * - "Invalid API key" — headless claude's refusal when ANTHROPIC_API_KEY is
 *   wrong or no credential exists; printed as the plain line
 *   "Invalid API key · Please run /login".
 * - "Please run /login" — the second half of the same line, and the CLI's
 *   generic re-auth instruction when a seat session is gone.
 * - "OAuth token has expired" — the API's message when a
 *   CLAUDE_CODE_OAUTH_TOKEN (or seat session) has aged out; surfaces both as
 *   plain output and inside relayed API error bodies.
 * - "OAuth token revoked" — same channel, revocation instead of expiry.
 * - "authentication_error" — the Anthropic API's error `type` on every 401;
 *   headless claude relays these bodies verbatim ("API Error: 401 {...}").
 *
 * Scope is as narrow as the match: only harness-authored channels are ever
 * scanned — plain (non-stream) stdout lines, the error text of a failed
 * `result` record, and stderr. Assistant/tool content is deliberately NOT
 * scanned: a job whose *work* involves these strings (this repo included)
 * must not be mistaken for a job whose credential died. And a match alone
 * never parks anything — the runner acts on it only when the harness also
 * exits nonzero.
 */
import type { Translated } from './translate.ts';

export const AUTH_FAILURE_SIGNATURES = [ // contract pin: test-only export, asserted by the suite
  'Invalid API key',
  'Please run /login',
  'OAuth token has expired',
  'OAuth token revoked',
  'authentication_error',
];

/** Longest evidence line worth carrying into a decision note. */
const MAX_EVIDENCE = 200;

/**
 * The first line of `text` carrying an auth-failure signature, clipped —
 * evidence for the decision note — or undefined when nothing matches.
 */
export function authFailureIn(text: string): string | undefined {
  for (const signature of AUTH_FAILURE_SIGNATURES) {
    const at = text.indexOf(signature);
    if (at === -1) continue;
    const start = text.lastIndexOf('\n', at) + 1;
    const rawEnd = text.indexOf('\n', at);
    const line = text.slice(start, rawEnd === -1 ? undefined : rawEnd).trim();
    return line.length > MAX_EVIDENCE ? `${line.slice(0, MAX_EVIDENCE)}…` : line;
  }
  return undefined;
}

/**
 * Auth-failure evidence in one translated stream line, scanning only the
 * harness-authored channels named above. Runs per line while the harness
 * streams; the runner keeps the first hit.
 */
export function authFailureFrom(items: Translated[]): string | undefined {
  for (const item of items) {
    // `log` without `who` is the harness's own plain (non-stream) output —
    // the channel startup auth errors arrive on. Attributed logs (assistant,
    // tool, harness notices) are job content and are never scanned.
    if (item.type === 'log' && item.who === undefined) {
      const hit = authFailureIn(item.text);
      if (hit !== undefined) return hit;
    }
    if (item.type === 'result' && item.payload.is_error === true && typeof item.payload.result === 'string') {
      const hit = authFailureIn(item.payload.result);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}
