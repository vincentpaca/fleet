#!/usr/bin/env node
// fleet — operator CLI. Exit codes: 0 ok, 1 failure, 2 usage.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateWorkOrder, jobStates } from '../validate.mjs';
import { fleetHome } from '../shared/home.ts';
import { gitValue } from '../shared/git.ts';
import {
  clearRetainedRecord,
  listRetainedRecords,
  readRetainedRecord,
  retainedDir,
  type RetainedRecord,
} from '../shared/retained.ts';
import { getHeadSha, pushWork, remoteHasHead } from '../runner/git.ts';
import { request, describeTarget, daemonTarget, type DaemonResponse } from './client.ts';
import { runConnect, resolveTunnel, tunnelReport } from './connect.ts';
import { toHttpsGitUrl } from '../shared/giturl.ts';
import { parseAnswerLine, renderBanner, detectColorLevel } from './board.ts';
import { runCockpit } from './cockpit.ts';
import { formatEvent, formatJobState, logsNoColor, isNarrativeEvent, type FleetEvent } from './format.ts';
import { unitFor, SETUP_UNITS } from './setup-units.ts';
import {
  runSetupInfra,
  runSetupRepo,
  runSetupHarness,
  repoPrompts,
  harnessPrompts,
  flagName,
  writeScaffold,
  SetupError,
  SETUP_STUB,
} from './setup.ts';
import {
  twoLayerEnabled,
  computeImageHash,
  runnerBaseTag,
  jobImageTag,
  imageExistsLocally,
  buildJobImage,
  pushToEcr,
  type ImageManifest,
} from './images.ts';

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const HELP = `fleet — run coding-agent jobs in containers in your own cloud

Usage: fleet [command] [options]

With no command on a terminal, fleet opens the cockpit: the live board, the
selected job's tail, and a command line to dispatch and answer from. It adopts a
healthy daemon tunnel or opens its own, and closing it leaves running jobs alone.

Commands:
  setup infra [--destroy] [--yes] [...]    Stand up (or tear down) the infrastructure in your
                                           cloud. A wizard on a terminal: it asks only what the
                                           infra contract cannot assume (name, region, optional
                                           existing VPC), shows the plan, and applies on an
                                           explicit yes. Generates .fleet/infra/<provider>/main.tf
                                           against Fleet's terraform unit at a pinned ref and
                                           captures fleet-config.json when the apply succeeds.
                                           Flags are headless overrides for any prompt
                                           (--name, --region, --vpc-id, --subnet-ids), plus
                                           --provider, --backend, --backend-config (repeatable),
                                           --module-source. Without a terminal, a missing value
                                           exits 1 naming it — it never waits for input.
  setup repo [--yes] [...]                 Write .fleet/manifest.json by interview, with defaults
                                           extracted from this checkout. Same flag-override rules.
  setup harness [--harness ids] [--scope user|project] [--force]
                                           Install the fleet skill where your coding harness
                                           discovers it, so a session can delegate, hold the watch,
                                           relay decisions and report the settle. Detects installed
                                           harnesses (claude-code, codex, opencode) and defaults to
                                           them. Every variant is generated from the one canonical
                                           integrations/SKILL.md; reruns are idempotent and refuse to
                                           overwrite an edited copy without --force.
  init [--existing]                        Scaffold .fleet/ (manifest, setup.sh, out/) with
                                           placeholders — the non-interactive alias of setup repo
  lint [path]                              Validate manifest (+ .fleet/orders/*.json), no daemon
  delegate <target> [--mode m] [--finish rung] [--manifest path] [--watch]
                                           Build a work order and POST it to the daemon
                                           (--watch: follow the job, answer decisions from stdin)
                                           A PR target (pr/<n> or a GitHub PR URL) implies
                                           --mode followthrough: the job adopts the PR's head
                                           branch, addresses its review comments and failing
                                           checks, and pushes to the same branch so the PR
                                           updates in place. Open PRs only.
                                           When harness.cli_version is set, computes the per-repo
                                           job image hash, builds on miss, passes tag to daemon.
  image build [--manifest path] [--push] [--registry ECR_URI] [--region AWS_REGION]
                                           Build the per-repo job image (two-layer model).
                                           Skips the build when the computed tag already exists.
  resume [--answer]                        Show live state of jobs delegated from this checkout.
                                           Reads .fleet/dispatched.jsonl; blocked jobs appear first
                                           with their open decision rendered.
                                           (--answer: answer the first blocked job interactively)
  resume-push <jobId>                      Retry the work push from a workspace retained because the
                                           job's push failed. Removes the workspace once the remote
                                           has the work; leaves it in place if the push fails again.
  status [jobId]                           List jobs (blocked first) or show one job
  logs <jobId> [--after seq] [--tools] [--full]
                                           Dump job events (default: narrative spine — state, phase,
                                           thinks, decisions, settle; --tools adds tool_use/tool_result;
                                           --full: raw JSON per line)
  attach <jobId> [--answer]                Follow job events until done/cancelled
                                           (--answer: respond to decisions from stdin)
  answer <jobId> [--option id] [--text s]  Answer a blocked job's decision
  cancel <jobId>                           Cancel a job
  artifacts <jobId> [list]                 List artifacts delivered by a job
  artifacts <jobId> get <path> [--out dir] Download an artifact (writes to dir/<filename>, or stdout)
  connect [--port N] [--detach]            Open and hold the tunnel to a cloud daemon: resolve the
                                           deployment, forward its daemon port to localhost, verify
                                           /health, and reopen on session death (re-resolving the
                                           daemon task, which changes on every service deployment).
                                           Foreground by default; --detach supervises in background.
  doctor [--manifest path]                 Check local environment against the manifest, report
                                           tunnel state, and list workspaces retained after a
                                           failed push
  version                                  Print version and exit

Flags:
  --version                                Print version and exit

Daemon address: FLEET_DAEMON_URL env → .fleet/infra/<provider>/fleet-config.json (daemon_url) → unix socket at $FLEET_HOME/daemon.sock (default ~/.fleet).`;

class UsageError extends Error {}
class CliError extends Error {}

// jobStates ships in this repo as schemas/job-states.json; shape covered by test/schemas.test.mjs.
const TERMINAL_STATES: string[] = jobStates.terminal;

