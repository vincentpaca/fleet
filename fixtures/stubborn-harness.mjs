// Fake harness CLI for the stall kill path (#39): silent like stall-harness,
// and additionally hard to kill in the two ways a real coding CLI is.
//   1. It ignores SIGTERM, so the polite signal cannot end the run — only an
//      escalation to SIGKILL can.
//   2. It leaves a child holding the inherited stdout, so the pipe stays open
//      after this process dies — 'close' never fires unless the whole process
//      group goes down.
// A runner that signals only the shell's pid leaves both of these running.
//
// Both processes tick a heartbeat file so a test can prove they actually
// stopped: a pid check cannot, since a killed-but-unreaped process still
// answers signal 0.
//
// The tick writes to a temp file and renames it, rather than writing the
// heartbeat in place. writeFileSync truncates first, so a SIGKILL landing
// between the truncate and the write leaves the heartbeat empty for good — and
// this fixture exists to be SIGKILLed mid-tick. The test then read '' and
// reported "the child never beat", blaming the fixture for the kill it was
// asked to prove. rename is atomic: the file is never observed half-written.
import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});

const out = join(process.cwd(), '.fleet', 'out');
const beat = (name) => join(out, `heartbeat-${name}`);

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working, and about to wedge.' }] } });

// Inherits stdout: the write end of the runner's pipe outlives this process.
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
