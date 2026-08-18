// Fake harness CLI for the push-retention test (#38): does real work, then
// (when TEST_OUTAGE_REMOTE points at a reachable bare repo) moves that repo
// aside so the runner's work push fails the way a provider outage fails.
// Exits clean — the harness succeeded; only the delivery could not land.
import { existsSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

writeFileSync('work.txt', 'implemented while the remote was up\n');

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Implementing, then delivering.' }] } });

// The outage: the remote exists at clone time and is gone at push time.
const remote = process.env.TEST_OUTAGE_REMOTE;
if (remote && existsSync(remote)) {
  renameSync(remote, `${remote}.down`);
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Remote went away.' }] } });
}

writeFileSync(join(out, 'report.json'), JSON.stringify({
  status: 'READY',
  target_rung: 'implemented',
  verification: ['focused tests green'],
  next_action: 'open the pull request',
}));
line({ type: 'result', subtype: 'success' });