function fail(message: string): never {
  throw new CliError(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readJsonFile(file: string, what: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail(`${what} not found: ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${what} is not valid JSON (${file}): ${errorMessage(err)}`);
  }
}

type AjvError = { instancePath: string; message?: string };
type DaemonApiError = { errors?: AjvError[]; error?: string };
/** Hoisted so that inline /\s+/ regexes do not trigger a Lizard tokeniser misparse. */
const WORDS_RE = /\s+/;

function formatFindings(file: string, errors: AjvError[]): string[] {
  return errors.map((e) => `${file}: ${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

// ---------- init ----------

const BROWNFIELD_GUIDANCE = `Brownfield init: this repo already has a life outside Fleet.
Extract .fleet/setup.sh from your real "new laptop" steps — the commands you
actually run to make a fresh clone workable (install deps, build, seed, env).
Then edit .fleet/manifest.json: real repo URL, env.vars your project reads,
workspace.sync for gitignored runtime config, and a pickup gate that proves
the workspace is ready before any model spend.`;

function initManifest(): unknown {
  return {
    version: 1,
    setup: { image: 'node:22', script: '.fleet/setup.sh' },
    workspace: { repo: 'git@github.com:acme/example-app.git', strategy: 'branch-per-job' },
    harness: {
      cli: 'claude-code',
      commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }],
    },
    gates: { pickup: 'node .fleet/check-ready.js', default_finish: 'merge-ready' },
  };
}

function cmdInit(args: string[]): number {
  const { values } = parseCommand(args, { existing: { type: 'boolean' } }, 0, 0);
  const existing = values.existing === true;
  const fleetDir = path.resolve('.fleet');
  const manifestPath = path.join(fleetDir, 'manifest.json');
  const setupPath = path.join(fleetDir, 'setup.sh');

  if (fs.existsSync(manifestPath)) {
    fail(`refusing to overwrite existing ${manifestPath} — remove it first if you really want a fresh scaffold`);
  }
  if (fs.existsSync(setupPath) && !existing) {
    fail(`refusing to overwrite existing ${setupPath} — rerun with --existing to keep it`);
  }

  // The scaffold itself is shared with `fleet setup repo` (#13): the two
  // commands differ in where the manifest's values come from, never in what a
  // .fleet/ directory contains.
  for (const line of writeScaffold(fleetDir, initManifest(), SETUP_STUB)) console.log(line);
  if (existing) console.log(`\n${BROWNFIELD_GUIDANCE}`);
  else console.log('\nEdit .fleet/manifest.json (repo URL, pickup gate) and .fleet/setup.sh before delegating.');
  console.log('Or answer for them: fleet setup repo');
  return EXIT_OK;
}

// ---------- setup ----------

/**
 * Is there someone to interview? stdin, not stdout: the wizard reads answers,
 * and a `fleet setup infra` whose output is piped into a log is still being
 * driven by a human. FLEET_FORCE_TTY is the same test hook the cockpit uses —
 * an env var rather than a flag, so the command surface stays honest.
 */
function promptable(): boolean {
  if (process.env.FLEET_FORCE_TTY === '1') return true;
  return process.stdin.isTTY ?? false;
}

function fleetVersion(): string {
  const pkg = readJsonFile(
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    'package.json',
  ) as { version: string };
  return pkg.version;
}

/** Root of this Fleet installation — the directory holding `infra/` when it is a checkout. */
function installRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

/** Prompt values a flag pre-supplied, keyed the way the prompt list keys them. */
function suppliedFlags(
  prompts: { key: string }[],
  values: Record<string, string | boolean | string[] | undefined>,
): Record<string, string | undefined> {
  const supplied: Record<string, string | undefined> = {};
  for (const { key } of prompts) {
    const value = values[flagName(key)];
    if (typeof value === 'string') supplied[key] = value;
  }
  return supplied;
}

/** Declare one string option per prompt: the prompt list owns the flag surface. */
function promptOptions(prompts: { key: string }[]): Record<string, { type: 'string' }> {
  return Object.fromEntries(prompts.map(({ key }) => [flagName(key), { type: 'string' as const }]));
}

async function cmdSetup(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'infra') return await cmdSetupInfra(rest);
  if (subcommand === 'repo') return await cmdSetupRepo(rest);
  if (subcommand === 'harness') return await cmdSetupHarness(rest);
  if (!subcommand) {
    console.error('fleet setup: subcommand required (infra, repo, harness)');
    return EXIT_USAGE;
  }
  console.error(`fleet setup: unknown subcommand: ${subcommand}`);
  return EXIT_USAGE;
}

/**
 * `--provider` is read before the real parse, because it decides which prompts —
 * and therefore which flags — exist at all. Both spellings, deliberately: a
 * `--provider=gcp` that this missed would fall through to the first unit and
 * generate terraform for the wrong cloud without saying so.
 */
function providerArg(args: string[]): string | undefined {
  const inline = args.find((arg) => arg.startsWith('--provider='));
  if (inline) return inline.slice('--provider='.length);
  const at = args.indexOf('--provider');
  // A dangling `--provider` reads as the empty provider, which no unit answers
  // to — reported as a usage error rather than silently defaulting.
  return at === -1 ? undefined : (args[at + 1] ?? '');
}

async function cmdSetupInfra(args: string[]): Promise<number> {
  const provider = providerArg(args) ?? SETUP_UNITS[0].provider;
  const unit = unitFor(provider);
  if (!unit) {
    console.error(`fleet setup infra: no unit for provider "${provider}" — available: ${SETUP_UNITS.map((u) => u.provider).join(', ')}`);
    return EXIT_USAGE;
  }

  const { values } = parseCommand(
    args,
    {
      ...promptOptions(unit.prompts),
      provider: { type: 'string' },
      yes: { type: 'boolean' },
      destroy: { type: 'boolean' },
      backend: { type: 'string' },
      'backend-config': { type: 'string', multiple: true },
      'module-source': { type: 'string' },
    },
    0,
    0,
  );

  try {
    return await runSetupInfra({
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
      root: installRoot(),
      version: fleetVersion(),
      unit,
      flags: suppliedFlags(unit.prompts, values),
      yes: values.yes === true,
      destroy: values.destroy === true,
      backend: typeof values.backend === 'string' ? values.backend : undefined,
      backendConfig: Array.isArray(values['backend-config']) ? values['backend-config'] : [],
      moduleSource: typeof values['module-source'] === 'string' ? values['module-source'] : undefined,
      interactive: promptable(),
      log: (line) => console.log(line),
    });
  } catch (err) {
    if (err instanceof SetupError) fail(`fleet setup infra: ${err.message}`);
    throw err;
  }
}

async function cmdSetupRepo(args: string[]): Promise<number> {
  const prompts = repoPrompts(process.cwd());
  const { values } = parseCommand(args, { ...promptOptions(prompts), yes: { type: 'boolean' } }, 0, 0);
  try {
    return await runSetupRepo({
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
      flags: suppliedFlags(prompts, values),
      yes: values.yes === true,
      interactive: promptable(),
      log: (line) => console.log(line),
      validate: validateManifest,
    });
  } catch (err) {
    if (err instanceof SetupError) fail(`fleet setup repo: ${err.message}`);
    throw err;
  }
}

async function cmdSetupHarness(args: string[]): Promise<number> {
  // The prompt list owns the flag surface here too; detection happens inside,
  // where it can also be reported, so the flags are the same either way.
  const prompts = harnessPrompts();
  const { values } = parseCommand(args, { ...promptOptions(prompts), force: { type: 'boolean' } }, 0, 0);
  try {
    return await runSetupHarness({
      cwd: process.cwd(),
      home: os.homedir(),
      env: process.env as Record<string, string | undefined>,
      root: installRoot(),
      version: fleetVersion(),
      flags: suppliedFlags(prompts, values),
      force: values.force === true,
      interactive: promptable(),
      log: (line) => console.log(line),
    });
  } catch (err) {
    if (err instanceof SetupError) fail(`fleet setup harness: ${err.message}`);
    throw err;
  }
}

// ---------- lint ----------

function cmdLint(args: string[]): number {
  const { positionals } = parseCommand(args, {}, 0, 1);
  const manifestPath = positionals[0] ?? path.join('.fleet', 'manifest.json');
  const findings: string[] = [];
  let checked = 0;

  try {
    const manifest = readJsonFile(manifestPath, 'manifest');
    checked += 1;
    const { ok, errors } = validateManifest(manifest);
    if (!ok) findings.push(...formatFindings(manifestPath, errors));
  } catch (err) {
    if (err instanceof CliError) findings.push(err.message);
    else throw err;
  }

  const ordersDir = path.join('.fleet', 'orders');
  if (fs.existsSync(ordersDir)) {
    const orderFiles = fs.readdirSync(ordersDir).filter((f) => f.endsWith('.json')).sort();
    for (const name of orderFiles) {
      const file = path.join(ordersDir, name);
      try {
        const order = readJsonFile(file, 'work order');
        checked += 1;
        const { ok, errors } = validateWorkOrder(order);
        if (!ok) findings.push(...formatFindings(file, errors));
      } catch (err) {
        if (err instanceof CliError) findings.push(err.message);
        else throw err;
      }
    }
  }

  // Git tracking check: .fleet/.env must never be committed (it holds secrets).
  const dotEnvRelPath = path.join('.fleet', '.env');
  const lsResult = spawnSync('git', ['ls-files', dotEnvRelPath], { encoding: 'utf8' });
  if (lsResult.status === 0 && lsResult.stdout.trim() !== '') {
    findings.push(`.fleet/.env is tracked by git — add '.env' to .fleet/.gitignore to keep secrets out of the repo`);
  }

  for (const line of findings) console.error(line);
  if (findings.length > 0) return EXIT_FAILURE;
  console.log(`lint ok: ${checked} file(s) valid`);
  return EXIT_OK;
}

// ---------- delegate ----------

type Manifest = {
  workspace?: { repo?: string; sync?: string[] };
  env?: { vars?: string[] };
  gates?: { pickup?: string; default_finish?: string };
  harness?: { cli?: string; cli_version?: string };
};

// ---------- .fleet/.env ----------

/**
 * Parse a .fleet/.env file: KEY=VALUE per line.
 * Rules: # starts a comment; blank lines ignored; everything after the first
 * '=' is the value (trimmed); no interpolation; no quoting beyond trim.
 * Empty values (KEY=) are accepted — they satisfy the "var is set" check.
 */
function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue; // no key before '='
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** Load .fleet/.env from the given .fleet directory. Returns {} when the file is absent (ENOENT). */
function loadDotEnv(fleetDir: string): Record<string, string> {
  try {
    return parseDotEnv(fs.readFileSync(path.join(fleetDir, '.env'), 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

type ModePreset = {
  mode: string;
  authority: unknown;
  finish?: string;
  report?: string;
};

function loadPresets(): Record<string, ModePreset> {
  const raw = readJsonFile(fileURLToPath(new URL('../../presets/modes.json', import.meta.url)), 'mode presets');
  // Repo-shipped presets/modes.json; shape enforced by test/presets.test.mjs.
  const presets = raw as { modes: Record<string, ModePreset> };
  if (typeof presets.modes !== 'object' || presets.modes === null) fail('mode presets file has no "modes" object');
  return presets.modes;
}

/** `pr/<n>` or a full GitHub PR URL → the PR number; anything else is not a PR target. */
function parsePrTarget(target: string): number | undefined {
  const short = target.match(/^pr\/(\d+)$/);
  if (short) return Number(short[1]);
  const url = target.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/);
  if (url) return Number(url[1]);
  return undefined;
}

/**
 * Resolve a PR target via gh at dispatch (#80): the head branch the job will
 * adopt, the PR title, and the linked issue when exactly one is derivable.
 * Refuses non-open PRs — a merged or closed PR has no branch to continue, and
 * the refusal must land BEFORE any POST reaches the daemon.
 */
function resolvePrTarget(target: string, prNumber: number): {
  number: number;
  branch: string;
  title?: string;
  issue?: number;
} {
  // A full URL goes to gh verbatim (it names the repo); pr/<n> resolves
  // against the current checkout's repo, like every other gh call here.
  const ref = target.startsWith('https://') ? target : String(prNumber);
  const raw = spawnSync(
    'gh',
    ['pr', 'view', ref, '--json', 'number,state,headRefName,title,closingIssuesReferences'],
    { encoding: 'utf8' },
  );
  if (raw.error !== undefined || raw.status !== 0) {
    const reason = (raw.stderr ?? '').trim().split('\n')[0] || `gh exited ${raw.status}`;
    fail(`cannot resolve PR target ${target} via gh: ${reason}`);
  }
  let pr: { number?: unknown; state?: unknown; headRefName?: unknown; title?: unknown; closingIssuesReferences?: unknown };
  try {
    pr = JSON.parse(raw.stdout);
  } catch {
    fail(`cannot resolve PR target ${target}: gh returned unparseable JSON`);
  }
  if (typeof pr.number !== 'number' || typeof pr.headRefName !== 'string' || pr.headRefName === '') {
    fail(`cannot resolve PR target ${target}: gh reported no head branch`);
  }
  if (pr.state !== 'OPEN') {
    fail(`PR #${pr.number} is ${String(pr.state ?? 'unknown')}, not open — followthrough continues only open PRs`);
  }
  const linked = Array.isArray(pr.closingIssuesReferences) && pr.closingIssuesReferences.length === 1
    ? (pr.closingIssuesReferences[0] as { number?: unknown })?.number
    : undefined;
  return {
    number: pr.number,
    branch: pr.headRefName,
    ...(typeof pr.title === 'string' && pr.title !== '' ? { title: pr.title } : {}),
    ...(typeof linked === 'number' ? { issue: linked } : {}),
  };
}

/** A dispatch as asked for, with somewhere to put its progress. */
type DelegateRequest = {
  target: string;
  mode?: string;
  finish?: string;
  manifestPath?: string;
  log: (line: string) => void;
  warn: (line: string) => void;
};

/**
 * One dispatch, however it was asked for. `fleet delegate` parses flags and
 * prints; the cockpit's command line calls this same function (#61) — a second
 * path would mean two sets of rules about manifests, env, images and the ledger.
 * Progress goes to `log`/`warn` rather than the console, because one of the two
 * callers owns the whole screen. Refusals throw, so both surfaces report the
 * same words for the same problem.
 */
async function dispatchDelegate(req: DelegateRequest): Promise<{ jobId: string; state: string }> {
  let target = req.target;
  const manifestPath = req.manifestPath ?? path.join('.fleet', 'manifest.json');

  const rawManifest = readJsonFile(manifestPath, 'manifest');
  const manifestCheck = validateManifest(rawManifest);
  if (!manifestCheck.ok) fail(formatFindings(manifestPath, manifestCheck.errors).join('\n'));
  // Safe: validated against manifest.schema.json just above.
  const manifest = rawManifest as Manifest;

  // Typed PR target (#80): pr/<n> or a GitHub PR URL implies followthrough and
  // adopts the PR's head branch. Resolved via gh — and refused when the PR is
  // not open — before anything is posted.
  const prNumber = parsePrTarget(target);
  let continues: { pr: number; branch: string } | undefined;
  let prTitle: string | undefined;
  if (prNumber !== undefined) {
    if (req.mode !== undefined && req.mode !== 'followthrough') {
      fail(`a PR target implies --mode followthrough; it cannot be dispatched as ${req.mode}`);
    }
    const resolved = resolvePrTarget(target, prNumber);
    continues = { pr: resolved.number, branch: resolved.branch };
    prTitle = resolved.title;
    // Lineage on the board: the linked issue when exactly one is derivable,
    // else the PR reference itself.
    target = resolved.issue !== undefined ? String(resolved.issue) : `pr/${resolved.number}`;
    req.log(`fleet: continuing PR #${resolved.number} (branch ${resolved.branch})`);
  }

  const modes = loadPresets();
  const modeName = req.mode ?? (continues !== undefined ? 'followthrough' : 'implement');
  const preset = modes[modeName];
  if (!preset) fail(`unknown mode "${modeName}" — available: ${Object.keys(modes).join(', ')}`);

  const flagFinish = req.finish;

  // Resolve issue title at dispatch (best-effort; absent degrades gracefully).
  // A PR target already resolved its title from the PR — one gh call, one truth.
  let issueTitle: string | undefined = prTitle;
  if (issueTitle === undefined && /^\d+$/.test(target)) {
    try {
      const raw = spawnSync('gh', ['issue', 'view', target, '--json', 'title', '--jq', '.title'], {
        encoding: 'utf8',
      });
      if (raw.status === 0) {
        const t = raw.stdout.trim();
        if (t) issueTitle = t;
      }
    } catch { /* gh unavailable or not a real issue — proceed without title */ }
  }

  const workOrder: Record<string, unknown> = {
    mode: preset.mode,
    target,
    finish: flagFinish ?? preset.finish ?? manifest.gates?.default_finish ?? 'merge-ready',
    authority: preset.authority,
    report: preset.report ?? 'status-first',
  };
  if (issueTitle !== undefined) workOrder.title = issueTitle;
  if (continues !== undefined) workOrder.continues = continues;
  const orderCheck = validateWorkOrder(workOrder);
  if (!orderCheck.ok) fail(formatFindings('work order', orderCheck.errors).join('\n'));

  const sync: Record<string, string> = {};
  for (const rel of manifest.workspace?.sync ?? []) {
    const file = path.resolve(rel);
    if (!fs.existsSync(file)) fail(`missing sync file: ${rel} (listed in workspace.sync, not found in ${process.cwd()})`);
    sync[rel] = fs.readFileSync(file).toString('base64');
  }

  // Process env takes precedence over .fleet/.env (per-invocation override, CI-friendly).
  const dotEnv = loadDotEnv(path.join('.fleet'));
  const env: Record<string, string> = {};
  for (const name of manifest.env?.vars ?? []) {
    const value = process.env[name] ?? dotEnv[name];
    if (value === undefined) fail(`missing env var: ${name} (not in environment or .fleet/.env)`);
    env[name] = value;
  }

  // Workspace git (#2): resolve the repo URL at dispatch — including the
  // "origin" sentinel — and ship the operator's git identity. The runner
  // activates git mode only when FLEET_GIT_URL is present.
  const repoUrl = manifest.workspace?.repo;
  if (typeof repoUrl === 'string' && repoUrl !== '') {
    const resolved = repoUrl === 'origin' ? gitValue(['remote', 'get-url', 'origin']) : repoUrl;
    if (!resolved) fail('workspace.repo is "origin" but this checkout has no origin remote');
    const name = gitValue(['config', 'user.name']);
    const email = gitValue(['config', 'user.email']);
    if (!name || !email) fail('git identity missing: set git config user.name and user.email — job commits are authored as you');
    // Containers hold no SSH keys. When the job ships a GitHub token, rewrite
    // an ssh github.com remote to https so that token is the credential the
    // runner's git actually uses (gitCredentialEnv in src/runner/git.ts).
    // Without a token, keep the URL as-is: ssh-agent still covers the
    // process provider, and rewriting would strand it.
    const hasGithubToken = env.GH_TOKEN !== undefined || env.GITHUB_TOKEN !== undefined;
    env.FLEET_GIT_URL = hasGithubToken ? toHttpsGitUrl(resolved) : resolved;
    env.FLEET_GIT_NAME = name;
    env.FLEET_GIT_EMAIL = email;
  }

  // Two-layer image model (#5): when harness.cli_version is set, compute the
  // per-repo job image hash, build the image if it doesn't exist locally, and
  // pass the computed tag to the daemon as an image override.
  let imageOverride: string | undefined;
  if (twoLayerEnabled(rawManifest as ImageManifest)) {
    const hash = computeImageHash(rawManifest as ImageManifest);
    const tag = jobImageTag(hash);
    const base = runnerBaseTag(rawManifest as ImageManifest);
    if (!imageExistsLocally(tag)) {
      req.log(`fleet: building job image ${tag} from ${base} ...`);
      buildJobImage({ tag, baseTag: base, manifest: rawManifest as ImageManifest });
      req.log(`fleet: job image ready: ${tag}`);
    } else {
      req.log(`fleet: job image exists (${tag}), skipping build`);
    }
    imageOverride = tag;
  }

  const body: Record<string, unknown> = { workOrder, manifest, env, sync };
  if (imageOverride !== undefined) body.image = imageOverride;

  const res = await daemonCall('POST', '/jobs', body);
  if (res.status !== 201) fail(daemonFailureMessage(res, 'delegate'));
  // Daemon API contract: POST /jobs → 201 {job}.
  const created = res.json as { job: { id: string; state: string } };

  // Append a pointer entry to the local dispatch ledger (gitignored).
  // Pointer only: no status fields — remote is truth.
  const ledgerEntry: Record<string, string> = {
    jobId: created.job.id,
    target,
    mode: preset.mode,
    daemonUrl: describeTarget(),
    at: new Date().toISOString(),
  };
  const ledgerPath = path.join('.fleet', 'dispatched.jsonl');
  try {
    fs.mkdirSync(path.join('.fleet'), { recursive: true });
    fs.appendFileSync(ledgerPath, `${JSON.stringify(ledgerEntry)}\n`);
  } catch {
    // Non-fatal: the job was created; a ledger write failure only affects fleet resume.
    req.warn('fleet: warning: could not write to .fleet/dispatched.jsonl');
  }

  return { jobId: created.job.id, state: created.job.state };
}

async function cmdDelegate(args: string[]): Promise<number> {
  const { values, positionals } = parseCommand(
    args,
    { mode: { type: 'string' }, finish: { type: 'string' }, manifest: { type: 'string' }, watch: { type: 'boolean' } },
    1,
    1,
  );
  const created = await dispatchDelegate({
    target: positionals[0],
    mode: typeof values.mode === 'string' ? values.mode : undefined,
    finish: typeof values.finish === 'string' ? values.finish : undefined,
    manifestPath: typeof values.manifest === 'string' ? values.manifest : undefined,
    log: (line) => console.log(line),
    warn: (line) => console.error(line),
  });
  console.log(`${created.jobId} ${created.state}`);
  if (values.watch === true) return followJob(created.jobId, true);
  return EXIT_OK;
}

// ---------- image ----------

async function cmdImage(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'build') return cmdImageBuild(rest);
  if (!subcommand) {
    console.error('fleet image: subcommand required (build)');
    return EXIT_USAGE;
  }
  console.error(`fleet image: unknown subcommand: ${subcommand}`);
  return EXIT_USAGE;
}

