// The stop-note rule (#293), as a check rather than a comment. The daemon
// reads a runner's cancelled(signal) as a host loss, and auto-retries it,
// exactly when the journal holds no STOP_REQUEST_NOTE. So every
// provider.terminate() call in the daemon is one of two kinds:
//  - note-first: it may hit a job that is not yet terminal, so the method
//    journals STOP_REQUEST_NOTE before it signals;
//  - terminal-only: the job is already terminal, and intake rejects whatever
//    the dying runner says.
// A new call site fails here until someone decides which kind it is. Keyed by
// the enclosing method name, not by line, so ordinary edits don't break it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon', 'server.ts');

const NOTE_FIRST = ['#cancel', '#cancelFromBackstop', '#resolveLostLaunch'];
const TERMINAL_ONLY = ['#launchFresh', '#applyTerminalState', '#stopOrphan'];

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);

/** Each class member's name with its source text, from a two-space-indented header to the next. */
function methods(source: string): { name: string; body: string }[] {
  const header = /^ {2}(?:static |async |get |set )*(#?[A-Za-z_$][\w$]*)\s*[(<]/;
  const found: { name: string; body: string }[] = [];
  for (const line of source.split('\n')) {
    const match = header.exec(line);
    if (match !== null && !KEYWORDS.has(match[1]!)) {
      found.push({ name: match[1]!, body: '' });
    } else if (found.length > 0) {
      found[found.length - 1]!.body += `${line}\n`;
    }
  }
  return found;
}

test('every provider.terminate() call in the daemon is classified note-first or terminal-only (#293)', () => {
  const callers = methods(readFileSync(SERVER, 'utf8'))
    .filter((m) => m.body.includes('provider.terminate('))
    .map((m) => m.name);
  const unclassified = callers.filter((name) => !NOTE_FIRST.includes(name) && !TERMINAL_ONLY.includes(name));
  assert.deepEqual(
    unclassified,
    [],
    'a new terminate() call site: journal STOP_REQUEST_NOTE before it and list it in NOTE_FIRST, ' +
      'or, if the job is always terminal there, list it in TERMINAL_ONLY',
  );
  const stale = [...NOTE_FIRST, ...TERMINAL_ONLY].filter((name) => !callers.includes(name));
  assert.deepEqual(stale, [], 'an allowlisted method no longer calls terminate(): drop it from the list');
});

test('every note-first method journals STOP_REQUEST_NOTE before its first terminate() (#293)', () => {
  const byName = new Map(methods(readFileSync(SERVER, 'utf8')).map((m) => [m.name, m.body]));
  for (const name of NOTE_FIRST) {
    const body = byName.get(name) ?? '';
    const signal = body.indexOf('provider.terminate(');
    assert.ok(signal !== -1, `${name} no longer calls terminate()`);
    assert.ok(
      body.slice(0, signal).includes('STOP_REQUEST_NOTE'),
      `${name} signals before journalling STOP_REQUEST_NOTE: its stop would read as a host loss and be auto-retried`,
    );
  }
});
