// Fake harness CLI for the run-phase keepalive (#197): says one thing, then
// emits NOTHING — no stdout at all — for longer than the idle limit while its
// process stays alive, then finishes successfully. The shape of a harness
// waiting on a backgrounded command (job-mt9y7vel waited on a backgrounded
// `npm test` and was stall-cancelled while actively finishing).
//
// TEST_QUIET_MS controls the silent stretch so the test can hold it past the
// idle limit it configures.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working; going quiet now.' }] } });

const quietMs = parseInt(process.env.TEST_QUIET_MS ?? '', 10) || 4_000;
setTimeout(() => {
  writeFileSync(join(out, 'report.json'), JSON.stringify({
    status: 'READY',
    next_action: 'review the result',
    verification: ['finished after the quiet stretch'],
  }));
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Back; finishing.' }] } });
  line({ type: 'result', subtype: 'success' });
  process.exit(0);
}, quietMs);
