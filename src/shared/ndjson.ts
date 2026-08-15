/** Parse newline-delimited JSON: one JSON value per non-empty line. */
export function parseNdjson(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    values.push(JSON.parse(trimmed));
  }
  return values;
}
