// Fake harness CLI for the auto-retry e2e (#30): exits 1 mid-run on its first
// launch — the shape of an upstream API drop — and succeeds on the second.
// The attempt marker lives OUTSIDE the workspace (argv[2]): every attempt gets
// a fresh workspace, so only an external path can tell the launches apart.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const marker = process.argv[2];
if (!marker) {
  process.stderr.write('usage: retry-harness.mjs <marker-file>\n');
  process.exit(2);
}
const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

if (!existsSync(marker)) {
  // Attempt 1: leave partial work behind, then die the way an API drop does.
  writeFileSync(marker, 'attempt 1 crashed\n');
  writeFileSync('partial.txt', 'half-finished work from attempt 1\n');
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Starting the change.' }] } });
  process.stderr.write('upstream API dropped the connection\n');
  process.exit(1);
}

// Attempt 2: a clean run to done.
writeFileSync('work.txt', 'implemented on attempt 2\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second attempt: finishing the change.' }] } });
writeFileSync(join(out, 'report.json'), JSON.stringify({
  status: 'READY',
  target_rung: 'implemented',
  verification: ['focused tests green'],
  next_action: 'review the change',
}));
line({ type: 'result', subtype: 'success' });
