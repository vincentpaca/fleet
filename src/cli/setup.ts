/**
 * `fleet setup` — the CLI owns standing Fleet up (issue #13).
 *
 * Standing up the substrate used to be a raw terraform workflow with a manual
 * handoff at the end: apply an example root by hand, remember to capture
 * `fleet_config` into the right file, remember which local port you picked.
 * Every step of that is knowledge Fleet already has, so Fleet does it.
 *
 * Interactive first. Because Fleet authors the infra shape (docs/decisions.md#d12),
 * the wizard can ask for only what the contract cannot assume — the unit's
 * prompt list is in ./setup-units.ts and is deliberately short. Flags exist as
 * overrides for headless callers (CI, agents), never as the primary surface:
 * anything a prompt asks, a flag can pre-supply, and with no terminal and a
 * missing value the command exits naming it rather than blocking on a read that
 * will never return.
 *
 * Nothing here is cloud-specific. This file interviews, generates a root module,
 * drives terraform, and captures the deployment description; which questions to
 * ask and which credentials to prove belong to the unit.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createIfAbsent } from '../shared/fs.ts';
import { gitValue } from '../shared/git.ts';
import { toHttpsGitUrl } from '../shared/giturl.ts';
import { chooseLocalPort } from './connect.ts';
import { splitList } from './setup-units.ts';
import type { Answers, PromptSpec, SetupUnit } from './setup-units.ts';
import {
  HARNESS_TARGETS,
  detectHarness,
  harnessFor,
  skillPath,
  type HarnessTarget,
  type SkillScope,
} from './setup-harnesses.ts';

/** Thrown for every refusal, so one surface reports them all identically. */
export class SetupError extends Error {}

// ---------- asking ----------

/** Reads one answer at a time. Injected so the merge logic is testable without a terminal. */
type Asker = {
  question: (prompt: string) => Promise<string>;
  close: () => void;
};

/**
 * An asker over stdin, reading one line per question.
 *
 * The line iterator rather than `rl.question`: a wizard asks several questions
 * in a row, and on non-terminal input readline delivers every buffered line as
 * soon as it arrives — `question` takes the first and the rest are dropped on
 * the floor, so the second question sees an input that has already ended. The
 * iterator applies backpressure and hands over exactly one line at a time,
 * which makes a piped answer script behave the way a typing human does.
 *
 * Input that runs out is an error, never a wait: "never hang waiting for input"
 * has to hold for a stdin that ends mid-interview too, not only for no stdin.
 */
async function stdinAsker(): Promise<Asker> {
  const readline = await import('node:readline/promises'); // lazy: only when there is someone to ask
  // No `output`: the prompt text is written by the caller, so every line the
  // wizard prints goes through one path and tests can read it from stdout.
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  return {
    question: async (prompt: string): Promise<string> => {
      process.stdout.write(prompt);
      const next = await lines.next();
      if (next.done) throw new SetupError('stdin ended before the wizard finished');
      return next.value;
    },
    close: () => rl.close(),
  };
}

/** One prompt's rendered question line: what is asked, and what Enter accepts. */
function promptLine(spec: PromptSpec, fallback: string | undefined): string {
  if (fallback === undefined) return `${spec.question}: `;
  if (fallback === '') return `${spec.question} [none]: `;
  return `${spec.question} [${fallback}]: `;
}

type InterviewOptions = {
  /** Values pre-supplied by flags, keyed by prompt key. */
  flags: Record<string, string | undefined>;
  env: Record<string, string | undefined>;
  /** Present when there is a terminal to ask on; absent means headless. */
  ask?: Asker;
  log: (line: string) => void;
};

type Interview = {
  answers: Answers;
  /** Flags a headless caller had to supply and did not, in prompt order. */
  missing: string[];
};

/**
 * Merge flags and prompts into one set of answers.
 *
 * The two paths must agree on everything except where a value came from, so
 * they share this function rather than each owning a copy of the rules: a flag
 * always wins, a validator always runs (a bad `--region` is caught at the same
 * place a bad typed region is), and a prompt that a previous answer made
 * irrelevant is skipped in both. Headless, a value with no flag and no fallback
 * is collected rather than thrown on, so one exit can name every missing flag
 * instead of the operator discovering them one rerun at a time.
 */
export async function interview(prompts: PromptSpec[], opts: InterviewOptions): Promise<Interview> { // contract pin: test-only export, asserted by the suite
  const answers: Answers = {};
  const missing: string[] = [];

  for (const spec of prompts) {
    if (spec.when && !spec.when(answers)) continue;
    const fallback = spec.fallback?.(opts.env);

    const supplied = opts.flags[spec.key];
    if (supplied !== undefined) {
      const rejection = spec.validate?.(supplied);
      if (rejection) throw new SetupError(`--${flagName(spec.key)}: ${rejection}`);
      answers[spec.key] = supplied;
      continue;
    }

    if (!opts.ask) {
      // A fallback has to survive the same validator a typed answer meets. An
      // extracted default is a guess about the repo — `.claude/commands/dev.md`
      // when nothing was found — and headless, accepting a guess that fails
      // validation writes a broken manifest instead of naming the flag.
      const usable = fallback !== undefined && !(spec.required && fallback === '');
      const rejection = usable && fallback !== '' ? spec.validate?.(fallback) : undefined;
      if (usable && !rejection) {
        answers[spec.key] = fallback;
        continue;
      }
      missing.push(
        rejection ? `--${flagName(spec.key)} (default "${fallback}" rejected: ${rejection})` : `--${flagName(spec.key)}`,
      );
      // Keep going: the point of collecting is to name them all at once. The
      // key stays unset — so a `when` predicate must treat "absent" as "no", the
      // way `!answers.vpc_id` does; comparing to '' would read a missing answer
      // as a real one.
      continue;
    }

    answers[spec.key] = await askOne(spec, fallback, opts);
  }

  // A flag whose prompt never ran is a description of infrastructure the
  // operator will not get. Silence there is the dangerous kind: `--subnet-ids`
  // without `--vpc-id` reads as "deploy into my network" and would apply a
  // brand-new VPC instead, and with --yes nobody reads the plan.
  const unused = Object.entries(opts.flags)
    .filter(([key, value]) => value !== undefined && answers[key] === undefined)
    .map(([key]) => `--${flagName(key)}`);
  if (unused.length > 0) {
    throw new SetupError(
      `${unused.join(' ')}: the other answers make ${unused.length === 1 ? 'that question' : 'those questions'} irrelevant, so ${unused.length === 1 ? 'it was' : 'they were'} never asked\n` +
        '  supply what they depend on, or drop them — applying while ignoring a value you passed is how you get infrastructure you did not describe',
    );
  }

  return { answers, missing };
}

/** Ask until the answer is one the unit accepts. Enter takes the fallback. */
async function askOne(spec: PromptSpec, fallback: string | undefined, opts: InterviewOptions): Promise<string> {
  if (spec.hint) opts.log(`  ${spec.hint}`);
  for (;;) {
    const typed = (await opts.ask!.question(promptLine(spec, fallback))).trim();
    const value = typed === '' && fallback !== undefined ? fallback : typed;
    if (value === '' && spec.required) {
      opts.log('  required — this one has no sensible default');
      continue;
    }
    const rejection = value === '' ? undefined : spec.validate?.(value);
    if (rejection) {
      opts.log(`  ${rejection}`);
      continue;
    }
    return value;
  }
}

