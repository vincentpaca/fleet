// Export-only helpers for the infra-unit tests. `node --test` collects every
// file under test/, so nothing here may run at import time.

/**
 * The `{ ... }` block starting at `open` (the index of its `{`).
 *
 * Braces inside string literals are counted like any other, which is fine for
 * the `.tf` blocks these tests read (every literal in them is brace-balanced)
 * and loud rather than silent when it is not: an unbalanced literal throws
 * here instead of quietly truncating the block.
 */
export function braceBlock(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error('unterminated block');
}
