// Harness command derivation (#4): the exact launch line comes from the
// manifest + work-order target; the env override wins verbatim; version
// requirements are checked, never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnessCommand, describeHarnessPlan, versionSatisfies, parseVersion, OUTPUT_CONTRACT } from '../src/runner/harness.ts';
import { startMockDaemon } from './runner-mock-daemon.ts';

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

// --- The derived path where the runner actually spawns it (#241) ---
// The plan-level tests above spawn the plan themselves, so they re-state
// src/runner/main.ts's spawn options rather than exercising them, and every
// other runner and e2e test sets FLEET_HARNESS_CMD — the override branch, which
// still takes a shell on purpose. Nothing ran `spawn(plan.file, plan.args,
// { shell: plan.shell })` on the derived path, which is the line the fix lives
// on. This runs the real runner with no override.

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));

/**
 * A `claude` for PATH that answers the runner's `--version` probe and dumps the
 * argv of the real launch, entries separated by RS (0x1e) so a prompt's own
 * newlines stay inside their entry. Its output path arrives in a non-FLEET_ env
 * var: the runner strips every FLEET_* from the harness child's environment.
 */
function stubClaudeOnPath(): string {
  const bin = mkdtempSync(join(tmpdir(), 'fleet-derived-bin-'));
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.220 (Claude Code)"; exit 0; fi
: > "$HARNESS_ARGV_OUT"
for a in "$@"; do printf '%s\\036' "$a" >> "$HARNESS_ARGV_OUT"; done
`,
    { mode: 0o755 },
  );
  return bin;
}

test('the runner spawns the derived harness as argv — no shell at the spawn site (#241)', async () => {
  const token = 'test-token-derived-241';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-derived-ws-'));
  // Landing zone for the payload, outside the workspace the runner wipes.
  const loot = mkdtempSync(join(tmpdir(), 'fleet-derived-loot-'));
  const fromTarget = join(loot, 'from-target');
  const fromBacktick = join(loot, 'from-backtick');
  const fromBranch = join(loot, 'from-branch');
  const argvOut = join(loot, 'argv.rs');
  const bin = stubClaudeOnPath();
  try {
    mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
    writeFileSync(
      join(workspace, '.fleet', 'manifest.json'),
      JSON.stringify({
        version: 1,
        setup: { image: 'node:22', script: '.fleet/setup.sh' },
        workspace: { repo: 'git@github.com:acme/example.git', strategy: 'branch-per-job' },
        harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md' }] },
        gates: { pickup: `node -e "process.exit(0)"` },
      }),
    );
    // Both untrusted inputs at once: the dispatch target, and the branch name of
    // an adopted PR, which is chosen by whoever pushed the branch.
    writeFileSync(
      join(workspace, '.fleet', 'order.json'),
      JSON.stringify({
        target: 'audit why $HOME is wrong, `touch ' + fromBacktick + '` and $(touch ' + fromTarget + ')',
        finish: 'inspected',
        continues: { pr: 7, branch: `feat/$(touch ${fromBranch})` },
      }),
    );

    const { FLEET_GIT_URL: _u, FLEET_GIT_NAME: _n, FLEET_GIT_EMAIL: _e, ...parentEnv } = process.env;
    const child = spawn(process.execPath, [runnerMain], {
      env: {
        ...parentEnv,
        FLEET_JOB_ID: 'job-derived-241',
        FLEET_DAEMON_URL: daemon.url,
        FLEET_RUNNER_TOKEN: token,
        FLEET_WORKSPACE: workspace,
        // No FLEET_HARNESS_CMD: this is what makes it the derived path.
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HARNESS_ARGV_OUT: argvOut,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = Promise.withResolvers<number>();
    child.on('close', (code) => exited.resolve(code ?? -1));
    const exitCode = await exited.promise;

    assert.ok(existsSync(argvOut), 'the harness never received the argv the runner built');
    const argv = readFileSync(argvOut, 'utf8').split('\x1e').slice(0, -1);
    assert.equal(argv[0], '-p', `first arg is not the prompt flag: ${JSON.stringify(argv)}`);
    const prompt = argv[1];

    // Literal, character for character: nothing between buildHarnessCommand and
    // the harness process may interpret these.
    assert.ok(prompt.includes('$HOME'), `$HOME was expanded en route:\n${prompt}`);
    assert.ok(prompt.includes('`touch ' + fromBacktick + '`'), `backticks were consumed:\n${prompt}`);
    assert.ok(prompt.includes('$(touch ' + fromTarget + ')'), `target substitution was consumed:\n${prompt}`);
    assert.ok(prompt.includes(`branch feat/$(touch ${fromBranch})`), `branch substitution was consumed:\n${prompt}`);

    // And the payload itself, because a shell that mangles the argv may still
    // hand the harness a plausible-looking prompt.
    for (const marker of [fromTarget, fromBacktick, fromBranch]) {
      assert.equal(existsSync(marker), false, `a command ran inside the job container: ${marker}`);
    }

    // The rest of the launch arrived as its own argv entries, not as one string
    // something downstream would have to split.
    assert.ok(argv.includes('stream-json'), `launch argv did not survive intact: ${JSON.stringify(argv)}`);
    assert.equal(exitCode, 0);
    assert.deepEqual(daemon.rejected, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(loot, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    await daemon.close();
  }
});

// --- The operator's prompt (#240) ---
// Fleet used to compose `/<command> <target>` for every job, so the operator's
// own workflow became an argument to Fleet's. A work order may now carry the
// instruction itself; Fleet appends only what it owns.

test('an order prompt replaces the composed slash command and is used verbatim (#240)', () => {
  const plan = buildHarnessCommand({
    manifest,
    target: 'APP-14',
    prompt: '/dev-work #14 - land the parser, no refactors',
    actualVersion: '2.1.220',
  });
  assert.ok(plan);
  assert.deepStrictEqual(plan.args, [
    '-p', `/dev-work #14 - land the parser, no refactors\n\n${OUTPUT_CONTRACT}`,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Task', 'TodoWrite', 'WebSearch', 'WebFetch',
  ]);
  // The bug this catches: composing around the prompt instead of replacing the
  // composition — `/dev /dev-work #14 ...`, which is exactly #240's complaint.
  assert.equal(plan.args[1].includes('/dev /dev-work'), false, `the prompt became an argument to Fleet's command: ${plan.args[1]}`);
  assert.equal(plan.args[1].startsWith('/dev-work'), true, `something was prepended to the operator's prompt: ${plan.args[1]}`);
});

