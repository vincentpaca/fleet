// Harness command derivation (#4): the exact launch line comes from the
// manifest + work-order target; the env override wins verbatim; version
// requirements are checked, never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHarnessCommand, versionSatisfies, parseVersion, OUTPUT_CONTRACT } from '../src/runner/harness.ts';

const manifest = {
  harness: {
    cli: 'claude-code',
    cli_version: '>=2.1.0',
    commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
  },
};

test('derives the claude-code launch line from the first command and the target', () => {
  const plan = buildHarnessCommand({ manifest, target: 'APP-14', actualVersion: '2.1.220' });
  assert.ok(plan);
  assert.equal(
    plan.cmd,
    `claude -p ${JSON.stringify(`/dev APP-14\n\n${OUTPUT_CONTRACT}`)} --output-format stream-json --verbose --allowedTools "Bash" "Edit" "Write" "Read" "Glob" "Grep" "Task" "TodoWrite" "WebSearch" "WebFetch"`,
  );
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
  // The contract rides inside the -p prompt (JSON-encoded on the launch line),
  // so it reaches the agent on repos with no fleet playbook at all.
  assert.ok(
    plan.cmd.includes(JSON.stringify(`/dev APP-14\n\n${OUTPUT_CONTRACT}`)),
    `contract missing from launch line: ${plan.cmd}`,
  );
});

test('override wins verbatim, no notes, no derivation', () => {
  const plan = buildHarnessCommand({ manifest, target: 'APP-14', override: 'node fake-harness.mjs' });
  assert.deepStrictEqual(plan, { cmd: 'node fake-harness.mjs', notes: [] });
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
  assert.match(plan.cmd, /followthrough on PR #41 \(branch fleet\/77-job-old\)/);
  assert.match(plan.cmd, /review comments and failing checks/);
  assert.match(plan.cmd, /gh pr checks 41/, 'the agent is told to use gh itself — no runner-side feedback plumbing');
  assert.match(plan.cmd, /never open a new PR/);
  // The bug this catches: continuation text leaking into ordinary dispatches,
  // which would send every implement job hunting for a PR that does not exist.
  const plain = buildHarnessCommand({ manifest, target: '77', actualVersion: '2.1.220' });
  assert.ok(plain);
  assert.doesNotMatch(plain.cmd, /followthrough on PR/);
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

test('parseVersion pulls the semver out of CLI banners', () => {
  assert.equal(parseVersion('2.1.220 (Claude Code)'), '2.1.220');
  assert.equal(parseVersion('no version here'), undefined);
});