/** `subnet_ids` → `subnet-ids`: answer keys are terraform-shaped, flags are CLI-shaped. */
export function flagName(key: string): string {
  return key.replaceAll('_', '-');
}

/** A yes/no gate. Anything but an explicit yes is a no — the default protects the account. */
async function confirm(question: string, ask: Asker): Promise<boolean> {
  const answer = (await ask.question(`${question} [y/N]: `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

// ---------- the .fleet/ scaffold ----------

export const SETUP_STUB = `#!/usr/bin/env sh
# Fleet setup script: everything the job image needs before the harness runs
# (dependencies, build, seed data). Runs with unrestricted egress.
set -eu

echo "fleet setup: replace this stub with your project's setup steps (e.g. npm ci)"
`;

// Runtime and per-deployment artifacts never belong in the user's repo:
// out/ is the job's decision/answer/report channel; infra/ holds generated
// terraform + local state + the per-deployment fleet-config.json (two people
// on the same repo can point at different infra). .env holds secrets — only
// .env.example (the key template) belongs in git. dispatched.jsonl is a
// local pointer ledger — per-checkout, never shared.
const FLEET_GITIGNORE = `out/
infra/
.env
dispatched.jsonl
`;

// Template only — the operator fills in real values in .fleet/.env (gitignored).
const DOT_ENV_EXAMPLE = `# Repo-local env — copy to .env and fill in real values.
# .env is gitignored; this file is the template that lives in the repo.
# Declare the same keys in manifest.json env.vars so Fleet picks them up.
# EXAMPLE_VAR=replace-with-real-value
`;

/**
 * Make sure `.fleet/.gitignore` covers `required`, creating it with the full
 * default set when it does not exist yet. Both scaffolding paths go through
 * here — `fleet init` cares about `.env`, `fleet setup infra` about `infra/` —
 * because an entry that only one of them knows about is an entry that leaks
 * into the repo depending on which command the operator happened to run.
 *
 * Entries already covered by their root-anchored form (`/.env`) are left alone.
 */
function ensureFleetGitignore(fleetDir: string, required: string[]): void {
  fs.mkdirSync(fleetDir, { recursive: true });
  const gitignorePath = path.join(fleetDir, '.gitignore');
  if (createIfAbsent(gitignorePath, FLEET_GITIGNORE)) return;
  let current = fs.readFileSync(gitignorePath, 'utf8');
  for (const entry of required) {
    const lines = current.split('\n').map((l) => l.trim());
    if (lines.includes(entry) || lines.includes(`/${entry}`)) continue;
    const addition = current.endsWith('\n') ? `${entry}\n` : `\n${entry}\n`;
    fs.appendFileSync(gitignorePath, addition);
    current += addition;
  }
}

/**
 * Write the parts of `.fleet/` that are the same however the manifest was
 * produced: the manifest itself, the out/ channel, the setup script, the
 * gitignore, and the .env template. Existing files are never clobbered —
 * `fleet init` and `fleet setup repo` each decide separately whether writing
 * the manifest is allowed, and by the time they call this, they have.
 *
 * Returns one line per file, for whoever is doing the printing.
 */
export function writeScaffold(
  fleetDir: string,
  manifest: unknown,
  setupScript: string | undefined,
): string[] {
  const written: string[] = [];
  const manifestPath = path.join(fleetDir, 'manifest.json');
  fs.mkdirSync(path.join(fleetDir, 'out'), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  written.push(`wrote ${manifestPath}`);

  const setupPath = path.join(fleetDir, 'setup.sh');
  const wroteSetup = createIfAbsent(setupPath, setupScript ?? SETUP_STUB, { mode: 0o755 });
  written.push(`${wroteSetup ? 'wrote' : 'kept existing'} ${setupPath}`);

  const gitkeepPath = path.join(fleetDir, 'out', '.gitkeep');
  createIfAbsent(gitkeepPath, '');
  written.push(`wrote ${gitkeepPath}`);

  // The whole default set, not just `.env`: a hand-written .fleet/.gitignore
  // that covers one entry left `out/`, `infra/` and `dispatched.jsonl`
  // committable, and which of those leaked depended on which command the
  // operator happened to run first.
  ensureFleetGitignore(fleetDir, FLEET_GITIGNORE.split('\n').filter(Boolean));
  const dotEnvExamplePath = path.join(fleetDir, '.env.example');
  createIfAbsent(dotEnvExamplePath, DOT_ENV_EXAMPLE);
  return written;
}

// ---------- where the terraform module comes from ----------

/**
 * `infra/` ships by git source, never in the npm package (README, "Using Fleet
 * vs. building Fleet"), so the generated root module has to name a git ref —
 * and a floating one would silently re-shape a deployment on the next apply.
 *
 * Resolution, most authoritative first: the flag, the environment, then this
 * Fleet's own checkout pinned at the exact version you are running — a tag when
 * HEAD carries one, the commit otherwise. There is no fourth guess: an install
 * with no `infra/` beside it and no override cannot know which fork or ref is
 * yours, and inventing one would generate terraform that applies somebody
 * else's infrastructure into your account.
 */
export function resolveModuleSource(opts: { // contract pin: test-only export, asserted by the suite
  provider: string;
  flag?: string;
  env: Record<string, string | undefined>;
  /** Root of this Fleet installation (the directory holding `infra/`). */
  root: string;
  /** `git -C root …` → trimmed stdout, or undefined on any failure. */
  git?: (args: string[]) => string | undefined;
}): string {
  const override = opts.flag ?? opts.env.FLEET_MODULE_SOURCE;
  if (override) return override;

  const unitDir = path.join(opts.root, 'infra', opts.provider);
  const git = opts.git ?? ((args: string[]) => gitValue(args, opts.root));
  if (fs.existsSync(path.join(unitDir, 'main.tf'))) {
    const origin = git(['remote', 'get-url', 'origin']);
    const ref = git(['describe', '--tags', '--exact-match']) ?? git(['rev-parse', 'HEAD']);
    // Only a URL terraform can actually fetch. `toHttpsGitUrl` normalises
    // github.com and leaves every other host alone, so an ssh remote elsewhere
    // would otherwise be pasted into the module source as `git@host:org/repo` —
    // not a source terraform understands, discovered at `init` rather than here.
    const url = origin === undefined ? undefined : toHttpsGitUrl(origin);
    if (url && ref && /^(https?|ssh):\/\//.test(url)) {
      return `git::${url.replace(/\.git$/, '')}.git//infra/${opts.provider}?ref=${ref}`;
    }
  }

  throw new SetupError(
    `cannot tell which Fleet terraform module to use for ${opts.provider}: this installation has no infra/${opts.provider}/ beside it with a git remote to pin\n` +
      `  pass --module-source <source> (a git source such as git::https://github.com/<org>/fleet.git//infra/${opts.provider}?ref=<tag>, or the path to a Fleet checkout's infra/${opts.provider})`,
  );
}

// ---------- generating the root module ----------

/** Render `key = value` lines with the `=` aligned, the way `terraform fmt` would. */
function alignedArgs(args: Array<[string, string]>, indent: string): string {
  const width = Math.max(0, ...args.map(([key]) => key.length));
  return args.map(([key, value]) => `${indent}${key.padEnd(width)} = ${value}`).join('\n');
}

type RenderOptions = {
  unit: SetupUnit;
  answers: Answers;
  moduleSource: string;
  /** Backend type for `terraform { backend "<type>" {} }`; local state when absent. */
  backend?: string;
  /** Written into the header so a reader knows what produced the file. */
  version: string;
};

/**
 * The root module `fleet setup infra` writes to `.fleet/infra/<provider>/main.tf`.
 *
 * It is a root module, not a copy of the unit: the unit stays in Fleet's repo at
 * a pinned ref, and this file is the handful of values that are the operator's.
 * It is generated rather than hand-written and is regenerated by a rerun, so it
 * says so at the top — and it is gitignored, because two people on one repo
 * legitimately point at different deployments.
 *
 * `fleet_config` is re-exported because module outputs are not addressable from
 * a root module: without the passthrough, the capture that every other Fleet
 * command depends on cannot be read at all.
 */
export function renderMainTf(opts: RenderOptions): string { // contract pin: test-only export, asserted by the suite
  const { unit, answers } = opts;
  const providers = unit.requiredProviders
    .map((p) => `    ${p.name} = {\n      source  = ${JSON.stringify(p.source)}\n      version = ${JSON.stringify(p.version)}\n    }`)
    .join('\n');
  const backendBlock = opts.backend ? `\n  backend ${JSON.stringify(opts.backend)} {}\n` : '';

  return `# Generated by \`fleet setup infra\` (fleet ${opts.version}) — regenerated by a rerun.
# Edit it if you must, but a rerun of the wizard overwrites it; the durable
# record of this deployment is the terraform state beside it and the
# fleet-config.json capture the CLI reads.

terraform {
  required_version = ">= ${MIN_TERRAFORM}"
${backendBlock}
  required_providers {
${providers}
  }
}

provider ${JSON.stringify(unit.requiredProviders[0].name)} {
${alignedArgs(unit.providerArgs(answers), '  ')}
}

module "fleet" {
  source = ${JSON.stringify(opts.moduleSource)}

${alignedArgs(unit.moduleArgs(answers), '  ')}
}

# Module outputs are not addressable from a root module, so these passthroughs
# are what make \`terraform output\` — and therefore fleet-config.json — work.
output "fleet_config" {
  value = module.fleet.fleet_config
}

output "connect_hint" {
  value = module.fleet.connect_hint
}
`;
}

// ---------- running terraform ----------

type RunResult = { status: number; stdout: string; stderr: string; missing: boolean };

/**
 * Run a command for setup. `capture` reads stdout (JSON we parse); without it
 * the child inherits this terminal, because a terraform plan is for the
 * operator to read, and relaying it through us would only make it worse.
 */
type Runner = (argv: string[], opts: { cwd: string; capture?: boolean }) => RunResult;

const spawnRunner: Runner = (argv, opts) => {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  const missing = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  // stderr only exists for captured runs; an inherited one already reached the
  // terminal, and reporting it twice is worse than not having it.
  return { status: missing ? -1 : (res.status ?? -1), stdout: res.stdout ?? '', stderr: res.stderr ?? '', missing };
};

/**
 * Everything that must be true before the first question. A wizard that
 * collects five answers and then dies on a missing binary wasted the interview,
 * and — worse — an operator who answers "name" three times learns nothing about
 * why nothing is being created.
 */
function preflight(unit: SetupUnit, cwd: string, run: Runner): void {
  const terraform = run(['terraform', 'version'], { cwd, capture: true });
  if (terraform.missing) {
    throw new SetupError(
      'terraform is not on PATH — install it (https://developer.hashicorp.com/terraform/install), then rerun',
    );
  }
  if (terraform.status !== 0) throw new SetupError(`terraform is on PATH but \`terraform version\` failed (exit ${terraform.status})`);
  // The version is read, not just proven present: the module we generate
  // declares `required_version`, so an older terraform passes this preflight
  // and dies at `init` — after the whole interview, which is precisely what
  // preflighting exists to prevent.
  const tooOld = terraformTooOld(terraform.stdout);
  if (tooOld) throw new SetupError(tooOld);

  const creds = run(unit.credentials.argv, { cwd, capture: true });
  if (creds.missing) throw new SetupError(unit.credentials.absent);
  if (creds.status !== 0) throw new SetupError(unit.credentials.denied);
}

/**
 * Minimum terraform the generated root module declares — one constant, because
 * a `required_version` the preflight does not know about is a check that only
 * runs after the interview.
 */
export const MIN_TERRAFORM = '1.5.0'; // contract pin: test-only export, asserted by the suite

/**
 * Rejection message when `terraform version`'s output names a version older
 * than the generated module requires; undefined when it is fine, and also when
 * the output is not recognisable — refusing on an unparsed version would block
 * a terraform that works on the strength of a string we failed to read.
 */
export function terraformTooOld(versionOutput: string): string | undefined { // contract pin: test-only export, asserted by the suite
  const found = versionOutput.match(/Terraform v(\d+)\.(\d+)\.(\d+)/);
  if (!found) return undefined;
  const version = found.slice(1, 4).map(Number);
  const minimum = MIN_TERRAFORM.split('.').map(Number);
  for (const [i, floor] of minimum.entries()) {
    if (version[i] > floor) return undefined;
    if (version[i] < floor) {
      return `terraform ${version.join('.')} is too old — the module fleet generates needs >= ${MIN_TERRAFORM} (https://developer.hashicorp.com/terraform/install)`;
    }
  }
  return undefined;
}

/** Run a terraform step, failing the command when it fails. */
function terraformStep(run: Runner, dir: string, args: string[], what: string): void {
  const res = run(['terraform', ...args], { cwd: dir });
  if (res.status !== 0) throw new SetupError(`terraform ${what} failed (exit ${res.status}) — the output above says why`);
}

// ---------- fleet setup infra ----------

/** Where a deployment's generated terraform, state, and capture live. */
function infraDir(cwd: string, provider: string): string {
  return path.join(cwd, '.fleet', 'infra', provider);
}

type SetupInfraOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Root of this Fleet installation, for module-source resolution. */
  root: string;
  version: string;
  unit: SetupUnit;
  /** Prompt values pre-supplied by flags, keyed by prompt key. */
  flags: Record<string, string | undefined>;
  /** --yes: skip the apply confirmation (values still come from prompts on a TTY). */
  yes: boolean;
  /** --destroy: tear the named deployment down instead of creating one. */
  destroy: boolean;
  /** --backend <type>: write a backend block; local state when absent. */
  backend?: string;
  /** --backend-config: passed through to `terraform init`, repeatable. */
  backendConfig: string[];
  /** --module-source: override where the terraform unit is fetched from. */
  moduleSource?: string;
  /** True when there is a terminal to interview on. */
  interactive: boolean;
  log: (line: string) => void;
  run?: Runner;
  openAsker?: () => Promise<Asker>;
};

/**
 * `fleet setup infra` — interview, generate, plan, and (on an explicit yes)
 * apply, then capture the deployment description every other command reads.
 */
export async function runSetupInfra(opts: SetupInfraOptions): Promise<number> {
  const run = opts.run ?? spawnRunner;
  const unit = opts.unit;
  const dir = infraDir(opts.cwd, unit.provider);

  // Before anything: nothing below can succeed without these, and a preflight
  // that runs after the prompts is a preflight that arrives too late to help.
  preflight(unit, opts.cwd, run);

  // One reader for the whole command, closed once at the end. Two would be a
  // bug that only shows on the second question: closing a readline interface
  // ends the shared stdin under it, so the confirmation after the plan would
  // find the input already gone.
  const ask = opts.interactive ? await (opts.openAsker ?? stdinAsker)() : undefined;
  try {
    return await interviewAndApply(opts, run, unit, dir, ask);
  } finally {
    ask?.close();
  }
}

async function interviewAndApply(
  opts: SetupInfraOptions,
  run: Runner,
  unit: SetupUnit,
  dir: string,
  ask: Asker | undefined,
): Promise<number> {
  if (opts.destroy) return await destroyInfra(opts, run, dir, ask);

  opts.log(`provider: ${unit.provider} — ${unit.label}`);
  const merged = await interview(unit.prompts, { flags: opts.flags, env: opts.env, ask, log: opts.log });
  if (merged.missing.length > 0) {
    throw new SetupError(
      `no terminal to prompt on, and these were not supplied: ${merged.missing.join(' ')}\n` +
        '  supply them as flags (that is what they are for), or run this on a terminal',
    );
  }
  const answers = merged.answers;
  const moduleSource = resolveModuleSource({
    provider: unit.provider,
    flag: opts.moduleSource,
    env: opts.env,
    root: opts.root,
  });

  fs.mkdirSync(dir, { recursive: true });
  ensureFleetGitignore(path.join(opts.cwd, '.fleet'), ['infra/']);
  const mainTf = path.join(dir, 'main.tf');
  fs.writeFileSync(
    mainTf,
    renderMainTf({ unit, answers, moduleSource, backend: opts.backend, version: opts.version }),
  );

  opts.log('');
  opts.log(`wrote ${path.relative(opts.cwd, mainTf)}`);
  for (const [key, value] of unit.moduleArgs(answers)) opts.log(`  ${key} = ${value}`);
  for (const [key, value] of unit.providerArgs(answers)) opts.log(`  ${key} = ${value}`);
  opts.log(`  module  = ${moduleSource}`);
  opts.log(`  state   = ${opts.backend ? `${opts.backend} backend (configured by --backend-config)` : `local, in ${path.relative(opts.cwd, dir)} (gitignored)`}`);
  opts.log('');

  terraformStep(run, dir, ['init', '-input=false', ...opts.backendConfig.map((c) => `-backend-config=${c}`)], 'init');
  const planFile = 'fleet.tfplan';
  terraformStep(run, dir, ['plan', '-input=false', `-out=${planFile}`], 'plan');

  if (!opts.yes) {
    // A plan the operator did not read is not consent, so the question comes
    // after it and defaults to no. No terminal and no --yes means we have a
    // plan and nobody to approve it: stop, and say what would continue.
    if (!ask) {
      opts.log('');
      opts.log(`planned only: no terminal to confirm on. Rerun with --yes to apply, or apply the saved plan: terraform -chdir=${path.relative(opts.cwd, dir)} apply ${planFile}`);
      return 0;
    }
    if (!(await confirm(`apply this plan to ${unit.provider} as "${answers.name}"?`, ask))) {
      opts.log(`nothing applied. The plan is saved: terraform -chdir=${path.relative(opts.cwd, dir)} apply ${planFile}`);
      // The generated file stays, because the saved plan cannot be applied
      // without it — but it now describes answers nothing was created from, and
      // a later `--destroy` reads its name for the confirmation it prints.
      opts.log(`  ${path.relative(opts.cwd, mainTf)} describes these answers, not what is deployed.`);
      return 0;
    }
  }

  terraformStep(run, dir, ['apply', '-input=false', planFile], 'apply');
  const configPath = captureFleetConfig(dir, run);
  opts.log('');
  opts.log(`applied. Captured ${path.relative(opts.cwd, configPath)} — every other fleet command reads it.`);
  opts.log('Next: publish the images and start the daemon on them, then open the tunnel:');
  opts.log('  <fleet-checkout>/images/build.sh --redeploy-daemon');
  opts.log('  fleet connect');
  return 0;
}

/**
 * Write the unit's `fleet_config` output beside the generated terraform, plus
 * the one field it cannot know: `daemon_url`, the local port the operator's
 * tunnel will land on. Fleet created this infrastructure, so leaving the
 * operator to paste that line in by hand — the last manual step of the old
 * bring-up — is exactly the handoff this command exists to close.
 */
function captureFleetConfig(dir: string, run: Runner): string {
  const configPath = path.join(dir, 'fleet-config.json');
  const res = run(['terraform', 'output', '-json', 'fleet_config'], { cwd: dir, capture: true });
  if (res.status !== 0) {
    throw new SetupError(
      'terraform output -json fleet_config failed — the apply succeeded but its description could not be read\n' +
        `${indented(res.stderr)}  the apply is not lost; take the capture again with: terraform -chdir=${dir} output -json fleet_config > ${configPath}`,
    );
  }
  let config: unknown;
  try {
    config = JSON.parse(res.stdout);
  } catch (err) {
    throw new SetupError(`terraform output -json fleet_config did not return JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new SetupError('terraform output -json fleet_config did not return an object');
  }
  const described = config as Record<string, unknown>;
  // daemon_url is the operator's own choice of local port, and this file is the
  // only place it lives (src/cli/connect.ts) — a terraform output never carries
  // it. So a re-capture keeps the one already here: deriving it every time
  // would silently reset a port a live tunnel is holding, and every command
  // would then report an unreachable daemon while the tunnel is fine.
  const kept = keptDaemonUrl(configPath);
  if (kept !== undefined) {
    described.daemon_url = kept;
  } else if (typeof described.daemon_port === 'number') {
    // The connect_hint convention, from the one place that owns it: never the
    // remote port itself, because local agents squat low ports and accept
    // connections silently.
    described.daemon_url = `http://127.0.0.1:${chooseLocalPort(undefined, undefined, described.daemon_port)}`;
  }
  fs.writeFileSync(configPath, `${JSON.stringify(described, null, 2)}\n`);
  return configPath;
}

/** The `daemon_url` a previous capture already carries, if this file has one. */
function keptDaemonUrl(configPath: string): string | undefined {
  try {
    const previous = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    return typeof previous.daemon_url === 'string' && previous.daemon_url !== '' ? previous.daemon_url : undefined;
  } catch {
    return undefined; // absent, or unreadable: either way there is nothing to keep
  }
}

/** Indent captured stderr under a message, or nothing when there was none. */
function indented(stderr: string): string {
  const text = stderr.trim();
  return text === '' ? '' : `${text.split('\n').map((line) => `  ${line}`).join('\n')}\n`;
}

/** Pattern to read the `name = "..."` from a Terraform root module — hoisted so Lizard
 *  does not misparse the regex as a division operator and corrupt the function boundary. */
const TF_NAME_PATTERN = /^\s*name\s*=\s*"([^"]+)"/m;

/** The deployment name the generated root module was written with, for messages. */
function generatedName(mainTf: string): string | undefined {
  const match = mainTf.match(TF_NAME_PATTERN);
  return match?.[1];
}

/** `fleet setup infra --destroy`: show what dies, then take it down on an explicit yes. */
async function destroyInfra(
  opts: SetupInfraOptions,
  run: Runner,
  dir: string,
  ask: Asker | undefined,
): Promise<number> {
  const mainTf = path.join(dir, 'main.tf');
  if (!fs.existsSync(mainTf)) {
    throw new SetupError(
      `no deployment to destroy: ${path.relative(opts.cwd, mainTf)} does not exist\n` +
        '  --destroy tears down what `fleet setup infra` created from this directory; it never guesses at infrastructure it did not write',
    );
  }
  const name = generatedName(fs.readFileSync(mainTf, 'utf8')) ?? opts.unit.provider;

  // A destroy tears down what the state in *this* directory owns; the prompt
  // flags describe something to create and cannot steer it. Accepting them
  // silently is the bad failure: `--destroy --yes --name staging` run from the
  // production checkout would destroy production and, with no prompt, never say
  // whose name it actually used.
  const contradicting = Object.entries(opts.flags)
    .filter(([key, value]) => value !== undefined && !(key === 'name' && value === name))
    .map(([key, value]) => `--${flagName(key)} ${value}`);
  if (contradicting.length > 0) {
    throw new SetupError(
      `--destroy does not take ${contradicting.join(' ')}: it tears down the deployment ${path.relative(opts.cwd, mainTf)} generated, which is "${name}"\n` +
        `  rerun as: fleet setup infra --destroy${opts.yes ? ' --yes' : ''} --name ${name}   (or from the checkout whose deployment you meant)`,
    );
  }

  terraformStep(run, dir, ['init', '-input=false', ...opts.backendConfig.map((c) => `-backend-config=${c}`)], 'init');
  // The plan IS the confirmation prompt's evidence: "what dies" is a list only
  // terraform can produce, and a yes/no with nothing above it is a coin flip.
  terraformStep(run, dir, ['plan', '-destroy', '-input=false'], 'plan -destroy');

  if (!opts.yes) {
    if (!ask) throw new SetupError('no terminal to confirm a destroy on — rerun with --yes if you mean it');
    if (!(await confirm(`destroy everything above, the "${name}" deployment?`, ask))) {
      opts.log('nothing destroyed.');
      return 0;
    }
  }

  terraformStep(run, dir, ['destroy', '-input=false', '-auto-approve'], 'destroy');
  // The capture describes infrastructure that no longer exists. Left behind, it
  // is what every later command resolves the daemon from — a tunnel into
  // nothing, reported as an unreachable daemon rather than a destroyed one.
  const configPath = path.join(dir, 'fleet-config.json');
  if (fs.existsSync(configPath)) {
    fs.rmSync(configPath);
    opts.log(`removed ${path.relative(opts.cwd, configPath)} — it described a deployment that is gone`);
  }
  opts.log(`destroyed "${name}". The generated terraform and its state are still in ${path.relative(opts.cwd, dir)}.`);
  return 0;
}

// ---------- fleet setup repo ----------

/** First existing path among `candidates`, relative to cwd. */
function firstExisting(cwd: string, candidates: string[]): string | undefined {
  return candidates.find((rel) => fs.existsSync(path.join(cwd, rel)));
}

/** Files that name an ecosystem, and what that ecosystem's defaults are. */
const ECOSYSTEMS: Array<{ marker: string; image: string; setup: string }> = [
  { marker: 'package.json', image: 'node:22', setup: 'npm ci' },
  { marker: 'pyproject.toml', image: 'python:3.12', setup: 'pip install -e .' },
  { marker: 'requirements.txt', image: 'python:3.12', setup: 'pip install -r requirements.txt' },
  { marker: 'go.mod', image: 'golang:1.23', setup: 'go mod download' },
  { marker: 'Cargo.toml', image: 'rust:1', setup: 'cargo fetch' },
];

/** Uppercase KEY= names in a .env-style template — the shape env.vars wants. */
function envKeysFrom(cwd: string, rel: string): string[] {
  try {
    const keys: string[] = [];
    for (const line of fs.readFileSync(path.join(cwd, rel), 'utf8').split('\n')) {
      const match = line.trim().match(/^([A-Z][A-Z0-9_]*)=/);
      if (match) keys.push(match[1]);
    }
    return keys;
  } catch {
    return [];
  }
}

/** Markdown files directly under a directory, sorted, as repo-relative paths. */
function markdownIn(cwd: string, rel: string): string[] {
  try {
    return fs
      .readdirSync(path.join(cwd, rel))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => path.posix.join(rel, name));
  } catch {
    return [];
  }
}

/** The manifest shape `fleet setup repo` builds and `fleet lint` then validates. */
type RepoManifest = {
  version: 1;
  setup: { image: string; script: string };
  workspace: { repo: string; strategy: 'branch-per-job'; sync?: string[] };
  env?: { vars: string[] };
  harness: { cli: string; commands: Array<{ path: string; critic: string }> };
  gates: { pickup: string; default_finish: string };
  limits: { idle: string; block_hot: string; decision_timeout: string };
};

/**
 * The interview for `.fleet/manifest.json`, with defaults extracted from the
 * repo wherever they can be seen. Everything asked here is repo-specific by
 * definition — this is the file that says what *this* project needs — so the
 * defaults are evidence (a package.json, a .claude/commands file, an
 * .env.example), never a house style guess dressed up as one.
 */
export function repoPrompts(cwd: string, existing?: RepoManifest): PromptSpec[] {
  const ecosystem = ECOSYSTEMS.find((e) => fs.existsSync(path.join(cwd, e.marker)));
  const gate = firstExisting(cwd, ['.fleet/gate.mjs', '.fleet/check-ready.js', '.fleet/check-ready.mjs']);
  const commands = markdownIn(cwd, path.join('.claude', 'commands'));
  const envKeys = [...envKeysFrom(cwd, '.env.example'), ...envKeysFrom(cwd, path.join('.fleet', '.env.example'))];
  const kept = (value: string | undefined, detected: string | undefined): (() => string | undefined) =>
    () => value ?? detected;

  return [
    {
      key: 'repo',
      question: 'workspace git remote',
      hint: '"origin" resolves the URL from this checkout at dispatch — portable across forks',
      fallback: kept(existing?.workspace.repo, 'origin'),
      required: true,
    },
    {
      key: 'image',
      question: 'base image for the job container',
      fallback: kept(existing?.setup.image, ecosystem?.image ?? 'node:22'),
      required: true,
    },
    {
      key: 'setup_command',
      question: 'setup command',
      hint: 'the "new laptop" step: deps, build, seed. Written into .fleet/setup.sh',
      fallback: kept(undefined, ecosystem?.setup ?? ''),
    },
    {
      key: 'sync',
      question: 'gitignored files to ship into the sandbox (comma-separated)',
      fallback: kept(existing?.workspace.sync?.join(', '), ''),
      validate: (value) => {
        const missing = splitList(value).filter((rel) => !fs.existsSync(path.join(cwd, rel)));
        return missing.length === 0 ? undefined : `not in this checkout: ${missing.join(', ')}`;
      },
    },
    {
      key: 'env_vars',
      question: 'env var names the job needs (comma-separated)',
      hint: 'names only — values are read from your shell or .fleet/.env at dispatch',
      fallback: kept(existing?.env?.vars.join(', '), envKeys.join(', ')),
      validate: (value) => {
        const bad = splitList(value).filter((name) => !/^[A-Z][A-Z0-9_]*$/.test(name));
        return bad.length === 0 ? undefined : `not env var names: ${bad.join(', ')}`;
      },
    },
    {
      key: 'pickup',
      question: 'pickup gate command',
      hint: 'must exit 0 or the job stops before any model spend',
      fallback: kept(existing?.gates.pickup, gate ? `node ${gate}` : 'node .fleet/check-ready.js'),
      required: true,
    },
    {
      key: 'command_path',
      question: 'harness command to run',
      fallback: kept(existing?.harness.commands[0]?.path, commands[0] ?? '.claude/commands/dev.md'),
      required: true,
      validate: (value) =>
        fs.existsSync(path.join(cwd, value))
          ? undefined
          : `not in this checkout: ${value} (create it before dispatching, or name one that exists)`,
    },
    {
      key: 'critic',
      question: 'critic agent that reviews the work',
      hint: 'no command runs without one — the manifest lint enforces it',
      fallback: kept(existing?.harness.commands[0]?.critic, 'code-reviewer'),
      required: true,
    },
  ];
}

/** Assemble the manifest from answers. Optional sections are omitted, never empty. */
export function repoManifest(answers: Answers): RepoManifest { // contract pin: test-only export, asserted by the suite
  const sync = splitList(answers.sync ?? '');
  const vars = splitList(answers.env_vars ?? '');
  const manifest: RepoManifest = {
    version: 1,
    setup: { image: answers.image, script: '.fleet/setup.sh' },
    workspace: { repo: answers.repo, strategy: 'branch-per-job' },
    // One runner adapter exists, so the CLI is shown rather than asked.
    harness: { cli: 'claude-code', commands: [{ path: answers.command_path, critic: answers.critic }] },
    gates: { pickup: answers.pickup, default_finish: 'merge-ready' },
    // Not interviewed: these are the documented defaults (src/shared/time.ts),
    // written out so the manifest shows the cost model instead of hiding it.
    limits: { idle: '20m', block_hot: '30m', decision_timeout: '24h' },
  };
  if (sync.length > 0) manifest.workspace.sync = sync;
  if (vars.length > 0) manifest.env = { vars };
  return manifest;
}

/** The setup script for a one-line setup command. */
function setupScriptFor(command: string): string {
  return `#!/usr/bin/env sh
# Fleet setup script: everything the job image needs before the harness runs
# (dependencies, build, seed data). Runs with unrestricted egress.
set -eu

${command}
`;
}

type SetupRepoOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  flags: Record<string, string | undefined>;
  yes: boolean;
  interactive: boolean;
  log: (line: string) => void;
  /** Validates the assembled manifest against schemas/manifest.schema.json. */
  validate: (manifest: unknown) => { ok: boolean; errors: Array<{ instancePath: string; message?: string }> };
  openAsker?: () => Promise<Asker>;
};

