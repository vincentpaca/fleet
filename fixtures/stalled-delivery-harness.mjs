// Fake harness CLI replicating job-mt9y7vel (#197): commits its finished work
// in-workspace (never pushes), writes two artifact files, then produces only
// untranslatable stdout forever — lines that keep the RUNNER's stdout-silence
// clock fresh while the daemon's event-stream clock runs dry. With the
// keepalive suppressed (the test pins FLEET_HEARTBEAT_MS huge, the incident's
// dead keepalive), the daemon's idle sweep is what ends this job — and the
// teardown it triggers must deliver the commit, the artifacts, and the
// runner's own settle.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done; committing and waiting on a backgrounded check.' }] } });

writeFileSync('committed-work.txt', 'the finished README task, committed at 11:19\n');
execFileSync('git', ['add', 'committed-work.txt']);
execFileSync('git', ['commit', '-q', '-m', 'finish the task in-container']);

const artifactsDir = join(out, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(join(artifactsDir, 'answer.md'), '# Answer\n\nWritten minutes before the cancel.\n');
writeFileSync(join(artifactsDir, 'readme-audit.md'), '# README audit\n\nAlso on disk when the sweep fired.\n');

// Alive and busy on stdout, invisible on the event stream: tool_progress is
// one of the harness's own heartbeats the translator deliberately drops (#50).
let elapsed = 0;
setInterval(() => {
  elapsed += 200;
  line({ type: 'system', subtype: 'tool_progress', tool_use_id: 't1', elapsed_ms: elapsed });
}, 200);