test('a prompted job derives even when the manifest declares no commands (#240)', () => {
  // harness.commands is the default prompt template and nothing else once an
  // order carries its own; failing the job over a field the launch line no
  // longer reads would be a manifest requirement with no consumer.
  const plan = buildHarnessCommand({
    manifest: { harness: { cli: 'claude-code' } },
    target: 'APP-14',
    prompt: 'read src/runner/harness.ts and write what it does to answer.md',
  });
  assert.ok(plan);
  assert.equal(plan.args[1], `read src/runner/harness.ts and write what it does to answer.md\n\n${OUTPUT_CONTRACT}`);
});

test('without a prompt the launch line is byte-identical to before #240', () => {
  // The compatibility contract: every manifest and every dispatch that predates
  // the field must be unaffected. Pinned against the literal, not against
  // another call to the same builder, so a builder that mangles both ways still
  // fails here.
  const expected = `/dev APP-14\n\n${OUTPUT_CONTRACT}`;
  assert.equal(buildHarnessCommand({ manifest, target: 'APP-14', actualVersion: '2.1.220' })?.args[1], expected);
  assert.equal(
    buildHarnessCommand({ manifest, target: 'APP-14', actualVersion: '2.1.220', prompt: undefined })?.args[1],
    expected,
    'an explicitly absent prompt took a different path from an omitted one',
  );
  assert.equal(
    buildHarnessCommand({ manifest, target: 'APP-14', actualVersion: '2.1.220', prompt: '' })?.args[1],
    expected,
    'an empty prompt is not an instruction — it must fall back, not launch a bare contract',
  );
});

