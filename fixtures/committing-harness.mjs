// Fake harness CLI for the cancel-teardown delivery tests (#197): does what
// job-mt9y7vel's harness did before it was stall-cancelled — COMMITS its work
// (leaving a clean tree with an unpushed commit) and writes artifact files to
// .fleet/out/artifacts/ — then goes quiet and holds. The teardown must land
// the commit and collect the artifacts; both died with the container live.
//
// #291: TEST_SWITCH (a JSON array of git argv lists) runs first, so the agent
// can leave the job branch the way prose prompts and `gh pr checkout` do.
// TEST_EXIT_AFTER_COMMIT=1 leaves one more edit uncommitted and exits 0
// instead of holding, for the settle push. TEST_NO_ARTIFACTS=1 skips the
// artifacts, so a settle's delivery rests on the push alone.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Committing, then waiting.' }] } });

for (const args of JSON.parse(process.env.TEST_SWITCH ?? '[]')) execFileSync('git', args);

// The work: committed in-workspace, never pushed. Identity comes from the
// repo config the runner's setupWorkspace wrote.
writeFileSync('committed-work.txt', 'finished work, committed but not pushed\n');
execFileSync('git', ['add', 'committed-work.txt']);
execFileSync('git', ['commit', '-q', '-m', 'the work, committed in-container']);

// The artifacts: on disk minutes before the cancel, exactly like the journal's
// Write events showed for answer.md and readme-audit.md.
if (process.env.TEST_NO_ARTIFACTS !== '1') {
  const artifactsDir = join(out, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, 'answer.md'), '# Answer\n\nThe audit is complete.\n');
  writeFileSync(join(artifactsDir, 'readme-audit.md'), '# README audit\n\nFindings within.\n');
}

// Ready marker for the test, then hold: alive, silent, waiting.
writeFileSync(join(out, 'work-staged'), String(Date.now()));
if (process.env.TEST_EXIT_AFTER_COMMIT === '1') {
  writeFileSync('uncommitted-work.txt', 'cut off before committing\n');
  process.exit(0);
}
setInterval(() => {}, 60_000);