async function cmdImageBuild(args: string[]): Promise<number> {
  const { values } = parseCommand(
    args,
    {
      manifest: { type: 'string' },
      push: { type: 'boolean' },
      registry: { type: 'string' },
      region: { type: 'string' },
    },
    0,
    0,
  );
  const manifestPath = typeof values.manifest === 'string' ? values.manifest : path.join('.fleet', 'manifest.json');
  const rawManifest = readJsonFile(manifestPath, 'manifest');
  const manifestCheck = validateManifest(rawManifest);
  if (!manifestCheck.ok) {
    for (const line of formatFindings(manifestPath, manifestCheck.errors)) console.error(line);
    return EXIT_FAILURE;
  }
  const imageManifest = rawManifest as ImageManifest;
  if (!twoLayerEnabled(imageManifest)) {
    console.error('fleet image build: harness.cli_version is not set — two-layer image model not enabled');
    console.error('  Set harness.cli_version in your manifest to use per-repo job images.');
    return EXIT_FAILURE;
  }

  const hash = computeImageHash(imageManifest);
  const tag = jobImageTag(hash);
  const base = runnerBaseTag(imageManifest);

  if (imageExistsLocally(tag)) {
    console.log(`image exists: ${tag} (base ${base})`);
    console.log('nothing to build — setup inputs have not changed.');
  } else {
    console.log(`building job image: ${tag}`);
    console.log(`  base: ${base}`);
    buildJobImage({ tag, baseTag: base, manifest: imageManifest });
    console.log(`built: ${tag}`);
  }

  if (values.push === true) {
    if (typeof values.registry !== 'string') {
      console.error('fleet image build --push requires --registry <ECR_URI>');
      return EXIT_FAILURE;
    }
    const region = typeof values.region === 'string' ? values.region : undefined;
    console.log(`pushing to ${values.registry} ...`);
    const remoteTag = pushToEcr({ localTag: tag, registryUri: values.registry, region });
    console.log(`pushed: ${remoteTag}`);
  }

  return EXIT_OK;
}

