/**
 * Duration parsing: convert manifest limit strings ("30s", "2m", "1h") to
 * milliseconds. Returns undefined for strings that don't match the pattern.
 */
export function parseDurationMs(value: string): number | undefined {
  const match = value.match(/^([0-9]+)(s|m|h)$/);
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  if (match[2] === 's') return n * 1_000;
  if (match[2] === 'm') return n * 60_000;
  if (match[2] === 'h') return n * 3_600_000;
  return undefined;
}
