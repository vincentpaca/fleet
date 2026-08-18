// Fake harness CLI for stall detection (#39): does a little real work, says so
// on stdout, then goes silent forever — the shape of a harness wedged on an API
// rate-limit stall. It never exits and never writes a report, so only the
// runner's idle timer can end this run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync(join(process.cwd(), '.fleet', 'out'), { recursive: true });
writeFileSync('half-done.txt', 'partial work, done before the stall\n');

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Starting on the issue.' }] } });

// Silence, held open: no output, no exit, until the runner kills us.
setInterval(() => {}, 60_000);