// ---------- job event rendering ----------
// formatEvent, logsNoColor, FleetEvent — imported from ./format.ts

/** Print one NDJSON event line from the daemon. Returns the parsed event on success. */
function printEventLine(line: string, noColor: boolean): FleetEvent | undefined {
  try {
    const event: FleetEvent = JSON.parse(line);
    console.log(formatEvent(event, noColor));
    return event;
  } catch {
    console.log(line); // never crash on a malformed daemon line
    return undefined;
  }
}

// ---------- daemon-backed commands ----------

type OnLine = (line: string) => void;

async function daemonCall(
  method: string,
  reqPath: string,
  body?: unknown,
  onLine?: OnLine,
): Promise<DaemonResponse> {
  try {
    return await request(method, reqPath, body, { onLine });
  } catch (err) {
    // A TCP address means a port-forward is carrying this call, and a dead
    // session is the likeliest cause (#57) — say where to look, not just what broke.
    const tcpHint = '\n  the daemon is reached through a tunnel — open it with `fleet connect`, or run `fleet doctor` for its state';
    const hint = daemonTarget().kind === 'tcp' ? tcpHint : '';
    fail(`cannot reach daemon at ${describeTarget()}: ${errorMessage(err)}${hint}`);
  }
}

/** What a rejected daemon call says, as lines. Shared so every surface says it identically. */
function daemonFailureMessage(res: DaemonResponse, what: string): string {
  // Daemon API contract: schema failures return an errors array; non-schema
  // failures (409 not-blocked, 422 bad option) return an error string.
  const body = res.json as DaemonApiError | undefined;
  if (body && Array.isArray(body.errors)) return formatFindings(what, body.errors).join('\n');
  if (body && typeof body.error === 'string') return what + ' failed: ' + body.error;
  const tail = res.body ? ' ' + res.body.trim() : '';
  return what + ' failed: daemon returned ' + res.status + tail;
}