/**
 * `fleet setup repo` — the manifest, by interview. `fleet init` still writes the
 * placeholder scaffold non-interactively (CI, and agents that fill it in
 * themselves); this is the path for a human standing a repo up, and it asks
 * only about things that are genuinely this repo's: what to sync, which env
 * vars, which gate, which command and critic.
 *
 * An existing manifest becomes the defaults rather than a refusal: rerunning
 * the interview to change one answer is the ordinary way this command is used
 * the second time. Overwriting it still takes an explicit yes.
 */
/**
 * An existing manifest, but only if it is one. `repoPrompts` reads nested
 * fields off it for its defaults, so anything that merely parses as JSON — `{}`,
 * a half-finished edit, somebody else's config — would crash the interview with
 * a stack trace on exactly the file this command exists to repair. The schema is
 * the authority on what a manifest is, here as everywhere: what it rejects is
 * not defaults, and the interview starts from the checkout instead.
 */
function readExistingManifest(manifestPath: string, opts: SetupRepoOptions): RepoManifest | undefined {
  const scratch = (why: string): undefined => {
    opts.log(`note: ${path.relative(opts.cwd, manifestPath)} ${why} — answering from the checkout instead`);
    return undefined;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return scratch('is not valid JSON');
  }
  const check = opts.validate(parsed);
  if (!check.ok) {
    const first = check.errors[0];
    return scratch(`is not a valid manifest (${first?.instancePath || '/'} ${first?.message ?? 'invalid'})`);
  }
  return parsed as RepoManifest;
}

