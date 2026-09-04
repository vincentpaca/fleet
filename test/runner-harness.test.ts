// Harness command derivation (#4): the exact launch line comes from the
// manifest + work-order target; the env override wins verbatim; version
// requirements are checked, never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarnessCommand, describeHarnessPlan, versionSatisfies, parseVersion, OUTPUT_CONTRACT } from '../src/runner/harness.ts';

const manifest = {
  harness: {
    cli: 'claude-code',
    cli_version: '>=2.1.0',
    commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
  },
};

test('derives the claude-code launch argv from the first command and the target', () => {
  const plan = buildHarnessCommand({ manifest, target: 'APP-14', actualVersion: '2.1.220' });
  assert.ok(plan);
  assert.equal(plan.file, 'claude');
  assert.equal(plan.shell, false, 'the derived plan is argv; a shell here re-opens #241');
  assert.deepStrictEqual(plan.args, [
    '-p', `/dev APP-14\n\n${OUTPUT_CONTRACT}`,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Task', 'TodoWrite', 'WebSearch', 'WebFetch',
  ]);
  assert.deepStrictEqual(plan.notes, []);
});

test('the output contract is injected into every derived prompt, verbatim (#81)', () => {
  // Pin the exact contract text: the delivery guarantee is product-level, not
  // repo-playbook courtesy. A reword, a wrong directory, or an injection that
  // silently stops happening must fail here first.
  assert.equal(
    OUTPUT_CONTRACT,
    'Fleet output contract: write every deliverable and any text answer as files under .fleet/out/artifacts/ (an answer is a file, e.g. answer.md). Files anywhere else are not collected.',
  );
  const plan = buildHarnessCommand({ manifest, target: 'APP-14', actualVersion: '2.1.220' });
  assert.ok(plan);
  // The contract rides inside the -p prompt argument, so it reaches the agent
  // on repos with no fleet playbook at all.
  assert.ok(
    plan.args.includes(`/dev APP-14\n\n${OUTPUT_CONTRACT}`),
    `contract missing from launch argv: ${JSON.stringify(plan.args)}`,
  );
});

test('override wins verbatim, no notes, no derivation', () => {
  const plan = buildHarnessCommand({ manifest, target: 'APP-14', override: 'node fake-harness.mjs' });
  // shell: true is right here and only here — FLEET_HARNESS_CMD is a command
  // line an operator wrote, and splitting it ourselves would break every
  // override that uses quoting or `node -e "..."`.
  assert.deepStrictEqual(plan, { file: 'node fake-harness.mjs', args: [], shell: true, notes: [] });
});

test('claude-code adapter ships its dialect env default; overrides carry none', () => {
  const plan = buildHarnessCommand({ manifest, target: 'APP-14', actualVersion: '2.1.220' });
  assert.equal(plan?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '64000');
  const override = buildHarnessCommand({ manifest, target: 'APP-14', override: 'node fake.mjs' });
  assert.equal(override?.env, undefined);
});

test('continues (#80) rides into the prompt: PR, branch, gh feedback instructions', () => {
  const plan = buildHarnessCommand({
    manifest,
    target: '77',
    actualVersion: '2.1.220',
    continues: { pr: 41, branch: 'fleet/77-job-old' },
  });
  assert.ok(plan);
  const prompt = plan.args[1];
  assert.match(prompt, /continuing PR #41 \(branch fleet\/77-job-old\)/);
  assert.match(prompt, /review comments and failing checks/);
  assert.match(prompt, /gh pr checks 41/, 'the agent is told to use gh itself — no runner-side feedback plumbing');
  assert.match(prompt, /never open a new PR/);
  // The bug this catches: continuation text leaking into ordinary dispatches,
  // which would send every implement job hunting for a PR that does not exist.
  const plain = buildHarnessCommand({ manifest, target: '77', actualVersion: '2.1.220' });
  assert.ok(plain);
  assert.doesNotMatch(plain.args[1], /continuing PR/);
});

test('version violations become notes, not failures', () => {
  const plan = buildHarnessCommand({ manifest, target: 'APP-14', actualVersion: '2.0.9' });
  assert.ok(plan);
  assert.match(plan.notes[0], /2\.0\.9 violates .*>=2\.1\.0/);
});

test('underivable setups return undefined (unknown cli, missing commands)', () => {
  assert.equal(buildHarnessCommand({ manifest: { harness: { cli: 'codex' } }, target: 'X' }), undefined);
  assert.equal(buildHarnessCommand({ manifest: { harness: { cli: 'claude-code', commands: [] } }, target: 'X' }), undefined);
});

test('versionSatisfies: >= comparisons and exact-prefix pins', () => {
  assert.equal(versionSatisfies('2.1.220', '>=2.1.0'), true);
  assert.equal(versionSatisfies('2.1.0', '>=2.1.220'), false);
  assert.equal(versionSatisfies('3.0.0', '>=2.9.9'), true);
  assert.equal(versionSatisfies('2.1.220', '2.1'), true);
  assert.equal(versionSatisfies('2.2.0', '2.1'), false);
  assert.equal(versionSatisfies('2.1.220', '~2.1'), undefined, 'unsupported syntax is reported, never guessed');
});

// --- Command injection (#241) ---
// A `$(...)` in the target or in an adopted PR's branch name used to be run by
// the shell the runner launched the harness through. The branch name is chosen
// by whoever opened the PR, so these run the plan for real — against a `claude`
// stub on PATH, spawned exactly as src/runner/main.ts spawns it — and read back
// what the process actually received. Asserting on the plan alone would pass
// against a builder that quotes correctly and a spawn site that still says
// `shell: true`, which is the bug.

/** A `claude` on PATH that records its argv, one entry per line. */
function stubClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-harness-argv-'));
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FLEET_TEST_ARGV"\n', { mode: 0o755 });
  return dir;
}

