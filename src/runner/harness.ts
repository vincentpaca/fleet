/**
 * Harness command construction (issue #4): derive the exact headless launch
 * line from the manifest and the work order. FLEET_HARNESS_CMD (tests, exotic
 * setups) overrides everything and is used verbatim.
 */

export type HarnessPlan = {
  cmd: string;
  /** Non-fatal findings to surface as log events (version drift, fallbacks). */
  notes: string[];
  /** Harness-dialect env defaults; the job's real env always wins on conflict. */
  env?: Record<string, string>;
};

// Phase 1: a fixed permissive tool grant — the sandbox is the blast-radius
// boundary; reach beyond it is governed by egress + broker in Phase 2, when
// this list gets generated from the manifest's services.
// WebSearch/WebFetch: assess-mode research jobs are useless without them
// (#35's first run analyzed the wrong protocol from stale training data).
const CLAUDE_ALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Task', 'TodoWrite', 'WebSearch', 'WebFetch'];

/**
 * The output contract (issue #81), injected into every job's prompt by the
 * runner so it holds on every repo — including one with no fleet playbook at
 * all. Repo playbooks (like this repo's agents/dev.md) may add detail, but the
 * load-bearing instruction is this one. Pinned verbatim by
 * test/runner-harness.test.ts: rewording it is a deliberate contract change.
 */
export const OUTPUT_CONTRACT =
  'Fleet output contract: write every deliverable and any text answer as files under .fleet/out/artifacts/ (an answer is a file, e.g. answer.md). Files anywhere else are not collected.';

/** Leading semver from CLI output like "2.1.220 (Claude Code)". */
export function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0];
}

/**
 * Does an actual version satisfy the manifest's cli_version?
 * Supports ">=x.y.z" and exact-prefix pins ("2.1"); anything else is
 * reported unsatisfiable rather than guessed.
 */
export function versionSatisfies(actual: string, requirement: string): boolean | undefined {
  const want = requirement.trim();
  const nums = (v: string) => v.split('.').map((n) => Number(n));
  if (want.startsWith('>=')) {
    const min = parseVersion(want);
    if (!min) return undefined;
    const [a, b] = [nums(actual), nums(min)];
    for (let i = 0; i < 3; i++) {
      if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
      if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
    }
    return true;
  }
  if (/^\d+(\.\d+)*$/.test(want)) return actual === want || actual.startsWith(`${want}.`);
  return undefined;
}

export type HarnessInputs = {
  manifest: Record<string, unknown>;
  target: string;
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
};

/** Build the launch line, or undefined when no command can be derived. */
export function buildHarnessCommand({ manifest, target, override, actualVersion, continues }: HarnessInputs): HarnessPlan | undefined {
  if (override) return { cmd: override, notes: [] };

  const harness = (manifest.harness ?? {}) as Record<string, unknown>;
  const cli = typeof harness.cli === 'string' ? harness.cli : 'claude-code';
  const notes: string[] = [];

  const required = typeof harness.cli_version === 'string' ? harness.cli_version : undefined;
  if (required && actualVersion) {
    const satisfied = versionSatisfies(actualVersion, required);
    if (satisfied === false) notes.push(`harness cli ${actualVersion} violates manifest cli_version ${required}`);
    if (satisfied === undefined) notes.push(`cannot evaluate cli_version requirement "${required}" against ${actualVersion}`);
  }

  if (cli !== 'claude-code') return undefined; // adapters for other CLIs arrive with demand

  const commands = Array.isArray(harness.commands) ? harness.commands : [];
  const first = commands[0] as { path?: string } | undefined;
  if (!first?.path) return undefined;
  // .claude/commands/dev.md -> /dev — the repo's own slash command, which the
  // CLI discovers from the cloned workspace.
  const name = first.path.split('/').pop()?.replace(/\.md$/, '');
  if (!name) return undefined;

  // Continuation (#80): the workspace is already on the adopted PR branch; the
  // agent reads the PR's review comments and failing checks with gh itself.
  // No shell-special characters here — the prompt rides inside double quotes.
  const continuation = continues
    ? ` -- followthrough on PR #${continues.pr} (branch ${continues.branch}):` +
      ` read that PR's review comments and failing checks with gh (gh pr view ${continues.pr} --comments; gh pr checks ${continues.pr})` +
      ` and address them. Push fixes to the same branch so the PR updates in place; never open a new PR.`
    : '';
  // The output contract (#81) rides on every prompt, continuation included: a
  // followthrough that produces a report instead of commits still owes its
  // deliverables to the artifact lane.
  const prompt = JSON.stringify(`/${name} ${target}${continuation}\n\n${OUTPUT_CONTRACT}`);
  const tools = CLAUDE_ALLOWED_TOOLS.map((tool) => JSON.stringify(tool)).join(' ');
  return {
    cmd: `claude -p ${prompt} --output-format stream-json --verbose --allowedTools ${tools}`,
    notes,
    // claude-code caps a single response at 32k output tokens by default; a
    // whole-file Write can exceed it and kill the job (observed on #28).
    // Dialect knob, so it lives here — never in the manifest.
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
  };
}
