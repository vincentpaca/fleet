// `fleet setup harness` (#17): install the fleet skill where each coding
// harness discovers it. Harnesses are Fleet's UI (docs/decisions.md#d8), and
// this command is what makes that UI actually present on a machine — so what
// these tests are about is the parts an operator would only discover by losing
// something: does the skill land where the harness looks, does a rerun leave a
// working install alone, and does an edited copy survive a rerun.
//
// No harness binary is ever executed. Detection only asks whether one exists,
// so the fakes here are empty executables and a temp HOME — running a real
// `claude` would be testing somebody else's CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, makeTempDir } from './cli-helpers.ts';
import { parseSkill, renderVariant, readStamp, isGenerated, SetupError } from '../src/cli/setup.ts';
import { HARNESS_TARGETS, harnessFor, detectHarness, onPath, skillPath } from '../src/cli/setup-harnesses.ts';

const CANONICAL = fs.readFileSync(new URL('../integrations/SKILL.md', import.meta.url), 'utf8');

/**
 * A temp home, a temp project, and a PATH holding only the named fake harnesses.
 *
 * `nested` puts the project *inside* the home directory, which is where real
 * checkouts live. Sibling temp dirs are the one layout in which a home-relative
 * path cannot be mistaken for a project-relative one, so a test that only ever
 * uses siblings cannot see that class of bug at all.
 */
function scratch(binaries: string[] = [], opts: { nested?: boolean } = {}): {
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
} {
  const home = makeTempDir('fleet-harness-home-');
  const cwd = opts.nested ? fs.mkdtempSync(path.join(home, 'project-')) : makeTempDir('fleet-harness-proj-');
  const bin = makeTempDir('fleet-harness-bin-');
  for (const name of binaries) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  // PATH is replaced, never extended: the machine running the suite may well
  // have a real `claude` on it, and a detection test that passes because of
  // that is a test of the developer's laptop.
  return { home, cwd, env: { HOME: home, PATH: bin } };
}

const installed = (root: string, rel: string): string =>
  path.join(root, rel, 'fleet-delegate', 'SKILL.md');