test('a prompt does not change the dispatch shape: an adoption keeps its continuation clause (#240)', () => {
  // The shape comes from `target` and `continues`, never from the prompt. This
  // is the runner end of that invariant: an adopted job told what to do still
  // gets the clause that makes it push to the adopted branch instead of opening
  // a second PR.
  const plan = buildHarnessCommand({
    manifest,
    target: '77',
    prompt: '/dev-work #77',
    actualVersion: '2.1.220',
    continues: { pr: 41, branch: 'fleet/77-job-old' },
  });
  assert.ok(plan);
  const prompt = plan.args[1];
  assert.ok(prompt.startsWith('/dev-work #77 -- continuing PR #41 (branch fleet/77-job-old)'), `prompt or clause lost its place: ${prompt}`);
  assert.match(prompt, /gh pr checks 41/);
  assert.match(prompt, /never open a new PR/);
  assert.ok(prompt.endsWith(`\n\n${OUTPUT_CONTRACT}`), 'the output contract stopped riding on a prompted adoption');
});

test('an order prompt with shell metacharacters reaches the harness literally (#240 on #241)', async () => {
  // The prompt is the most operator-authored string in the whole order, and
  // backticks around identifiers and `$HOME` in a path are idiomatic prose. It
  // runs the real runner with no FLEET_HARNESS_CMD — the derived path — so it
  // also pins that src/runner/main.ts reads `prompt` off the order at all.
  const token = 'test-token-prompt-240';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-prompt-ws-'));
  const loot = mkdtempSync(join(tmpdir(), 'fleet-prompt-loot-'));
  const fromSubst = join(loot, 'from-subst');
  const fromBacktick = join(loot, 'from-backtick');
  const argvOut = join(loot, 'argv.rs');
  const bin = stubClaudeOnPath();
  const prompt = `/spec write a spec for \`parseVersion\` and $HOME handling $(touch ${fromSubst}) \`touch ${fromBacktick}\``;
  try {
    mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
    writeFileSync(
      join(workspace, '.fleet', 'manifest.json'),
      JSON.stringify({
        version: 1,
        setup: { image: 'node:22', script: '.fleet/setup.sh' },
        workspace: { repo: 'git@github.com:acme/example.git', strategy: 'branch-per-job' },
        harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md' }] },
        gates: { pickup: `node -e "process.exit(0)"` },
      }),
    );
    writeFileSync(
      join(workspace, '.fleet', 'order.json'),
      JSON.stringify({ target: '77', prompt, finish: 'inspected' }),
    );

    const { FLEET_GIT_URL: _u, FLEET_GIT_NAME: _n, FLEET_GIT_EMAIL: _e, ...parentEnv } = process.env;
    const child = spawn(process.execPath, [runnerMain], {
      env: {
        ...parentEnv,
        FLEET_JOB_ID: 'job-prompt-240',
        FLEET_DAEMON_URL: daemon.url,
        FLEET_RUNNER_TOKEN: token,
        FLEET_WORKSPACE: workspace,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HARNESS_ARGV_OUT: argvOut,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = Promise.withResolvers<number>();
    child.on('close', (code) => exited.resolve(code ?? -1));
    const exitCode = await exited.promise;

    assert.ok(existsSync(argvOut), 'the harness never received the argv the runner built');
    const argv = readFileSync(argvOut, 'utf8').split('\x1e').slice(0, -1);
    assert.equal(argv[0], '-p', `first arg is not the prompt flag: ${JSON.stringify(argv)}`);
    // The operator's prompt, character for character, at the head of the launch:
    // not composed into `/dev 77`, and not touched by a shell.
    assert.equal(argv[1], `${prompt}\n\n${OUTPUT_CONTRACT}`, `the order's prompt did not reach the harness intact:\n${argv[1]}`);
    for (const marker of [fromSubst, fromBacktick]) {
      assert.equal(existsSync(marker), false, `a command in the prompt ran inside the job container: ${marker}`);
    }
    assert.equal(exitCode, 0);
    assert.deepEqual(daemon.rejected, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(loot, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    await daemon.close();
  }
});
