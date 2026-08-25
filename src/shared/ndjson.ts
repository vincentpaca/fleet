/**
 * Parse newline-delimited JSON: one JSON value per non-empty line.
 *
 * The final line may be truncated (a host crash mid-`appendFileSync`). Rather
 * than throwing and bricking the daemon on one bad job, a truncated trailing
 * line is dropped with a warning logged to stderr — the preceding lines are
 * intact and the job can still load and serve.
 */
export function parseNdjson(text: string): unknown[] {
  const lines = text.split("\n");
  // Find the index of the last non-empty line — that's the one a host crash
  // might have torn. Trailing empty strings from a final newline are not lines.
  let lastNonEmpty = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastNonEmpty = i;
      break;
    }
  }
  const values: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch (err) {
      // Only tolerate a truncated FINAL non-empty line. A parse error mid-file
      // is real corruption, not a torn write — surface it so the caller can
      // quarantine the job.
      if (i === lastNonEmpty) {
        console.error(`fleet: dropping truncated final NDJSON line: ${String(err)}`);
        break;
      }
      throw err;
    }
  }
  return values;
}
