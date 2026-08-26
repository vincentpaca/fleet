/**
 * The coding harnesses `fleet setup harness` can install the skill into — one
 * entry per harness Fleet knows a discovery convention for.
 *
 * Harnesses are Fleet's UI (docs/decisions.md#d8): integrating a new one is a
 * skill file over the CLI, never code. So this file is a map and nothing else —
 * where a harness looks for skills, how to tell it is installed here, and the
 * one sentence about its question mechanism that the canonical skill cannot
 * state harness-neutrally. ./setup.ts owns the reading, rendering and writing,
 * harness-agnostically, so a fourth harness is a new entry here rather than a
 * new branch over there.
 *
 * All three conventions converged on the same shape — a `<name>/SKILL.md`
 * directory with `name` and `description` frontmatter — which is why one
 * canonical file can drive every variant. Only the parent directory and the ask
 * mechanism differ, and those are the two fields below that vary.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Where a variant goes: a harness's own directory, per its convention. */
export type SkillScope = 'user' | 'project';

export type HarnessTarget = {
  /** Harness id, from the same vocabulary as manifest `harness.cli`. */
  id: string;
  /** How the harness is named to the operator. */
  label: string;
  /** The binary that proves it is installed. */
  binary: string;
  /** Config directory under the home dir, relative — its presence also proves installation. */
  configDir: string;
  /**
   * Directory holding skill directories, relative to the home dir (`user`) or
   * the project root (`project`). The skill's own directory goes inside it and
   * must be named for the skill: every one of these conventions requires the
   * frontmatter `name` to match its parent directory.
   */
  skillsDir: Record<SkillScope, string>;
  /**
   * How this harness asks the human — the decision→ask mapping, which is the one
   * thing the canonical skill states only generically. One sentence, imperative,
   * addressed to the agent that will read it.
   */
  ask: string;
};

export const HARNESS_TARGETS: HarnessTarget[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    binary: 'claude',
    configDir: '.claude',
    skillsDir: { user: path.join('.claude', 'skills'), project: path.join('.claude', 'skills') },
    ask: 'Use the AskUserQuestion tool: the decision\'s `question` as the question, one option per choice with its `label` verbatim, the recommended one marked as recommended in its description. Free text is always available alongside it — take the human\'s own words over the closest option when they differ.',
  },
  {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    // Codex reads skills from the cross-harness `.agents/skills` convention, and
    // keeps its own settings in ~/.codex — so installation and detection look at
    // different directories here, unlike the other two.
    configDir: '.codex',
    skillsDir: { user: path.join('.agents', 'skills'), project: path.join('.agents', 'skills') },
    ask: 'Codex has no structured question tool: print the decision\'s `question`, then the options as a numbered list with each `label` verbatim and the recommended one marked, and end your turn. The human answers in their next message; waiting is the mechanism, and a turn that continues past the question has answered it.',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    configDir: path.join('.config', 'opencode'),
    skillsDir: { user: path.join('.config', 'opencode', 'skills'), project: path.join('.opencode', 'skills') },
    ask: 'OpenCode has no structured question tool: print the decision\'s `question`, then the options as a numbered list with each `label` verbatim and the recommended one marked, and end your turn. The human answers in their next message; waiting is the mechanism, and a turn that continues past the question has answered it.',
  },
];

export function harnessFor(id: string): HarnessTarget | undefined {
  return HARNESS_TARGETS.find((h) => h.id === id);
}

/**
 * The absolute directory a variant is written to, skill directory included.
 * `name` is the skill's frontmatter name, because every convention requires the
 * directory to carry it — a mismatch is a skill the harness silently ignores.
 */
export function skillPath(
  harness: HarnessTarget,
  scope: SkillScope,
  name: string,
  roots: { home: string; cwd: string },
): string {
  const root = scope === 'user' ? roots.home : roots.cwd;
  return path.join(root, harness.skillsDir[scope], name, 'SKILL.md');
}

/**
 * Is `binary` an executable on this PATH?
 *
 * POSIX assumptions, stated rather than implied: the execute bit, and no
 * `PATHEXT` expansion. On Windows a `claude.cmd` is missed and detection falls
 * back to the config directory below — a weaker answer, not a wrong one.
 */
export function onPath(binary: string, env: Record<string, string | undefined>): boolean { // contract pin: test-only export, asserted by the suite
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    try {
      fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
      return true;
    } catch {
      // not here, or not executable — keep looking
    }
  }
  return false;
}

/** Why a harness counts as installed on this machine, or undefined when it does not. */
export function detectHarness(
  harness: HarnessTarget,
  opts: { env: Record<string, string | undefined>; home: string },
): string | undefined {
  if (onPath(harness.binary, opts.env)) return `${harness.binary} on PATH`;
  // A harness reached through a wrapper, an alias, or a not-yet-activated shell
  // still leaves its config directory behind, and refusing to install for it
  // because `which` came up empty is a wrong answer the operator cannot fix
  // without --harness. The directory is weaker evidence, so it says so.
  if (configDirIsEvidence(harness, opts.home)) return `${path.join('~', harness.configDir)} exists`;
  return undefined;
}

/**
 * Does this harness's config directory hold anything Fleet did not put there?
 *
 * The question is not "does it exist": for two of the three harnesses the skill
 * directory lives *inside* the config directory (`~/.claude/skills` under
 * `~/.claude`), so installing would create the evidence for its own next run —
 * `fleet setup harness --harness opencode` once, and every later run reports
 * OpenCode as found on a machine that has never had it. "Detects installed
 * harnesses" would then be a claim about Fleet's own footprint.
 *
 * An empty config directory is not evidence either: it proves a mkdir, not a
 * harness.
 */
function configDirIsEvidence(harness: HarnessTarget, home: string): boolean {
  const configDir = path.join(home, harness.configDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(configDir);
  } catch {
    return false; // absent, or not a directory we can read
  }
  const inside = path.relative(configDir, path.join(home, harness.skillsDir.user));
  // The one entry an install of ours could have created — undefined when this
  // harness keeps its skills outside its config dir, where nothing is ours.
  const ours = inside.startsWith('..') ? undefined : inside.split(path.sep)[0];
  return entries.some((entry) => entry !== ours);
}
