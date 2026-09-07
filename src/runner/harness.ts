/**
 * Harness command construction (issue #4): derive the exact headless launch
 * plan from the manifest and the work order. FLEET_HARNESS_CMD (tests, exotic
 * setups) overrides everything and is used verbatim.
 */

type HarnessPlan = {
  /** The executable on the derived path; the whole operator command line on the override path. */
  file: string;
  /** argv after `file`. Empty on the override path, which carries its arguments inside `file`. */
  args: string[];
  /** Whether `file` must go through `/bin/sh -c` — true only for the override (see buildHarnessCommand). */
  shell: boolean;
  /** Non-fatal findings to surface as log events (version drift, fallbacks). */
  notes: string[];
  /** Harness-dialect env defaults; the job's real env always wins on conflict. */
  env?: Record<string, string>;
};

// A fixed permissive tool grant: the sandbox is the blast-radius boundary;
// reach beyond it is governed by egress + a credential broker once they
// exist, at which point this list is generated from the manifest's services.
// WebSearch/WebFetch: research-shaped jobs are useless without them
// (#35's first run analyzed the wrong protocol from stale training data).
const CLAUDE_ALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Task', 'TodoWrite', 'WebSearch', 'WebFetch'];

/**
 * The output contract (issue #81), injected into every job's prompt by the
 * runner so it holds on every repo — including one with no fleet playbook at
 * all. Repo playbooks (like this repo's agents/dev.md) may add detail, but the
 * load-bearing instruction is this one. Pinned verbatim by
 * test/runner-harness.test.ts: rewording it is a deliberate contract change.
 */
export const OUTPUT_CONTRACT = // contract pin: test-only export, asserted by the suite
  'Fleet output contract: write every deliverable and any text answer as files under .fleet/out/artifacts/ (an answer is a file, e.g. answer.md). Files anywhere else are not collected.';

/** Leading semver from CLI output like "2.1.220 (Claude Code)". */
export function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0];
}

/** Numeric components of a dotted version string. */
function versionNums(v: string): number[] {
  return v.split('.').map((n) => Number(n));
}

/** Compare two numeric version arrays. Returns <0, 0, or >0. */
function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const ai = a[i] !== undefined ? a[i] : 0;
    const bi = b[i] !== undefined ? b[i] : 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

/**
 * Does an actual version satisfy the manifest's cli_version?
 * Supports ">=x.y.z" and exact-prefix pins ("2.1"); anything else is
 * reported unsatisfiable rather than guessed.
 */
export function versionSatisfies(actual: string, requirement: string): boolean | undefined { // contract pin: test-only export, asserted by the suite
  const want = requirement.trim();
  if (want.startsWith('>=')) {
    const min = parseVersion(want);
    if (!min) return undefined;
    return compareVersion(versionNums(actual), versionNums(min)) >= 0;
  }
  if (/^\d+(\.\d+)*$/.test(want)) return actual === want || actual.startsWith(`${want}.`);
  return undefined;
}

type HarnessInputs = {
  manifest: Record<string, unknown>;
  /** The job's identity. Not part of the launch line any more (#240) — kept for callers' shape. */
  target?: string;
  /** FLEET_HARNESS_CMD, when set. */
  override?: string;
  /** Actual CLI version when measurable (runner probes `claude --version`). */
  actualVersion?: string;
  /**
   * Followthrough continuation (issue #80): the adopted PR and branch from the
   * work order. The prompt tells the agent to address that PR's feedback with
   * gh itself — no runner-side feedback plumbing exists on purpose.
   */
  continues?: { pr: number; branch: string };
  /**
   * The work order's `prompt` (#240): what the operator wants done, used
   * verbatim as the launch line. Required: Fleet composes no instruction of its
   * own any more, so an order without one has no job to run. Fleet still
   * appends what it owns — the continuation clause and the output contract —
   * because those are guarantees of the pipe, not of the instruction. It is
   * operator text, so it must reach the harness as literal characters; the
   * derived plan is argv and never sees a shell (#241).
   */
  prompt?: string;
};

/** Append version-drift notes when an actual version is measurable and required. */
function checkVersionNotes(actualVersion: string | undefined, required: string | undefined, notes: string[]): void {
  if (!required || !actualVersion) return;
  const satisfied = versionSatisfies(actualVersion, required);
  if (satisfied === false) notes.push(`harness cli ${actualVersion} violates manifest cli_version ${required}`);
  if (satisfied === undefined) notes.push(`cannot evaluate cli_version requirement "${required}" against ${actualVersion}`);
}

/**
 * Build the adopted-PR continuation clause, or empty string.
 *
 * `continues.branch` is a headRefName the CLI read from `gh pr view`, so its
 * text is chosen by whoever pushed the branch, not by the operator dispatching
 * the job — which is why it must never reach a shell (#241). A fork's PR is NOT
 * the reach, contrary to what 1c9f6ad's commit body says: src/runner/main.ts
 * runs setupWorkspace before it builds this prompt, and adoption checks the
 * branch out with `git fetch origin <branch>`, which fails for a branch that is
 * not on origin, so the job dies before the clause exists. The reach is a branch
 * pushed to origin (anyone with push access) plus targets an operator types.
 */