function daemonFailure(res: DaemonResponse, what: string): number {
  console.error(daemonFailureMessage(res, what));
  return EXIT_FAILURE;
}

type Job = {
  id: string;
  state: string;
  marker?: string;
  reason?: string;
  workOrder?: { mode?: string; target?: string; title?: string };
  updatedAt?: string;
};

function formatJob(job: Job): string {
  const state = formatJobState(job);
  const mode = job.workOrder?.mode ?? '?';
  const rawTarget = job.workOrder?.target ?? '?';
  const title = job.workOrder?.title;
  // Prefer "#<n> <title>" when both an issue number and title are present.
  const ref = /^\d+$/.test(rawTarget) ? `#${rawTarget}` : rawTarget;
  const target = title ? `${ref} ${title}`.slice(0, 60) : rawTarget;
  const updated = typeof job.updatedAt === 'string' ? `  updated=${job.updatedAt}` : '';
  return `${job.id}  ${state}  mode=${mode}  target=${target}${updated}`;
}

async function cmdStatus(args: string[]): Promise<number> {
  const { positionals } = parseCommand(args, {}, 0, 1);
  const jobId = positionals[0];
  if (jobId === undefined) {
    const res = await daemonCall('GET', '/jobs');
    if (res.status !== 200) return daemonFailure(res, 'status');
    // Daemon API contract: GET /jobs → 200 {jobs: [...]}.
    const listed = res.json as { jobs: Job[] };
    if (listed.jobs.length === 0) {
      console.log('no jobs — delegate one with: fleet delegate <target>');
      return EXIT_OK;
    }
    for (const job of listed.jobs) console.log(formatJob(job));
    return EXIT_OK;
  }
  const res = await daemonCall('GET', `/jobs/${encodeURIComponent(jobId)}`);
  if (res.status !== 200) return daemonFailure(res, 'status');
  // Daemon API contract: GET /jobs/:id → 200 {job}.
  const shown = res.json as { job: Job };
  console.log(formatJob(shown.job));
  return EXIT_OK;
}

async function cmdLogs(args: string[]): Promise<number> {
  const { values, positionals } = parseCommand(
    args,
    { after: { type: 'string' }, tools: { type: 'boolean' }, full: { type: 'boolean' } },
    1,
    1,
  );
  const jobId = positionals[0];
  const after = typeof values.after === 'string' ? values.after : undefined;
  const tools = values.tools === true;
  const full = values.full === true;
  if (after !== undefined && !/^-?\d+$/.test(after)) throw new UsageError('--after takes an integer sequence number');
  const query = after === undefined ? '' : `?after=${after}`;
  const noColor = logsNoColor(process.env as Record<string, string | undefined>, process.stdout.isTTY ?? false);
  const onLine = full
    ? (line: string) => { console.log(line); }
    : (line: string) => {
        try {
          const event: FleetEvent = JSON.parse(line);
          // Narrative mode (default): omit progress/pair/agent and tool_use/tool_result log lines.
          // --tools: include tool lines too. --full: already handled above.
          if (!isNarrativeEvent(event, tools)) return;
          console.log(formatEvent(event, noColor));
        } catch {
          console.log(line); // never crash on a malformed daemon line
        }
      };
  const res = await daemonCall('GET', `/jobs/${encodeURIComponent(jobId)}/events${query}`, undefined, onLine);
  if (res.status !== 200) return daemonFailure(res, 'logs');
  return EXIT_OK;
}

/**
 * Read one answer line from stdin for a pending decision.
 * Grammar: "<option-id> [supplementary text]" | "text: <free text>" | "" (skip).
 */
async function readAnswerLine(prompt: string): Promise<{ option?: string; text?: string } | undefined> {
  const readline = await import('node:readline/promises'); // lazy: only in interactive watch mode
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return parseAnswerLine(await rl.question(prompt));
  } finally {
    rl.close();
  }
}

/**
 * Follow a job to a terminal state, printing events. With answerMode, pending
 * decisions are answered from stdin between poll cycles. Watching is a view,
 * never a lifeline: disconnecting changes nothing for the job.
 */
/** Build the events query string for a follow or resume-from-seq request. */
function followQuery(after: number | undefined): string {
  return after === undefined ? '?follow=1' : '?after=' + after + '&follow=1';
}

async function followJob(jobId: string, answerMode: boolean): Promise<number> {
  let after: number | undefined;
  let terminal = false;
  let pendingDecision: FleetEvent | undefined;
  const isTTY = process.stdout.isTTY === true;
  const noColor = logsNoColor(process.env as Record<string, string | undefined>, isTTY);

  while (!terminal) {
    const query = followQuery(after);
    const res = await daemonCall('GET', `/jobs/${encodeURIComponent(jobId)}/events${query}`, undefined, (line) => {
      const event = printEventLine(line, noColor);
      if (!event) return;
      if (typeof event.seq === 'number') after = event.seq;
      if (event.type === 'decision') pendingDecision = event;
      if (event.type === 'answer') pendingDecision = undefined; // answered elsewhere
      if (event.type === 'state' && typeof event.state === 'string' && TERMINAL_STATES.includes(event.state)) {
        terminal = true;
      }
    });
    if (res.status !== 200) return daemonFailure(res, 'attach');
    if (!terminal && answerMode && pendingDecision) {
      const ids = (pendingDecision.options ?? []).map((o) => o.id).join(' | ');
      const answer = await readAnswerLine(`answer [${ids}] ("<id> [note]" or "text: ..." or empty to keep waiting): `);
      if (answer) {
        const posted = await daemonCall('POST', `/jobs/${encodeURIComponent(jobId)}/answer`, answer);
        if (posted.status !== 200) daemonFailure(posted, 'answer'); // print and keep watching
        else pendingDecision = undefined;
      }
    }
  }
  return EXIT_OK;
}

async function cmdAttach(args: string[]): Promise<number> {
  const { values, positionals } = parseCommand(args, { answer: { type: 'boolean' } }, 1, 1);
  return followJob(positionals[0], values.answer === true);
}

async function cmdAnswer(args: string[]): Promise<number> {
  const { values, positionals } = parseCommand(
    args,
    { option: { type: 'string' }, text: { type: 'string' } },
    1,
    1,
  );
  const jobId = positionals[0];
  const body: Record<string, string> = {};
  if (typeof values.option === 'string') body.option = values.option;
  if (typeof values.text === 'string') body.text = values.text;
  if (Object.keys(body).length === 0) throw new UsageError('answer requires --option <id> and/or --text <s>');
  const res = await daemonCall('POST', `/jobs/${encodeURIComponent(jobId)}/answer`, body);
  if (res.status !== 200) return daemonFailure(res, 'answer');
  console.log(`answered ${jobId}`);
  return EXIT_OK;
}