/** Run a plan the way the runner does, and return everything the stub saw. */
function runPlan(plan: { file: string; args: string[]; shell: boolean }): { argv: string; cwd: string } {
  const bin = stubClaudeDir();
  const cwd = mkdtempSync(join(tmpdir(), 'fleet-harness-cwd-'));
  const argvFile = join(cwd, 'argv.txt');
  const res = spawnSync(plan.file, plan.args, {
    shell: plan.shell,
    cwd,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, FLEET_TEST_ARGV: argvFile },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `stub harness did not run: ${res.error?.message ?? res.stderr}`);
  return { argv: readFileSync(argvFile, 'utf8'), cwd };
}

test('a target with shell metacharacters reaches the harness literally (#241)', () => {
  const plan = buildHarnessCommand({
    manifest,
    target: 'audit why $HOME is wrong, `id -u` and $(touch pwned-target) matter',
    actualVersion: '2.1.220',
  });
  assert.ok(plan);
  const { argv, cwd } = runPlan(plan);
  assert.ok(argv.includes('$HOME'), `$HOME was expanded before the harness saw it:\n${argv}`);
  assert.ok(argv.includes('`id -u`'), `backticks were consumed by a shell:\n${argv}`);
  assert.ok(argv.includes('$(touch pwned-target)'), `command substitution was consumed by a shell:\n${argv}`);
  assert.equal(existsSync(join(cwd, 'pwned-target')), false, 'the target executed a command');
});

test('an adopted PR branch with a command substitution reaches the harness literally (#241)', () => {
  // headRefName comes from whoever opened the PR (src/cli/main.ts reads it from
  // `gh pr view`), so this is the remote-code-execution half of the bug.
  const plan = buildHarnessCommand({
    manifest,
    target: '77',
    actualVersion: '2.1.220',
    continues: { pr: 7, branch: 'feat/$(touch pwned-branch)' },
  });
  assert.ok(plan);
  const { argv, cwd } = runPlan(plan);
  assert.ok(argv.includes('branch feat/$(touch pwned-branch)'), `branch name was interpreted:\n${argv}`);
  assert.equal(existsSync(join(cwd, 'pwned-branch')), false, 'a PR branch name executed a command');
});

test('FLEET_HARNESS_CMD still runs through a shell, verbatim (#241 asymmetry)', () => {
  // The operator wrote this line; shell features in it are the feature. Losing
  // the shell here breaks every override that redirects, pipes, or quotes.
  const plan = buildHarnessCommand({
    manifest,
    target: 'APP-14',
    override: 'sh -c \'printf "%s\\n" "shell ran" > "$FLEET_TEST_ARGV"\'',
  });
  assert.ok(plan);
  assert.equal(plan.shell, true);
  assert.equal(runPlan(plan).argv.trim(), 'shell ran');
});

test('the launch line an operator reads survives argv (display only)', () => {
  const plan = buildHarnessCommand({ manifest, target: 'APP-14', actualVersion: '2.1.220' });
  assert.ok(plan);
  const line = describeHarnessPlan(plan);
  assert.ok(line.startsWith('claude "-p" '), line);
  // One log line: a raw prompt would put its newlines into the event text.
  assert.equal(line.includes('\n'), false, `launch line spans lines: ${line}`);
  assert.equal(
    describeHarnessPlan({ file: 'node fake.mjs', args: [], shell: true, notes: [] }),
    'node fake.mjs',
  );
});

test('parseVersion pulls the semver out of CLI banners', () => {
  assert.equal(parseVersion('2.1.220 (Claude Code)'), '2.1.220');
  assert.equal(parseVersion('no version here'), undefined);
});