export async function runSetupRepo(opts: SetupRepoOptions): Promise<number> {
  const fleetDir = path.join(opts.cwd, '.fleet');
  const manifestPath = path.join(fleetDir, 'manifest.json');

  // Existence and usability are two questions, and conflating them cost both
  // ways: a file too broken to read as defaults was also a file overwritten
  // with no confirmation, while a valid one got the prompt.
  const manifestExists = fs.existsSync(manifestPath);
  let existing: RepoManifest | undefined;
  if (manifestExists) {
    existing = readExistingManifest(manifestPath, opts);
    if (!opts.yes && !opts.interactive) {
      throw new SetupError(
        `${path.relative(opts.cwd, manifestPath)} already exists, and there is no terminal to confirm overwriting it — rerun with --yes if you mean to replace it`,
      );
    }
  }

  const ask = opts.interactive ? await (opts.openAsker ?? stdinAsker)() : undefined;
  let merged: Interview;
  try {
    opts.log('harness: claude-code — the supported runner adapter');
    merged = await interview(repoPrompts(opts.cwd, existing), {
      flags: opts.flags,
      env: opts.env,
      ask,
      log: opts.log,
    });
    if (merged.missing.length === 0 && manifestExists && !opts.yes && ask) {
      const approved = await confirm(`overwrite ${path.relative(opts.cwd, manifestPath)}?`, ask);
      if (!approved) {
        opts.log('nothing written.');
        return 0;
      }
    }
  } finally {
    ask?.close();
  }
  if (merged.missing.length > 0) {
    throw new SetupError(
      `no terminal to prompt on, and these were not supplied: ${merged.missing.join(' ')}\n` +
        '  supply them as flags (that is what they are for), or run this on a terminal',
    );
  }

  const manifest = repoManifest(merged.answers);
  // The schema owns the shape: an interview that can produce a manifest `fleet
  // lint` then rejects is worse than one that refuses to write it.
  const check = opts.validate(manifest);
  if (!check.ok) {
    throw new SetupError(
      ['the answers do not make a valid manifest:', ...check.errors.map((e) => `  ${e.instancePath || '/'} ${e.message ?? 'invalid'}`)].join('\n'),
    );
  }

  const setupCommand = merged.answers.setup_command?.trim();
  const scriptExisted = fs.existsSync(path.join(fleetDir, 'setup.sh'));
  for (const line of writeScaffold(fleetDir, manifest, setupCommand ? setupScriptFor(setupCommand) : undefined)) {
    opts.log(line);
  }
  if (scriptExisted && setupCommand) {
    opts.log(`note: .fleet/setup.sh already existed and was left alone — make sure it runs \`${setupCommand}\``);
  }
  opts.log('');
  opts.log('Check it with: fleet lint');
  return 0;
}

