/**
 * Harness command construction (issue #4): derive the exact headless launch
 * line from the manifest and the work order. FLEET_HARNESS_CMD (tests, exotic
 * setups) overrides everything and is used verbatim.
 */

export type HarnessPlan = {
  cmd: string;
  /** Non-fatal findings to surface as log events (version drift, fallbacks). */
  notes: string[];
};

// Phase 1: a fixed permissive tool grant — the sandbox is the blast-radius
// boundary; reach beyond it is governed by egress + broker in Phase 2, when
// this list gets generated from the manifest's services.
const CLAUDE_ALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Task', 'TodoWrite'];

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
};

/** Build the launch line, or undefined when no command can be derived. */
export function buildHarnessCommand({ manifest, target, override, actualVersion }: HarnessInputs): HarnessPlan | undefined {
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

  const prompt = JSON.stringify(`/${name} ${target}`);
  const tools = CLAUDE_ALLOWED_TOOLS.map((tool) => JSON.stringify(tool)).join(' ');
  return {
    cmd: `claude -p ${prompt} --output-format stream-json --verbose --allowedTools ${tools}`,
    notes,
  };
}
