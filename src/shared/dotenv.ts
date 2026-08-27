/**
 * `.fleet/.env` — the repo-local secrets file (gitignored; `.env.example` is
 * the committable template). One reader and one writer for the whole tree:
 * the CLI's dispatch/doctor checks and `fleet setup repo`'s credential walk
 * (#205) must agree byte-for-byte on what the file means, so the parsing
 * rules live here and nowhere else.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse a .fleet/.env file: KEY=VALUE per line.
 * Rules: # starts a comment; blank lines ignored; everything after the first
 * '=' is the value (trimmed); no interpolation; no quoting beyond trim.
 * Empty values (KEY=) are accepted — they satisfy the "var is set" check.
 */
function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue; // no key before '='
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** Load .fleet/.env from the given .fleet directory. Returns {} when the file is absent (ENOENT). */
export function loadDotEnv(fleetDir: string): Record<string, string> {
  try {
    return parseDotEnv(fs.readFileSync(path.join(fleetDir, '.env'), 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Write values into .fleet/.env: replace the line of a key that is already
 * there, append the ones that are not, keep every other line verbatim. The
 * file holds credentials, so it is created 0600 — and an existing file is
 * tightened to 0600 too, because `writeFileSync`'s mode applies only at
 * creation and a hand-made world-readable .env should not survive a rerun.
 *
 * Returns the file path, for whoever is doing the logging.
 */
export function upsertDotEnv(fleetDir: string, updates: Record<string, string>): string {
  const file = path.join(fleetDir, '.env');
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const lines = current.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    const at = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
    if (at === -1) lines.push(`${key}=${value}`);
    else lines[at] = `${key}=${value}`;
  }
  fs.mkdirSync(fleetDir, { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