// ---------- fleet setup harness ----------

/**
 * The canonical skill, split into the parts a variant is assembled from.
 *
 * A hand-rolled reader rather than a YAML parser, deliberately: the only file
 * this ever parses is `integrations/SKILL.md`, which this repo owns and whose
 * frontmatter is two single-line fields. Zero runtime dependencies is a rule,
 * and a general YAML parser here would be a second convention to keep honest.
 */
type CanonicalSkill = { frontmatter: string; name: string; description: string; body: string };

/**
 * Line endings as everything below reasons about them.
 *
 * Not defensive decoration: a project-scope variant is committable, so a CRLF
 * checkout of one is an ordinary thing to meet. Without this, the stamp fails to
 * match on `\r`, and a rerun reports "fleet did not write it" about a file Fleet
 * wrote — the one message that talks an operator into `--force` over contents
 * that were never theirs to lose.
 */
function lf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function parseSkill(raw: string, source: string): CanonicalSkill { // contract pin: test-only export, asserted by the suite
  const text = lf(raw);
  const found = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!found) throw new SetupError(`${source} has no frontmatter block — a skill file starts with --- name/description ---`);
  const fields: Record<string, string> = {};
  for (const line of found[1].split('\n')) {
    const pair = line.match(/^([a-z][a-z0-9_-]*):\s*(.*)$/);
    if (pair) fields[pair[1]] = pair[2].trim();
  }
  const missing = ['name', 'description'].filter((key) => !fields[key]);
  if (missing.length > 0) {
    throw new SetupError(`${source} frontmatter is missing ${missing.join(' and ')} — every harness requires both to discover a skill`);
  }
  // Every convention Fleet installs into requires the skill's directory to be
  // named for its frontmatter `name`, and rejects the name itself unless it is
  // lowercase-hyphenated. A name that fails this installs a directory the
  // harness silently ignores, which is the worst outcome available: no error,
  // no skill.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.name) || fields.name.length > 64) {
    throw new SetupError(
      `${source} frontmatter name "${fields.name}" is not installable — harnesses require lowercase alphanumerics separated by single hyphens, at most 64 characters`,
    );
  }
  return {
    frontmatter: found[0].trimEnd(),
    name: fields.name,
    description: fields.description,
    body: text.slice(found[0].length).trim(),
  };
}

