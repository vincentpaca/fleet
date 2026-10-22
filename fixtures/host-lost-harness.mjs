// Fake harness CLI for the host-loss e2e (#293). First launch: leave
// uncommitted work and wait to be killed — the test signals the runner the way
// a reclaimed host does, and the daemon never asked for it. Second launch:
// prove the retry resumed (attempt 1's work is in this fresh workspace) and
// finish. The attempt marker lives OUTSIDE the workspace (argv[2]): only an
// external path can tell the launches apart.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const marker = process.argv[2];
if (!marker) {
  process.stderr.write('usage: host-lost-harness.mjs <marker-file>\n');
  process.exit(2);
}
const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

if (!existsSync(marker)) {
  writeFileSync('partial.txt', 'half-finished work from attempt 1\n');
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Starting the change.' }] } });
  // Written last: the test kills the runner only once the work exists.
  writeFileSync(marker, 'attempt 1 waiting for its host to go away\n');
  setInterval(() => {}, 1_000);
} else {
  if (!existsSync('partial.txt')) {
    process.stderr.write('attempt 2 started clean: the lost attempt\'s work is not here\n');
    process.exit(1);
  }
  writeFileSync('work.txt', 'finished on attempt 2, on top of attempt 1\n');
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Resumed: finishing the change.' }] } });
  writeFileSync(join(out, 'report.json'), JSON.stringify({
    status: 'READY',
    target_rung: 'implemented',
    verification: ['focused tests green'],
    next_action: 'review the change',
  }));
  line({ type: 'result', subtype: 'success' });
}