async function cmdCancel(args: string[]): Promise<number> {
  const { positionals } = parseCommand(args, {}, 1, 1);
  const jobId = positionals[0];
  const res = await daemonCall('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`);
  if (res.status !== 200) return daemonFailure(res, 'cancel');
  console.log(`cancelled ${jobId}`);
  return EXIT_OK;
}

// ---------- artifacts ----------

async function cmdArtifactsList(jobId: string): Promise<number> {
  const res = await daemonCall('GET', '/jobs/' + encodeURIComponent(jobId) + '/artifacts');
  if (res.status !== 200) return daemonFailure(res, 'artifacts');
  const body = res.json as { artifacts?: { path: string; bytes: number }[] };
  if (!body.artifacts || body.artifacts.length === 0) {
    console.log('no artifacts');
    return EXIT_OK;
  }
  for (const artifact of body.artifacts) {
    console.log(artifact.path + '  ' + artifact.bytes + ' bytes');
  }
  return EXIT_OK;
}

async function cmdArtifactsGet(jobId: string, rest: string[]): Promise<number> {
  const { values, positionals: getPos } = parseCommand(rest, { out: { type: 'string' } }, 1, 1);
  const artifactPath = getPos[0];
  // Encode each path segment separately so slashes are preserved.
  const encodedPath = artifactPath.split('/').map(encodeURIComponent).join('/');
  const res = await daemonCall('GET', '/jobs/' + encodeURIComponent(jobId) + '/artifacts/' + encodedPath);
  if (res.status !== 200) return daemonFailure(res, 'artifacts get');
  // Daemon returns JSON {path, content (base64), bytes, sha256}.
  const body = res.json as { path?: string; content?: string; bytes?: number; sha256?: string };
  if (!body.content) fail('artifacts get: daemon returned no content');
  const buffer = Buffer.from(body.content, 'base64');
  // Verify end-to-end integrity; the daemon stamps sha256 at store time.
  if (body.sha256) {
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (actual !== body.sha256) fail('artifacts get: sha256 mismatch for ' + artifactPath + ' — content corrupted in transit');
  }
  if (typeof values.out === 'string') {
    const filename = path.basename(artifactPath);
    const outPath = path.join(values.out, filename);
    fs.writeFileSync(outPath, buffer);
    console.log('saved to ' + outPath);
  } else {
    process.stdout.write(buffer);
  }
  return EXIT_OK;
}

async function cmdArtifacts(args: string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    console.error('usage: fleet artifacts <jobId> [list | get <path> [--out <outdir>]]');
    return EXIT_USAGE;
  }
  const [jobId, subcommand, ...rest] = args;
  if (!jobId) {
    console.error('usage: fleet artifacts <jobId> [list | get <path> [--out <outdir>]]');
    return EXIT_USAGE;
  }
  if (!subcommand || subcommand === 'list') return cmdArtifactsList(jobId);
  if (subcommand === 'get') return cmdArtifactsGet(jobId, rest);
  console.error('fleet artifacts: unknown subcommand: ' + subcommand);
  return EXIT_USAGE;
}

// ---------- connect ----------

/**
 * Own the daemon tunnel (#57). Everything but argument parsing lives in
 * ./connect.ts; the provider dispatch it uses is ./tunnel-openers.ts, the CLI's
 * one composition root for operator access.
 */
async function cmdConnect(args: string[]): Promise<number> {
  const { values } = parseCommand(args, { port: { type: 'string' }, detach: { type: 'boolean' } }, 0, 0);
  let port: number | undefined;
  if (typeof values.port === 'string') {
    if (!/^\d+$/.test(values.port)) throw new UsageError('--port takes a port number');
    port = Number(values.port);
    if (port < 1 || port > 65535) throw new UsageError('--port takes a port number');
  }
  try {
    return await runConnect({
      cwd: process.cwd(),
      home: fleetHome(),
      port,
      detach: values.detach === true,
      // bin.mjs, not main.ts: the detached child must start the same way the
      // bin does, because a .ts entry cannot be spawned from an npm-installed
      // copy (type stripping is refused under node_modules — see bin.mjs).
      selfPath: fileURLToPath(new URL('./bin.mjs', import.meta.url)),
      log: (line) => console.log(line),
      warn: (line) => console.error(`fleet connect: ${line}`),
    });
  } catch (err) {
    fail(`fleet connect: ${errorMessage(err)}`);
  }
}

// ---------- cockpit ----------

/**
 * Bare `fleet` on a terminal (#61). The cockpit is a view over the same event
 * stream and answer API as every other command; the only thing wired in here is
 * dispatch, so the CLI keeps owning the one path a work order travels.
 */
async function cmdCockpit(): Promise<number> {
  return await runCockpit({
    cwd: process.cwd(),
    home: fleetHome(),
    env: process.env as Record<string, string | undefined>,
    delegate: (req) =>
      dispatchDelegate({ target: req.target, mode: req.mode, log: req.log, warn: req.warn }),
  });
}

// ---------- doctor ----------

/** Known script interpreters: the first non-interpreter, non-flag token in a pickup command is the script file. */
const INTERPRETERS = new Set(['node', 'bash', 'sh', 'python', 'python3', 'ruby', 'perl']);

/**
 * Extract the script file path from a pickup command like "node .fleet/gate.mjs".
 * Skips the token following -c/--command (it is a shell snippet, not a file).
 * Returns undefined when no file can be identified (e.g. "sh -c '...'").
 */
function gateScriptFile(pickup: string): string | undefined {
  const tokens = pickup.trim().split(WORDS_RE);
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) { skipNext = false; continue; }
    if (token === '-c' || token === '--command') { skipNext = true; continue; }
    if (token.startsWith('-') || INTERPRETERS.has(token)) continue;
    return token;
  }
  return undefined;
}

/**
 * Tunnel state for doctor (#57): a TCP daemon address means a port-forward is
 * carrying every command, and its death is the single most common cause of
 * "cannot reach daemon". Answer the three questions an ECONNREFUSED does not:
 * is the port open, does /health answer, is the endpoint still the current one.
 * A unix-socket daemon has no tunnel and gets no section.
 */
async function doctorTunnel(home: string): Promise<{ notes: string[]; findings: string[] }> {
  const target = daemonTarget();
  if (target.kind !== 'tcp') return { notes: [], findings: [] };
  // Resolving the live endpoint costs cloud API calls; tunnelReport spends them
  // only once the tunnel has already failed a /health check. Each call is
  // bounded by the cloud runner itself (ecs.ts AWS_CLI_TIMEOUT_MS), which kills
  // the child rather than only abandoning the promise — doctor is a diagnostic,
  // and a hung diagnostic is worse than a slow one. A failure here is a note,
  // never a finding: not knowing is not a defect.
  const resolveEndpoint = async (): Promise<string> => {
    const tunnel = await resolveTunnel(process.cwd());
    return (await tunnel.open(tunnel.localPort)).id;
  };
  return await tunnelReport({
    host: target.host,
    port: target.port,
    url: describeTarget(),
    home,
    resolveEndpoint,
  });
}