/**
 * The stamp a generated variant carries, and the boundary between "Fleet wrote
 * this" and "a human did". It records the sha256 of everything else in the file,
 * so a rerun can tell three cases apart that all look like "the file exists":
 * ours and current (leave it), ours and stale (update it), and edited or
 * hand-written (refuse, because overwriting it loses work nobody backed up).
 *
 * The version lives in the stamp rather than the hashed content on purpose: a
 * fleet upgrade that changes nothing about the skill must not read as a
 * modification, in either direction.
 */
const STAMP_RE = /^<!-- fleet-skill:[\s\S]*?-->\n\n/m;

function stamp(version: string, contentHash: string): string {
  return `<!-- fleet-skill: generated by \`fleet setup harness\` (fleet ${version}) from
     Fleet's canonical skill, integrations/SKILL.md. Edit the canonical and
     rerun; an edit here is detected and refused, never silently overwritten.
     content sha256:${contentHash} -->`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** What a stamped file claims about itself: its recorded hash, and the content that hash covers. */
export function readStamp(raw: string): { hash: string; content: string } | undefined { // contract pin: test-only export, asserted by the suite
  const text = lf(raw);
  const found = text.match(STAMP_RE);
  if (!found) return undefined;
  const hash = found[0].match(/sha256:([0-9a-f]{64})/)?.[1];
  if (!hash) return undefined;
  return { hash, content: text.replace(STAMP_RE, '') };
}

/** Is this text a Fleet-generated variant that nobody has edited since? */
export function isGenerated(text: string): boolean { // contract pin: test-only export, asserted by the suite
  const found = readStamp(text);
  return found !== undefined && sha256(found.content) === found.hash;
}

/**
 * A path as the operator recognises it — and, because this string is written
 * *into* the generated file, one that is still true on somebody else's machine.
 *
 * The scope decides the form, not whichever root happens to match first. A
 * checkout under the home directory is the normal case, so a home-relative
 * answer would describe a project-scope variant as `~/src/repo/…`: wrong for
 * every teammate who cloned elsewhere, and — since the shown path is inside the
 * hashed content — enough to make each of their `fleet setup harness` runs
 * rewrite a committed file with their own layout.
 *
 * Forward slashes on every platform: this is documentation, and every path in
 * Fleet's docs, help text and skill is spelled that way.
 */
function friendlyPath(target: string, scope: SkillScope, roots: { home: string; cwd: string }): string {
  const relative = path.relative(scope === 'user' ? roots.home : roots.cwd, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return posixPath(target);
  return posixPath(scope === 'user' ? path.join('~', relative) : relative);
}

/** Forward slashes, for a path that is being read rather than opened. */
function posixPath(target: string): string {
  return target.split(path.sep).join('/');
}

/**
 * The generated per-harness section: the two things the canonical skill cannot
 * state harness-neutrally, and nothing else. It is rendered from the harness
 * record rather than written per harness, which is what keeps "one canonical, no
 * content forks" true while still telling each harness's agent exactly how to
 * ask its human.
 */
function harnessNote(harness: HarnessTarget, name: string, destination: string): string {
  return [
    `## In ${harness.label}`,
    '',
    `This is the ${harness.label} variant of Fleet's canonical skill. Two things this harness does its own way:`,
    '',
    // `name` rather than the literal: the directory comes from the canonical's
    // frontmatter (skillPath), so a literal here would state the one thing this
    // sentence exists to state, wrongly, the day the canonical is renamed.
    `- **Where this file lives.** \`${destination}\` — ${harness.label} discovers skills there. The directory name has to stay \`${name}\`, matching the frontmatter above; a mismatch is a skill the harness ignores without saying so.`,
    `- **How you ask the human** (the "When the job blocks" step above). ${harness.ask}`,
  ].join('\n');
}

type VariantOptions = {
  canonical: CanonicalSkill;
  harness: HarnessTarget;
  scope: SkillScope;
  version: string;
  roots: { home: string; cwd: string };
};

/**
 * One harness's variant of the canonical skill: the canonical frontmatter and
 * body verbatim, plus a stamp and the generated harness note.
 *
 * Generated, not forked. The canonical is the only copy of the instructions
 * anyone edits, and a variant that starts saying something the canonical does
 * not is the failure mode this shape exists to make impossible — the same
 * canonical/pointer rule `agents/` follows, and enforced the same way
 * (test/harness-mirrors.test.ts).
 */
export function renderVariant(opts: VariantOptions): { text: string; content: string; destination: string } { // contract pin: test-only export, asserted by the suite
  const destination = skillPath(opts.harness, opts.scope, opts.canonical.name, opts.roots);
  const shown = friendlyPath(destination, opts.scope, opts.roots);
  // Frontmatter first, always: it is what makes the file discoverable, so the
  // stamp goes after it rather than at the top of the file.
  const head = `${opts.canonical.frontmatter}\n\n`;
  const rest = `${opts.canonical.body}\n\n${harnessNote(opts.harness, opts.canonical.name, shown)}\n`;
  const content = `${head}${rest}`;
  return { text: `${head}${stamp(opts.version, sha256(content))}\n\n${rest}`, content, destination };
}

/** The prompts `fleet setup harness` asks, and therefore the flags it accepts. */
export function harnessPrompts(detected: string[] = []): PromptSpec[] {
  const known = HARNESS_TARGETS.map((h) => h.id).join(', ');
  return [
    {
      key: 'harness',
      question: 'install the fleet skill for which harnesses (comma-separated)',
      hint: `known: ${known}`,
      // Detection is a default, never a restriction: installing for a harness
      // this machine has not got yet is a legitimate thing to do (a fresh
      // laptop, a dotfiles repo), and it only takes naming it.
      fallback: () => (detected.length > 0 ? detected.join(', ') : undefined),
      required: true,
      validate: (value) => {
        const items = splitList(value);
        if (items.length === 0) return `name at least one harness (known: ${known})`;
        const unknown = items.filter((id) => harnessFor(id) === undefined);
        return unknown.length === 0 ? undefined : `no discovery convention for: ${unknown.join(', ')} (known: ${known})`;
      },
    },
    {
      key: 'scope',
      question: 'install for this user or for this project',
      hint: 'user: your home config, every repo you work in. project: this checkout only, and committable',
      fallback: () => 'user',
      required: true,
      validate: (value) => (value === 'user' || value === 'project' ? undefined : 'user or project'),
    },
  ];
}

type SetupHarnessOptions = {
  cwd: string;
  /** The operator's home directory — where user-scope variants go. */
  home: string;
  env: Record<string, string | undefined>;
  /** Root of this Fleet installation: the directory holding `integrations/`. */
  root: string;
  version: string;
  flags: Record<string, string | undefined>;
  /** --force: overwrite a copy Fleet did not write, or one that has been edited. */
  force: boolean;
  interactive: boolean;
  log: (line: string) => void;
  openAsker?: () => Promise<Asker>;
};

/**
 * `fleet setup harness` — install the skill where each harness discovers it.
 *
 * The skill is Fleet's primary interface (docs/decisions.md#d8): the dispatching
 * session holds the wait, relays decisions through its own ask mechanism, and
 * reports the settle. Shipping it in the package while leaving every user to
 * find their harness's convention and copy it by hand made the interface
 * optional in practice, which is the same as not having one.
 */
export async function runSetupHarness(opts: SetupHarnessOptions): Promise<number> {
  const canonicalPath = path.join(opts.root, 'integrations', 'SKILL.md');
  let raw: string;
  try {
    raw = fs.readFileSync(canonicalPath, 'utf8');
  } catch {
    throw new SetupError(
      `this Fleet installation has no canonical skill at ${canonicalPath}\n` +
        '  integrations/ ships in the package — a missing one means a partial install, not a missing feature',
    );
  }
  const canonical = parseSkill(raw, path.relative(opts.root, canonicalPath));

  const detected: string[] = [];
  for (const harness of HARNESS_TARGETS) {
    const why = detectHarness(harness, { env: opts.env, home: opts.home });
    if (why) detected.push(harness.id);
    opts.log(`${why ? 'found   ' : 'not here'} ${harness.id.padEnd(11)} ${why ?? `no ${harness.binary} on PATH, no ${path.join('~', harness.configDir)}`}`);
  }
  opts.log('');

  const ask = opts.interactive ? await (opts.openAsker ?? stdinAsker)() : undefined;
  let merged: Interview;
  try {
    merged = await interview(harnessPrompts(detected), {
      flags: opts.flags,
      env: opts.env,
      ask,
      log: opts.log,
    });
  } finally {
    ask?.close();
  }
  if (merged.missing.length > 0) {
    throw new SetupError(
      `no terminal to prompt on, and these were not supplied: ${merged.missing.join(' ')}\n` +
        `  supply them as flags (that is what they are for), or run this on a terminal${detected.length === 0 ? '\n  nothing was detected here, so there was no default to fall back on' : ''}`,
    );
  }

  const scope = merged.answers.scope as SkillScope;
  const blocked: string[] = [];
  for (const id of splitList(merged.answers.harness)) {
    // Validated at the prompt, so this cannot miss — but the flag path and the
    // prompt path share that validator, and a lookup that throws here would be
    // a crash where the interview already has a message.
    const harness = harnessFor(id)!;
    const outcome = installVariant({ canonical, harness, scope, opts });
    if (outcome.blocked) blocked.push(outcome.line);
    else opts.log(outcome.line);
  }

  if (blocked.length > 0) {
    throw new SetupError(
      `${blocked.join('\n')}\n  rerun with --force to overwrite ${blocked.length === 1 ? 'it' : 'them'} — the current contents are not recoverable afterwards`,
    );
  }

  opts.log('');
  opts.log(`Ask your harness to "delegate <ticket> to fleet" — the skill's description is what triggers it.`);
  if (scope === 'user') opts.log('Installed for you, in every repo. Per-checkout instead: fleet setup harness --scope project');
  else opts.log('Installed for this checkout only. Commit it to share the skill with everyone on the repo.');
  return 0;
}

/** Write one harness's variant, unless what is already there is not ours to replace. */
function installVariant(args: {
  canonical: CanonicalSkill;
  harness: HarnessTarget;
  scope: SkillScope;
  opts: SetupHarnessOptions;
}): { line: string; blocked?: true } {
  const { canonical, harness, scope, opts } = args;
  const roots = { home: opts.home, cwd: opts.cwd };
  const { text, destination } = renderVariant({ canonical, harness, scope, version: opts.version, roots });
  const shown = friendlyPath(destination, scope, roots);

  // Read-and-decide, no exists probe: probe-then-read is a filesystem race
  // (CodeQL js/file-system-race), and ENOENT already means "nothing here".
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(destination, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (existing !== undefined) {
    // Normalised, so a CRLF checkout of a committed variant reads as unchanged
    // rather than as a rewrite of every line.
    if (lf(existing) === text) return { line: `unchanged ${harness.id.padEnd(11)} ${shown}` };
    if (!isGenerated(existing) && !opts.force) {
      return {
        line: `refusing to overwrite ${shown}: ${readStamp(existing) ? 'it has been edited since fleet wrote it' : 'fleet did not write it'}`,
        blocked: true,
      };
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text);
    return { line: `updated   ${harness.id.padEnd(11)} ${shown}` };
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, text);
  return { line: `installed ${harness.id.padEnd(11)} ${shown}` };
}
