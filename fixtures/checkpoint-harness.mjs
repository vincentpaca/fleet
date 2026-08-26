// Fake harness CLI for checkpoint pushes (#190): edits a file, says so once,
// then works on silently forever — the shape of a long job whose only copy of
// the work would otherwise leave the container in the single teardown-push
// moment. The test waits for a checkpoint to land on the remote, then SIGKILLs
// the whole runner tree (no teardown of any kind) and asserts the branch is no
// staler than the checkpoint interval.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync(join(process.cwd(), '.fleet', 'out'), { recursive: true });
writeFileSync('long-job-work.txt', 'hours of work, existing only in this workspace\n');

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Edited; grinding on.' }] } });

setInterval(() => {}, 60_000);
