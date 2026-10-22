// Fake harness CLI for the cancel-teardown delivery tests (#197): does what
// job-mt9y7vel's harness did before it was stall-cancelled — COMMITS its work
// (leaving a clean tree with an unpushed commit) and writes artifact files to
// .fleet/out/artifacts/ — then goes quiet and holds. The teardown must land
// the commit and collect the artifacts; both died with the container live.
//
// #291 knobs, so the agent can leave the job branch the way prose prompts and
// `gh pr checkout` do:
//   TEST_CHECKPOINT_FIRST=1  commit early work on the job branch and wait for a
//                            runner checkpoint to push it, before switching
//   TEST_SWITCH              a JSON array of git argv lists, run next
//   TEST_LEAVE_DIRTY=1       leave one more edit uncommitted
//   TEST_NO_ARTIFACTS=1      skip the artifacts: delivery rests on the push
//   TEST_EXIT_AFTER_COMMIT=1 exit 0 instead of holding, for the settle push
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Committing, then waiting.' }] } });

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// With 1s checkpoints the runner's own git calls run alongside these: wait
// out its index lock instead of dying on it, like an agent would retry.
const git = (args, tolerate = false) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      if (String(err.stderr).includes('index.lock') && attempt < 40) { nap(50); continue; }
      if (tolerate) return '';
      throw err;
    }
  }
};

if (process.env.TEST_CHECKPOINT_FIRST === '1') {
  writeFileSync('early-work.txt', 'on the job branch, before the switch\n');
  git(['add', 'early-work.txt']);
  // Tolerated: a checkpoint may already have committed the file as WIP.
  git(['commit', '-q', '-m', 'early work on the job branch'], true);
  const branch = git(['branch', '--show-current']);
  const head = git(['rev-parse', 'HEAD']);
  const deadline = Date.now() + 30_000;
  while (!git(['ls-remote', 'origin', `refs/heads/${branch}`]).startsWith(head)) {
    if (Date.now() > deadline) throw new Error('no checkpoint pushed the early work');
    nap(100);
  }
}

for (const args of JSON.parse(process.env.TEST_SWITCH ?? '[]')) git(args);

// The work: committed in-workspace, never pushed. Identity comes from the
// repo config the runner's setupWorkspace wrote.
writeFileSync('committed-work.txt', 'finished work, committed but not pushed\n');
git(['add', 'committed-work.txt']);
git(['commit', '-q', '-m', 'the work, committed in-container']);
if (process.env.TEST_LEAVE_DIRTY === '1') writeFileSync('uncommitted-work.txt', 'cut off before committing\n');

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
if (process.env.TEST_EXIT_AFTER_COMMIT === '1') process.exit(0);
setInterval(() => {}, 60_000);