async function cmdDoctor(args: string[]): Promise<number> {
  const { values } = parseCommand(args, { manifest: { type: 'string' } }, 0, 0);
  const manifestPath =
    typeof values.manifest === 'string' ? values.manifest : path.join('.fleet', 'manifest.json');

  let rawManifest: unknown;
  try {
    rawManifest = readJsonFile(manifestPath, 'manifest');
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`doctor: ${err.message}`);
      return EXIT_FAILURE;
    }
    throw err;
  }
  const manifestCheck = validateManifest(rawManifest);
  if (!manifestCheck.ok) {
    for (const line of formatFindings(manifestPath, manifestCheck.errors)) console.error(line);
    return EXIT_FAILURE;
  }
  // Safe: validated against manifest.schema.json just above.
  const manifest = rawManifest as Manifest;

  const findings: string[] = [];

  // 1. Required tools
  for (const tool of ['git', 'gh']) {
    const res = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (res.error !== undefined || res.status !== 0) {
      findings.push(`tool not found: ${tool}`);
    }
  }

  // 2. Sync files
  for (const rel of manifest.workspace?.sync ?? []) {
    if (!fs.existsSync(rel)) {
      findings.push(`missing sync file: ${rel}`);
    }
  }

  // 3. Env vars — process env first, then .fleet/.env fallback
  const dotEnv = loadDotEnv(path.join('.fleet'));
  for (const name of manifest.env?.vars ?? []) {
    if (process.env[name] === undefined && dotEnv[name] === undefined) {
      findings.push(`unset env var: ${name}`);
    }
  }

  // 4. Gate script: present and runnable
  const pickup = manifest.gates?.pickup;
  if (pickup !== undefined) {
    const scriptFile = gateScriptFile(pickup);
    if (scriptFile !== undefined && !fs.existsSync(scriptFile)) {
      findings.push(`gate script missing: ${scriptFile}`);
    } else {
      const tokens = pickup.trim().split(WORDS_RE);
      const gateRes = spawnSync(tokens[0], tokens.slice(1), { encoding: 'utf8' });
      const code = gateRes.error !== undefined ? -1 : (gateRes.status ?? -1);
      // Exit 2 = "cannot evaluate" (no target) — expected without a dispatch target; not a defect.
      if (code !== 0 && code !== 2) {
        findings.push(`gate script failed: ${pickup} (exit ${code})`);
      }
    }
  }

  // 5. Harness CLI version (skipped when cli_version is not pinned in the manifest)
  const cliVersion = manifest.harness?.cli_version;
  if (cliVersion !== undefined) {
    const cli = manifest.harness?.cli ?? 'claude-code';
    const cliBinary: Record<string, string> = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode' };
    const binary = cliBinary[cli] ?? cli;
    const cliRes = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    if (cliRes.error !== undefined || cliRes.status !== 0) {
      findings.push(`harness CLI not found: ${binary} (manifest expects ${cliVersion})`);
    } else {
      const installed = cliRes.stdout.trim();
      if (installed !== cliVersion) {
        findings.push(`harness CLI version mismatch: installed ${installed}, manifest ${cliVersion}`);
      }
    }
  }

  // 6. Tunnel (#57): when the daemon lives behind a port-forward, say what the
  //    tunnel is doing rather than letting every command report ECONNREFUSED.
  const tunnel = await doctorTunnel(fleetHome());
  for (const note of tunnel.notes) console.log(note);
  findings.push(...tunnel.findings);

  // 7. Retained workspaces (#38): a workspace kept because its work push failed
  //    holds the only copy of that job's work. It is a finding until recovered —
  //    silence here is exactly how hours of agent time disappear.
  for (const record of listRetainedRecords(fleetHome())) {
    const missing = fs.existsSync(record.workspace) ? '' : ' (directory missing)';
    findings.push(
      `retained workspace: ${record.workspace}${missing} (job ${record.jobId}, push failed ${record.at}) — retry with: fleet resume-push ${record.jobId}`,
    );
  }

  if (findings.length === 0) {
    console.log('doctor: clean');
    return EXIT_OK;
  }
  for (const finding of findings) console.error(finding);
  return EXIT_FAILURE;
}

// ---------- resume-push ----------

/**
 * Resolve a retained record after verifying the record and workspace still
 * exist. Prints the appropriate error and returns undefined on any problem so
 * cmdResumePush can exit without duplicating the checks.
 */
function loadRetainedWorkspace(home: string, jobId: string): RetainedRecord | undefined {
  const record = readRetainedRecord(home, jobId);
  if (record === undefined) {
    console.error('no retained workspace for job ' + jobId + ' (looked in ' + retainedDir(home) + ')');
    console.error('container jobs keep their workspace inside the stopped task, not on this host');
    return undefined;
  }
  if (!fs.existsSync(record.workspace)) {
    clearRetainedRecord(home, jobId);
    console.error('retained workspace is gone: ' + record.workspace);
    console.error('record dropped; nothing is recoverable from this host');
    return undefined;
  }
  return record;
}

/**
 * Retry the work push from a workspace the runner kept because its push failed
 * (#38). Reuses the runner's pushWork so the retry commits, pushes, and judges
 * delivery exactly as the original attempt did — no second push path.
 *
 * The workspace is removed only once the remote branch provably contains this
 * HEAD; every other path leaves the directory and the record exactly as they
 * were. Cleanup is never inferred from a push outcome alone.
 */
function cmdResumePush(args: string[]): number {
  const { positionals } = parseCommand(args, {}, 1, 1);
  const jobId = positionals[0];
  const home = fleetHome();
  const record = loadRetainedWorkspace(home, jobId);
  if (!record) return EXIT_FAILURE;
  const { target, branch } = record;
  if (!target || !branch) {
    // The request file existed but did not parse: the workspace was kept on
    // purpose, and guessing a branch or a commit message would be worse.
    console.error(`retained record for ${jobId} is incomplete: ${record.reason ?? 'unknown reason'}`);
    console.error(`the work is at ${record.workspace} — recover it by hand (git -C <path> log/push)`);
    return EXIT_FAILURE;
  }

  let outcome: 'pushed' | 'delivered' | 'clean';
  try {
    outcome = pushWork(record.workspace, target, record.jobId, record.ok !== false, record.base);
  } catch (err) {
    console.error(`push still failing: ${errorMessage(err).split('\n')[0]}`);
    console.error(`workspace kept at ${record.workspace} — retry when the remote is reachable`);
    return EXIT_FAILURE;
  }
  if (outcome === 'clean') {
    console.error(`nothing to push from ${record.workspace} — no commits beyond ${branch}`);
    console.error('workspace kept — inspect it before dropping the record');
    return EXIT_FAILURE;
  }
  // 'delivered' only means the remote branch is ahead of base — it can be ahead
  // with a different commit while this HEAD lives nowhere else. Prove it.
  const head = getHeadSha(record.workspace);
  if (!remoteHasHead(record.workspace, branch)) {
    console.error(`origin/${branch} does not contain ${head} (push outcome: ${outcome})`);
    console.error(`workspace kept at ${record.workspace} — reconcile the branch by hand`);
    return EXIT_FAILURE;
  }

  console.log(
    outcome === 'pushed'
      ? `pushed ${branch} from ${record.workspace} (${head})`
      : `${branch} already carries ${head} on the remote`,
  );
  fs.rmSync(record.workspace, { recursive: true, force: true });
  clearRetainedRecord(home, jobId);
  console.log(`workspace removed: ${record.workspace}`);
  return EXIT_OK;
}

// ---------- resume ----------

type LedgerEntry = {
  jobId: string;
  target: string;
  mode: string;
  daemonUrl: string;
  at: string;
};

type ResumeDecision = {
  id: string;
  question: string;
  options: Array<{ id: string; label?: string; recommended?: boolean }>;
};

/** Fetch the pending decision for a blocked job, or undefined if none. */
async function fetchResumeDecision(jobId: string): Promise<ResumeDecision | undefined> {
  let decision: ResumeDecision | undefined;
  const res = await daemonCall('GET', `/jobs/${encodeURIComponent(jobId)}/events`, undefined, (line) => {
    try {
      const ev = JSON.parse(line) as { type: string; id?: string; question?: string; options?: Array<{ id: string; label?: string; recommended?: boolean }> };
      if (ev.type === 'decision' && ev.id && ev.question && ev.options) {
        decision = { id: ev.id, question: ev.question, options: ev.options };
      }
      if (ev.type === 'answer') decision = undefined; // answered elsewhere
    } catch {
      // ignore malformed event lines
    }
  });
  if (res.status !== 200) {
    console.error(`${jobId}: warning: events fetch returned HTTP ${res.status} — decision may not be shown`);
    return undefined;
  }
  return decision;
}

