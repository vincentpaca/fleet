/**
 * Deterministic JSON: object keys sorted at every depth, so two values that
 * differ only in insertion order serialise identically and can be compared as
 * strings. Used by event intake's dedup-by-content check (issue #113).
 *
 * Not `JSON.stringify(value, Object.keys(value).sort())`. An array as the second
 * argument is a *property allowlist applied recursively*, not a key sort: every
 * nested field whose key does not also appear at the top level is erased from
 * the output. Two events differing only inside `report` come out equal, which
 * for a dedup check means the second one is silently dropped.
 *
 * `undefined` properties are omitted, matching JSON.stringify. Cycles throw,
 * also matching JSON.stringify — callers pass parsed JSON, which cannot have any.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
