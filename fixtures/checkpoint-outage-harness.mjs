// Fake harness CLI for the checkpoint-failure path (#190): phase one edits a
// file and polls the remote until a checkpoint push lands it; phase two moves
// the remote aside (TEST_OUTAGE_REMOTE, same trick as outage-harness.mjs),
// edits again so the next checkpoints have something to push — and fail —
// then restores the remote and finishes clean. A checkpoint failure must log
// and the run must continue to its own successful settle.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Editing; a checkpoint should pick this up.' }] } });

writeFileSync('first-edit.txt', 'work the first checkpoint should push\n');

const remote = process.env.TEST_OUTAGE_REMOTE;
// The job branch to watch, from the test: the bare remote's own HEAD stays on
// its default branch, which no checkpoint ever moves.
const branch = process.env.TEST_OUTAGE_BRANCH;
const branchHasFirstEdit = () => {
  try {
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
      cwd: remote, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return files.includes('first-edit.txt');
  } catch {
    return false;
  }
};

// No deadline of its own: if the checkpoint never lands, the driving test's
// bounded race fails the run honestly. A fixture-side timeout that proceeds
// anyway would erase the "successful checkpoint first" premise under load.
const waitForCheckpoint = () => {
  if (!branchHasFirstEdit()) {
    setTimeout(waitForCheckpoint, 100);
    return;
  }
  // Phase two: the remote goes away, the next checkpoint(s) must fail-and-log.
  renameSync(remote, `${remote}.down`);
  writeFileSync('second-edit.txt', 'work the failing checkpoints cannot push yet\n');
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Remote down; still working.' }] } });
  setTimeout(finish, parseInt(process.env.TEST_OUTAGE_HOLD_MS ?? '', 10) || 3_000);
};

const finish = () => {
  if (existsSync(`${remote}.down`)) renameSync(`${remote}.down`, remote);
  writeFileSync(join(out, 'report.json'), JSON.stringify({
    status: 'READY',
    next_action: 'review the pushed work',
    verification: ['survived a checkpoint outage'],
  }));
  line({ type: 'result', subtype: 'success' });
  process.exit(0);
};

setTimeout(waitForCheckpoint, 100);
