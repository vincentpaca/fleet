// Fake harness CLI for the cancel teardown test (#111): ignores SIGTERM
// (like stubborn-harness), produces real work (like stall-harness), and
// heartbeats to a file so a test can prove the tree stopped.
//
// A SIGTERM-trapping harness is the case the old cancel path failed on:
// killTree(SIGTERM) + process.exit(1) left this process alive as a zombie.
// The new teardown must escalate to SIGKILL.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });
const beat = (name) => join(out, `heartbeat-${name}`);

// Produce work: a file that proves the harness ran and can be WIP-pushed.
writeFileSync('partial-work.txt', 'work done before the cancel\n');

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working, will be cancelled.' }] } });

// Inherits stdout: the write end of the runner's pipe outlives this process,
// so 'close' never fires unless the whole process group goes down.
spawn(process.execPath, [
  '-e',
  `const fs = require('node:fs');` +
  `const f = ${JSON.stringify(beat('child'))};` +
  `const tick = () => { fs.writeFileSync(f + '.tmp', String(Date.now())); fs.renameSync(f + '.tmp', f); };` +
  `tick();` +
  `setInterval(tick, 100);`,
], { stdio: ['ignore', 'inherit', 'inherit'] });

const tick = () => {
  writeFileSync(`${beat('harness')}.tmp`, String(Date.now()));
  renameSync(`${beat('harness')}.tmp`, beat('harness'));
};
tick();
setInterval(tick, 100);