/** The path the generated note tells its reader this file lives at. */
function whereItLives(text: string): string | undefined {
  return text.match(/\*\*Where this file lives\.\*\* `([^`]+)`/)?.[1];
}

// ---------- the canonical, and the variants generated from it ----------

test('parseSkill refuses a canonical no harness could discover', () => {
  assert.throws(() => parseSkill('# just a document\n', 'x.md'), SetupError, 'frontmatter-less file accepted');
  assert.throws(() => parseSkill('---\nname: fleet-delegate\n---\nbody\n', 'x.md'), SetupError, 'missing description accepted');
  assert.throws(
    () => parseSkill('---\nname: Fleet_Delegate\ndescription: d\n---\nbody\n', 'x.md'),
    SetupError,
    'a name no harness accepts as a directory was accepted',
  );
  const ok = parseSkill(CANONICAL, 'integrations/SKILL.md');
  assert.equal(ok.name, 'fleet-delegate');
  assert.ok(ok.description.length > 40, 'the description is what triggers the skill — it cannot be a stub');
});

test('an edited variant stops reading as generated', () => {
  const canonical = parseSkill(CANONICAL, 'integrations/SKILL.md');
  const roots = { home: '/home/op', cwd: '/home/op/project' };
  const { text } = renderVariant({ canonical, harness: harnessFor('claude-code')!, scope: 'user', version: '1.2.3', roots });
  assert.ok(isGenerated(text));

  // One appended line, the smallest edit anyone makes. The stamp records a hash
  // of everything else in the file precisely so this is detectable: without it,
  // "the file exists and looks like ours" is the only question a rerun can ask,
  // and the answer overwrites the operator's own work.
  assert.equal(isGenerated(`${text}one more note\n`), false, 'an appended line went undetected');
  assert.equal(isGenerated(text.replace('fleet delegate', 'fleet delegate --mode assess')), false, 'a body edit went undetected');
  // A fleet upgrade is not an edit: the version sits in the stamp, outside the hash.
  const bumped = renderVariant({ canonical, harness: harnessFor('claude-code')!, scope: 'user', version: '9.9.9', roots });
  assert.equal(readStamp(bumped.text)!.hash, readStamp(text)!.hash, 'a version bump changed the content hash');
  assert.notEqual(bumped.text, text, 'the version bump is not visible in the file at all');
});

test('scope decides which root a variant lands under', () => {
  const roots = { home: '/home/op', cwd: '/home/op/project' };
  for (const harness of HARNESS_TARGETS) {
    const user = skillPath(harness, 'user', 'fleet-delegate', roots);
    const project = skillPath(harness, 'project', 'fleet-delegate', roots);
    assert.ok(user.startsWith(`${roots.home}/`), `${harness.id}: user scope escaped the home dir`);
    assert.ok(project.startsWith(`${roots.cwd}/`), `${harness.id}: project scope escaped the project`);
    assert.notEqual(user, project, `${harness.id}: one path for both scopes`);
  }
});

// ---------- detection ----------

test('a harness counts as installed by its binary or by its config dir', () => {
  const s = scratch(['codex']);
  const claude = harnessFor('claude-code')!;
  const codex = harnessFor('codex')!;

  assert.equal(onPath('codex', s.env), true);
  assert.equal(onPath('claude', s.env), false);
  assert.match(detectHarness(codex, { env: s.env, home: s.home })!, /codex on PATH/);
  assert.equal(detectHarness(claude, { env: s.env, home: s.home }), undefined);

  // A harness reached through a wrapper or an alias leaves its config dir
  // behind and nothing on PATH. Missing that case means the default excludes
  // the harness the operator actually uses.
  const configDir = path.join(s.home, claude.configDir);
  fs.mkdirSync(configDir, { recursive: true });
  assert.equal(detectHarness(claude, { env: s.env, home: s.home }), undefined, 'an empty config dir proves a mkdir, not a harness');
  fs.writeFileSync(path.join(configDir, 'settings.json'), '{}\n');
  assert.match(detectHarness(claude, { env: s.env, home: s.home })!, /\.claude exists/);
});

test('a non-executable file with a harness name is not a harness', () => {
  const s = scratch();
  const bin = s.env.PATH!;
  fs.writeFileSync(path.join(bin, 'opencode'), 'notes about opencode\n', { mode: 0o644 });
  assert.equal(onPath('opencode', s.env), false, 'an unexecutable file was taken for the harness');
});

// ---------- the command ----------

test('setup harness installs for what it detected, where that harness looks', async () => {
  const s = scratch(['claude']);
  const res = await runCli(['setup', 'harness'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);

  const target = installed(s.home, HARNESS_TARGETS[0].skillsDir.user);
  const text = fs.readFileSync(target, 'utf8');
  assert.ok(isGenerated(text), 'the installed file is not a fleet-generated variant');
  assert.match(text, /^---\nname: fleet-delegate\n/, 'frontmatter is not the first thing a harness reads');
  assert.ok(text.includes('integrations/SKILL.md'), 'the installed variant does not name its canonical');
  assert.ok(text.includes('AskUserQuestion'), 'the Claude Code variant does not state how to ask its human');

  // Detected only claude — nothing may be installed for the harnesses that are
  // not here. An install that writes all three is an install that puts a skill
  // into a directory the operator never asked Fleet to touch.
  assert.equal(fs.existsSync(installed(s.home, harnessFor('codex')!.skillsDir.user)), false);
  assert.equal(fs.existsSync(installed(s.home, harnessFor('opencode')!.skillsDir.user)), false);
  assert.match(res.stdout, /^found\s+claude-code/m);
  assert.match(res.stdout, /^not here\s+codex/m);
});

test('a rerun is idempotent, and reports it as unchanged', async () => {
  const s = scratch(['claude']);
  assert.equal((await runCli(['setup', 'harness'], { cwd: s.cwd, env: s.env })).code, 0);
  const target = installed(s.home, harnessFor('claude-code')!.skillsDir.user);
  const first = fs.readFileSync(target, 'utf8');

  const again = await runCli(['setup', 'harness'], { cwd: s.cwd, env: s.env });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^unchanged\s+claude-code/m);
  assert.equal(fs.readFileSync(target, 'utf8'), first, 'a rerun rewrote an already-current variant');
});

test('a hand-edited copy survives a rerun, and --force is what replaces it', async () => {
  const s = scratch(['claude']);
  await runCli(['setup', 'harness'], { cwd: s.cwd, env: s.env });
  const target = installed(s.home, harnessFor('claude-code')!.skillsDir.user);
  const edited = `${fs.readFileSync(target, 'utf8')}\n## My own house rules\n\nAlways dispatch with --mode assess first.\n`;
  fs.writeFileSync(target, edited);

  const refused = await runCli(['setup', 'harness'], { cwd: s.cwd, env: s.env });
  assert.equal(refused.code, 1, 'an edited copy was overwritten and the command reported success');
  assert.match(refused.stderr, /refusing to overwrite/);
  assert.match(refused.stderr, /--force/);
  assert.equal(fs.readFileSync(target, 'utf8'), edited, 'the operator\'s edits were destroyed');

  const forced = await runCli(['setup', 'harness', '--force'], { cwd: s.cwd, env: s.env });
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /^updated\s+claude-code/m);
  assert.ok(isGenerated(fs.readFileSync(target, 'utf8')), '--force did not restore a generated variant');
});