function continuationClause(continues: { pr: number; branch: string } | undefined): string {
  if (!continues) return '';
  return (
    ` -- continuing PR #${continues.pr} (branch ${continues.branch}):` +
    ` read that PR's review comments and failing checks with gh (gh pr view ${continues.pr} --comments; gh pr checks ${continues.pr})` +
    ` and address them. Push fixes to the same branch so the PR updates in place; never open a new PR.`
  );
}

/**
 * How each supported CLI takes an instruction with no human at the keyboard,
 * as argv (#241 — never a shell string, because the instruction is operator
 * text). Every row is one this repo has actually run a job through end to end
 * (test/e2e-foreign-repo.ts); a CLI absent from here is unlaunchable and the
 * operator's route is FLEET_HARNESS_CMD.
 *
 * Fleet owns the headless and approval flags only. It does not pick a model —
 * that is `harness.model` when the CLI needs one, and the CLI's own default
 * otherwise.
 */
const DIALECTS: Record<string, (prompt: string, model?: string) => { file: string; args: string[]; env?: Record<string, string> }> = {
  'claude-code': (prompt, model) => ({
    file: 'claude',
    args: [
      '-p', prompt,
      '--output-format', 'stream-json', '--verbose',
      ...(model ? ['--model', model] : []),
      '--allowedTools', ...CLAUDE_ALLOWED_TOOLS,
    ],
    // claude-code caps a single response at 32k output tokens by default; a
    // whole-file Write can exceed it and kill the job (observed on #28).
    // Dialect knob, so it lives here — never in the manifest.
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
  }),
  codex: (prompt) => ({ file: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt] }),
  opencode: (prompt, model) => ({ file: 'opencode', args: ['run', ...(model ? ['--model', model] : []), prompt] }),
  omp: (prompt, model) => ({ file: 'omp', args: ['-p', '--auto-approve', ...(model ? ['--model', model] : []), prompt] }),
};

/**
 * FLEET_HARNESS_CMD: a command line an operator wrote — pipes, redirects and
 * `node -e "..."` are the point of it — so it stays a shell string and runs
 * verbatim. The derived plan never does: its instruction comes from a work
 * order and its branch name from whoever opened the PR (#241).
 *
 * An override is the entire launch line, so a work-order prompt has nowhere to
 * go; splicing it in would put operator text back inside a shell string. It is
 * dropped, and said out loud — the operator typed it and would otherwise spend
 * the job wondering why it had no effect.
 */
function overridePlan(override: string, prompt: string | undefined): HarnessPlan {
  const notes = prompt
    ? ['FLEET_HARNESS_CMD is set, so it is the whole launch line and the work order prompt was not used']
    : [];
  return { file: override, args: [], shell: true, notes };
}

/** Build the launch plan, or undefined when no command can be derived. */
export function buildHarnessCommand({ manifest, override, actualVersion, continues, prompt }: HarnessInputs): HarnessPlan | undefined {
  // The two paths diverge here, deliberately. FLEET_HARNESS_CMD is a command
  // line an operator wrote — pipes, redirects and `node -e "..."` are the point
  // of it — so it stays a shell string and runs verbatim. The derived plan
  // below is argv and never sees a shell: its target comes from a work order
  // and, on an adoption, its branch name comes from whoever opened the PR, so a
  // `$(...)` in either used to execute inside the job container (#241).
  if (override) return overridePlan(override, prompt);

  const harness = (manifest.harness ?? {}) as Record<string, unknown>;
  const cli = typeof harness.cli === 'string' ? harness.cli : 'claude-code';
  const notes: string[] = [];

  const required = typeof harness.cli_version === 'string' ? harness.cli_version : undefined;
  checkVersionNotes(actualVersion, required, notes);

  const dialect = DIALECTS[cli];
  if (!dialect) return undefined; // an unknown cli has no headless invocation to guess at

  // The instruction is the operator's, always (#240). Fleet used to compose
  // `/<harness.commands[0]> <target>` when the order carried no prompt, which
  // is how a repo with four workflows could only ever reach the first one, and
  // how Fleet ended up choosing the verb — the harness's job, not the pipe's
  // (D8). There is no fallback now: an order with no prompt is underivable, and
  // the CLI refuses to build one, so this is a guard rather than a path.
  if (prompt === undefined || prompt === '') return undefined;

  // The output contract (#81) and the continuation clause ride on every prompt,
  // operator-written included: a continuation that produces a report instead of
  // commits still owes its deliverables to the artifact lane, and an adoption is
  // still an adoption whoever wrote the instruction.
  const promptText = `${prompt}${continuationClause(continues)}\n\n${OUTPUT_CONTRACT}`;
  const model = typeof harness.model === 'string' ? harness.model : undefined;
  if (cli !== 'claude-code') notes.push(`harness ${cli}: only claude-code streams a transcript; expect events at settle only`);
  return { ...dialect(promptText, model), shell: false, notes };
}

/**
 * The launch plan as an operator reads it in the log. Display only: the derived
 * plan is spawned as argv, so anything that parsed this string back into a
 * command would reintroduce the shell the argv exists to avoid. Arguments are
 * JSON-quoted so a prompt's newlines stay on one line and an argument boundary
 * is visible.
 */
export function describeHarnessPlan(plan: HarnessPlan): string {
  if (plan.shell) return plan.file;
  return [plan.file, ...plan.args.map((arg) => JSON.stringify(arg))].join(' ');
}
