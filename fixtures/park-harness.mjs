// Fake harness CLI for the park-path teardown tests (#152): produces real
// work, raises a decision, then waits for an answer that never comes — so the
// runner's block_hot expiry parks the job. Exits on SIGTERM (default
// disposition): the park path's endHarness must not be what these tests spend
// their time on.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

// Work that a park's WIP push has to deliver (or hang on, in #152's tests).
writeFileSync('partial-work.txt', 'work done before the park\n');

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Blocked on a decision.' }] } });

writeFileSync(join(out, 'decision.json'), JSON.stringify({
  question: 'Should we proceed?',
  options: [
    { id: 'yes', label: 'Yes', recommended: true },
    { id: 'no', label: 'No' },
  ],
}));

// Wait for the answer forever; block_hot expires first and the runner parks.
setInterval(() => {}, 1000);