/**
 * Read the local dispatch ledger, fetch live state for every entry, and print
 * a reconnect-oriented summary: blocked/stale first with open decisions, then
 * active, then a tail of recent terminal jobs.
 */
async function cmdResume(args: string[]): Promise<number> {
  const { values } = parseCommand(args, { answer: { type: 'boolean' } }, 0, 0);
  const answerMode = values.answer === true;

  const ledgerPath = path.join('.fleet', 'dispatched.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    console.log('no dispatched jobs — delegate one with: fleet delegate <target>');
    return EXIT_OK;
  }

  const rawLedger = fs.readFileSync(ledgerPath, 'utf8').trim();
  if (!rawLedger) {
    console.log('no dispatched jobs — delegate one with: fleet delegate <target>');
    return EXIT_OK;
  }

  const entries: LedgerEntry[] = [];
  for (const line of rawLedger.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as LedgerEntry);
    } catch {
      // ignore malformed ledger lines
    }
  }

  if (entries.length === 0) {
    console.log('no dispatched jobs — delegate one with: fleet delegate <target>');
    return EXIT_OK;
  }

  // Fetch live state for each entry. daemonCall fails fast (exit 1) on network
  // errors — never report stale data. 404 = daemon doesn't know this job.
  type ResumeResult = {
    entry: LedgerEntry;
    job?: Job;
    decision?: ResumeDecision;
    unknown?: boolean;   // true: 404 or non-200 from daemon
    fetchError?: string; // set when unknown=true and the cause was a non-404 error
  };

  const results: ResumeResult[] = [];
  for (const entry of entries) {
    const res = await daemonCall('GET', `/jobs/${encodeURIComponent(entry.jobId)}`);
    if (res.status === 404) {
      results.push({ entry, unknown: true });
    } else if (res.status !== 200) {
      // Surface other daemon errors; include the job in the output as unknown so
      // it is never silently dropped from the summary table.
      const errBody = res.json as { error?: string } | undefined;
      const msg = errBody?.error ?? `HTTP ${res.status}`;
      results.push({ entry, unknown: true, fetchError: msg });
    } else {
      const body = res.json as { job: Job };
      const rr: ResumeResult = { entry, job: body.job };
      if (body.job.state === 'blocked') {
        rr.decision = await fetchResumeDecision(entry.jobId);
      }
      results.push(rr);
    }
  }

  // Sort priority: stale-blocked → blocked → running/queued → terminal → unknown.
  const sortKey = (rr: ResumeResult): number => {
    if (rr.unknown) return 100;
    if (!rr.job) return 90;
    const { state, marker } = rr.job;
    if (state === 'blocked' && marker === 'stale') return 0;
    if (state === 'blocked') return 1;
    if (state === 'running' || state === 'queued') return 2;
    return 10; // terminal
  };
  results.sort((a, b) => sortKey(a) - sortKey(b));

  const ACTIVE_STATES = new Set(['blocked', 'running', 'queued']);
  const active = results.filter((rr) => !rr.unknown && rr.job && ACTIVE_STATES.has(rr.job.state));
  const terminal = results.filter((rr) => !rr.unknown && rr.job && !ACTIVE_STATES.has(rr.job.state));
  const unknown = results.filter((rr) => rr.unknown);

  let firstBlocked: ResumeResult | undefined;

  // Active jobs (blocked first, then running/queued).
  for (const rr of active) {
    const job = rr.job!;
    console.log(formatJob(job));
    if (rr.decision) {
      if (!firstBlocked) firstBlocked = rr;
      const dec = rr.decision;
      console.log(`  ? ${dec.question}`);
      for (const opt of dec.options) {
        const rec = opt.recommended ? ' (recommended)' : '';
        const label = opt.label ? `: ${opt.label}` : '';
        console.log(`    - ${opt.id}${rec}${label}`);
      }
      console.log(`  run: fleet answer ${job.id} --option <id>  |  fleet resume --answer`);
    } else if (job.state === 'blocked' && !firstBlocked) {
      firstBlocked = rr;
    }
  }

  // Recent terminal tail (last 5, oldest first within the tail).
  const recentTerminal = terminal.slice(-5);
  for (const rr of recentTerminal) {
    console.log(formatJob(rr.job!));
  }

  // Unknown-to-daemon entries (404 or daemon error). Include daemonUrl so the
  // user knows which daemon was queried and where the job may actually live.
  for (const rr of unknown) {
    const reason = rr.fetchError ? `error: ${rr.fetchError}` : 'unknown to daemon';
    console.log(`${rr.entry.jobId}  ${reason}  target=${rr.entry.target}  daemon=${describeTarget()}  delegated=${rr.entry.at}`);
  }

  if (active.length === 0 && terminal.length === 0 && unknown.length === 0) {
    console.log('no dispatched jobs — delegate one with: fleet delegate <target>');
    return EXIT_OK;
  }

  // --answer: drop into interactive answer loop on the first blocked job.
  if (answerMode) {
    if (!firstBlocked || !firstBlocked.job) {
      console.log('no blocked jobs to answer');
      return EXIT_OK;
    }
    return followJob(firstBlocked.job.id, true);
  }

  return EXIT_OK;
}

// ---------- router ----------

function parseCommand(
  args: string[],
  options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>,
  minPositionals: number,
  maxPositionals: number,
): { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] } {
  let parsed: { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }
  if (parsed.positionals.length < minPositionals) throw new UsageError('missing required argument');
  if (parsed.positionals.length > maxPositionals) {
    throw new UsageError(`unexpected argument: ${parsed.positionals[maxPositionals]}`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(renderBanner(80, !process.stdout.isTTY || 'NO_COLOR' in process.env, detectColorLevel(process.env)) + '\n');
  console.log(HELP);
}

/**
 * Is there a terminal to draw a full-screen view on? A cockpit piped into a file
 * or a CI log is nobody's intent, so bare `fleet` prints help instead.
 * FLEET_FORCE_TTY drives the loop without one, which is how it is tested end to
 * end — an env var rather than a flag, so the command surface stays honest.
 */
function terminalAvailable(): boolean {
  if (process.env.FLEET_FORCE_TTY === '1') return true;
  return (process.stdout.isTTY ?? false) && (process.stdin.isTTY ?? false);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    // Bare `fleet` is the cockpit (#61), where there is a terminal for it.
    if (command === undefined) {
      if (terminalAvailable()) return await cmdCockpit();
      printHelp();
      return EXIT_USAGE;
    }
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return EXIT_OK;
      case 'version':
      case '--version': {
        const pkg = readJsonFile(
          fileURLToPath(new URL('../../package.json', import.meta.url)),
          'package.json',
        ) as { version: string };
        console.log(pkg.version);
        return EXIT_OK;
      }
      case 'init':
        return cmdInit(rest);
      case 'setup':
        return await cmdSetup(rest);
      case 'lint':
        return cmdLint(rest);
      case 'delegate':
        return await cmdDelegate(rest);
      case 'resume':
        return await cmdResume(rest);
      case 'resume-push':
        return cmdResumePush(rest);
      case 'status':
        return await cmdStatus(rest);
      case 'logs':
        return await cmdLogs(rest);
      case 'attach':
        return await cmdAttach(rest);
      case 'answer':
        return await cmdAnswer(rest);
      case 'cancel':
        return await cmdCancel(rest);
      case 'image':
        return await cmdImage(rest);
      case 'artifacts':
        return await cmdArtifacts(rest);
      case 'connect':
        return await cmdConnect(rest);
      case 'doctor':
        return await cmdDoctor(rest);
      default:
        console.error(`unknown command: ${command}\n\n${HELP}`);
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`usage error: ${err.message}\n\nRun \`fleet help\` for usage.`);
      return EXIT_USAGE;
    }
    if (err instanceof CliError) {
      console.error(err.message);
      return EXIT_FAILURE;
    }
    throw err;
  }
}

process.exitCode = await main(process.argv.slice(2));
