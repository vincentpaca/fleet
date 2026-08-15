// Fake harness CLI for the end-to-end test: emits Claude-style stream-json,
// raises one decision via the decision-file convention, waits for the answer,
// then writes a status-first report and exits clean.
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the ticket and the module boundary.' }] } });
line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });

writeFileSync(join(out, 'decision.json'), JSON.stringify({
  question: 'Migration conflicts with an unmerged branch. How should I proceed?',
  options: [
    { id: 'rebase', label: 'Rebase onto the branch and renumber', recommended: true },
    { id: 'wait', label: 'Park until the branch merges' },
  ],
  who: 'engineer',
  note: 'A sequencing call the agent cannot make alone.',
}));

const answerPath = join(out, 'answer-d1.json');
const deadline = Date.now() + 30_000;
while (!existsSync(answerPath)) {
  if (Date.now() > deadline) {
    process.stderr.write('timed out waiting for answer\n');
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 100));
}
const answer = JSON.parse(readFileSync(answerPath, 'utf8'));
line({ type: 'assistant', message: { content: [{ type: 'text', text: `Proceeding with ${answer.option}.` }] } });

writeFileSync(join(out, 'report.json'), JSON.stringify({
  status: 'READY',
  target_rung: 'implemented',
  verification: ['focused tests green'],
  next_action: 'open the pull request',
}));
line({ type: 'result', subtype: 'success' });