test('a foreign SKILL.md in the same place is not ours to overwrite either', async () => {
  const s = scratch(['opencode']);
  const target = installed(s.home, harnessFor('opencode')!.skillsDir.user);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const theirs = '---\nname: fleet-delegate\ndescription: my own take on delegating\n---\n\nDo it my way.\n';
  fs.writeFileSync(target, theirs);

  const res = await runCli(['setup', 'harness'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /fleet did not write it/);
  assert.equal(fs.readFileSync(target, 'utf8'), theirs);
});

test('one blocked harness does not block the others', async () => {
  const s = scratch(['claude', 'codex']);
  // The blocked one is FIRST in install order on purpose: refusals are
  // collected and reported at the end, and a command that threw on the first
  // one would leave the operator's second harness silently uninstalled while
  // the message only talked about the first.
  const blocked = installed(s.home, harnessFor('claude-code')!.skillsDir.user);
  fs.mkdirSync(path.dirname(blocked), { recursive: true });
  fs.writeFileSync(blocked, 'hand-written\n');

  const res = await runCli(['setup', 'harness'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1, 'a refusal must be visible in the exit code');
  assert.match(res.stdout, /^installed\s+codex/m, 'the installable harness was skipped too');
  assert.ok(isGenerated(fs.readFileSync(installed(s.home, harnessFor('codex')!.skillsDir.user), 'utf8')));
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'hand-written\n');
});

test('--scope project installs into the checkout and leaves the home dir alone', async () => {
  const s = scratch(['opencode']);
  const res = await runCli(['setup', 'harness', '--scope', 'project'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);

  const opencode = harnessFor('opencode')!;
  assert.ok(fs.existsSync(installed(s.cwd, opencode.skillsDir.project)), 'nothing landed in the project');
  assert.equal(fs.existsSync(installed(s.home, opencode.skillsDir.user)), false, 'project scope wrote into the home dir');
  // The path written into the file is the one an operator can act on, and a
  // project-scope variant is committable — an absolute temp path here would be
  // both noise and a leak of whoever generated it.
  const text = fs.readFileSync(installed(s.cwd, opencode.skillsDir.project), 'utf8');
  assert.ok(text.includes(path.join(opencode.skillsDir.project, 'fleet-delegate', 'SKILL.md')));
  assert.equal(text.includes(s.cwd), false, 'the variant carries an absolute path from the machine that generated it');
});

test('a project-scope variant describes itself the same way in every clone', async () => {
  // The checkout is under the home directory, as checkouts are. A home-relative
  // path would render as ~/project-xxx/.opencode/… — untrue for every teammate
  // who cloned elsewhere, and inside the hashed content, so each of their setup
  // runs would rewrite this committed file with their own layout.
  const s = scratch(['opencode'], { nested: true });
  const res = await runCli(['setup', 'harness', '--scope', 'project'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);

  const target = installed(s.cwd, harnessFor('opencode')!.skillsDir.project);
  const text = fs.readFileSync(target, 'utf8');
  assert.equal(
    whereItLives(text),
    path.join(harnessFor('opencode')!.skillsDir.project, 'fleet-delegate', 'SKILL.md'),
    'a project-scope variant does not describe itself relative to the checkout',
  );
  assert.equal(text.includes(path.basename(s.cwd)), false, 'the variant names the directory this clone happens to sit in');

  // Same bytes from a different clone of the same repo: that is what makes the
  // file committable without churning on everyone who runs setup.
  const other = scratch(['opencode'], { nested: true });
  fs.cpSync(path.dirname(target), path.join(other.cwd, harnessFor('opencode')!.skillsDir.project, 'fleet-delegate'), {
    recursive: true,
  });
  const rerun = await runCli(['setup', 'harness', '--scope', 'project'], { cwd: other.cwd, env: other.env });
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.match(rerun.stdout, /^unchanged\s+opencode/m, 'another clone rewrote a committed variant');
});

test('a CRLF checkout of a committed variant is still ours', async () => {
  const s = scratch(['codex'], { nested: true });
  await runCli(['setup', 'harness', '--scope', 'project'], { cwd: s.cwd, env: s.env });
  const target = installed(s.cwd, harnessFor('codex')!.skillsDir.project);
  const crlf = fs.readFileSync(target, 'utf8').replace(/\n/g, '\r\n');
  fs.writeFileSync(target, crlf);

  // The dangerous outcome is not a rewrite, it is the message: "fleet did not
  // write it" about a file fleet wrote is what pushes an operator into --force.
  assert.ok(isGenerated(crlf), 'a CRLF variant stopped reading as fleet-generated');
  const res = await runCli(['setup', 'harness', '--scope', 'project'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^unchanged\s+codex/m);
  assert.equal(fs.readFileSync(target, 'utf8'), crlf, 'line endings were rewritten under the operator');
});

test('installing does not become the evidence that a harness is here', async () => {
  // ~/.claude/skills sits inside ~/.claude: writing the skill creates the very
  // directory detection reads. Left unchecked, one --harness opencode makes
  // every later run report OpenCode as found on a machine without it — a claim
  // about Fleet's own footprint, printed as a claim about the operator's.
  const s = scratch();
  for (const id of ['claude-code', 'opencode']) {
    const harness = harnessFor(id)!;
    assert.equal(detectHarness(harness, { env: s.env, home: s.home }), undefined, `${id} detected before install`);
    const res = await runCli(['setup', 'harness', '--harness', id], { cwd: s.cwd, env: s.env });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(fs.existsSync(installed(s.home, harness.skillsDir.user)));
    assert.equal(
      detectHarness(harness, { env: s.env, home: s.home }),
      undefined,
      `${id} reads as installed because fleet created its config dir`,
    );
  }
  // And a config dir with anything else in it is still real evidence.
  fs.writeFileSync(path.join(s.home, harnessFor('claude-code')!.configDir, 'settings.json'), '{}\n');
  assert.match(detectHarness(harnessFor('claude-code')!, { env: s.env, home: s.home })!, /\.claude exists/);
});

test('the harness note names the canonical skill it was generated from', () => {
  // The directory comes from the frontmatter name, so the sentence that tells
  // the agent what the directory must be called has to come from there too.
  const renamed = parseSkill(CANONICAL.replace('name: fleet-delegate', 'name: fleet-dispatch'), 'x.md');
  const { text, destination } = renderVariant({
    canonical: renamed,
    harness: harnessFor('claude-code')!,
    scope: 'user',
    version: '1.0.0',
    roots: { home: '/home/op', cwd: '/home/op/project' },
  });
  assert.ok(destination.includes('fleet-dispatch'), 'the directory did not follow the frontmatter name');
  assert.ok(text.includes('has to stay `fleet-dispatch`'), 'the note still names the old skill directory');
});

test('--harness names harnesses this machine has not got yet', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'harness', '--harness', 'codex,opencode'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(fs.existsSync(installed(s.home, harnessFor('codex')!.skillsDir.user)));
  assert.ok(fs.existsSync(installed(s.home, harnessFor('opencode')!.skillsDir.user)));
  assert.equal(fs.existsSync(installed(s.home, harnessFor('claude-code')!.skillsDir.user)), false);
});

test('an unknown harness is refused by name, and nothing is written', async () => {
  const s = scratch(['claude']);
  const res = await runCli(['setup', 'harness', '--harness', 'claude-code,notaharness'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no discovery convention for: notaharness/);
  assert.match(res.stderr, /claude-code, codex, opencode/, 'the refusal does not say what is known');
  assert.equal(
    fs.existsSync(installed(s.home, harnessFor('claude-code')!.skillsDir.user)),
    false,
    'a bad harness list installed some of it anyway',
  );
});

test('an unknown scope is refused rather than defaulted', async () => {
  const s = scratch(['claude']);
  const res = await runCli(['setup', 'harness', '--scope', 'global'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--scope: user or project/);
});

test('headless with nothing detected exits naming the flag, never waiting', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'harness'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--harness/);
  assert.match(res.stderr, /nothing was detected here/);
});

test('on a terminal it asks which harnesses and which scope', async () => {
  const s = scratch(['claude']);
  const res = await runCli(['setup', 'harness'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    // codex (overriding the detected default), then Enter for the user scope.
    stdin: 'codex\n\n',
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /install the fleet skill for which harnesses/);
  assert.match(res.stdout, /\[claude-code\]/, 'the detected harness is not offered as the default');
  assert.ok(fs.existsSync(installed(s.home, harnessFor('codex')!.skillsDir.user)));
  assert.equal(fs.existsSync(installed(s.home, harnessFor('claude-code')!.skillsDir.user)), false);
});

test('setup names harness among its subcommands', async () => {
  const res = await runCli(['setup'], {});
  assert.equal(res.code, 2);
  assert.match(res.stderr, /infra, repo, harness/);
});
