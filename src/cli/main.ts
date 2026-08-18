#!/usr/bin/env node
// fleet — operator CLI. Exit codes: 0 ok, 1 failure, 2 usage.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateWorkOrder, jobStates } from '../validate.mjs';
import { request, describeTarget, type DaemonResponse } from './client.ts';
import { toHttpsGitUrl } from '../shared/giturl.ts';
import { cmdBoard, renderBanner, detectColorLevel } from './board.ts';
import { formatEvent, logsNoColor, isNarrativeEvent, type FleetEvent } from './format.ts';
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

Usage: fleet <command> [options]

Commands:
  init [--existing]                        Scaffold .fleet/ (manifest, setup.sh, out/)
  lint [path]                              Validate manifest (+ .fleet/orders/*.json), no daemon
  delegate <target> [--mode m] [--finish rung] [--manifest path] [--watch]
                                           Build a work order and POST it to the daemon
                                           (--watch: follow the job, answer decisions from stdin)
                                           When harness.cli_version is set, computes the per-repo
                                           job image hash, builds on miss, passes tag to daemon.
  image build [--manifest path] [--push] [--registry ECR_URI] [--region AWS_REGION]
                                           Build the per-repo job image (two-layer model).
                                           Skips the build when the computed tag already exists.
  resume [--answer]                        Show live state of jobs delegated from this checkout.
                                           Reads .fleet/dispatched.jsonl; blocked jobs appear first
                                           with their open decision rendered.
                                           (--answer: answer the first blocked job interactively)
  status [jobId]                           List jobs (blocked first) or show one job
  logs <jobId> [--after seq] [--tools] [--full]
                                           Dump job events (default: narrative spine — state, phase,
                                           thinks, decisions, settle; --tools adds tool_use/tool_result;
                                           --full: raw JSON per line)
  attach <jobId> [--answer]                Follow job events until done/cancelled
                                           (--answer: respond to decisions from stdin)
  answer <jobId> [--option id] [--text s]  Answer a blocked job's decision
  cancel <jobId>                           Cancel a job
  board [--once]                           Full-screen live view (--once or non-TTY: static render)
  artifacts <jobId> [list]                 List artifacts delivered by a job
  artifacts <jobId> get <path> [--out dir] Download an artifact (writes to dir/<filename>, or stdout)
  doctor [--manifest path]                 Check local environment against the manifest
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

function formatFindings(file: string, errors: AjvError[]): string[] {
  return errors.map((e) => `${file}: ${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

// ---------- init ----------

const SETUP_STUB = `#!/usr/bin/env sh
# Fleet setup script: everything the job image needs before the harness runs
# (dependencies, build, seed data). Runs with unrestricted egress.
set -eu

echo "fleet setup: replace this stub with your project's setup steps (e.g. npm ci)"
`;

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

function cmdInit(args: string[]): number {
  const { values } = parseCommand(args, { existing: { type: 'boolean' } }, 0, 0);
  const existing = values.existing === true;
  const fleetDir = path.resolve('.fleet');
  const manifestPath = path.join(fleetDir, 'manifest.json');
  const setupPath = path.join(fleetDir, 'setup.sh');
  const gitkeepPath = path.join(fleetDir, 'out', '.gitkeep');

  if (fs.existsSync(manifestPath)) {
    fail(`refusing to overwrite existing ${manifestPath} — remove it first if you really want a fresh scaffold`);
  }
  const setupExists = fs.existsSync(setupPath);
  if (setupExists && !existing) {
    fail(`refusing to overwrite existing ${setupPath} — rerun with --existing to keep it`);
  }

  fs.mkdirSync(path.join(fleetDir, 'out'), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(initManifest(), null, 2)}\n`);
  if (!setupExists) fs.writeFileSync(setupPath, SETUP_STUB, { mode: 0o755 });
  if (!fs.existsSync(gitkeepPath)) fs.writeFileSync(gitkeepPath, '');

  // .gitignore: create with defaults when absent; ensure .env is covered when
  // the file already exists (e.g. an older init omitted it).
  const gitignorePath = path.join(fleetDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, FLEET_GITIGNORE);
  } else {
    const currentIgnore = fs.readFileSync(gitignorePath, 'utf8');
    const lines = currentIgnore.split('\n').map((l) => l.trim());
    // Accept both '.env' and the root-anchored form '/.env'.
    if (!lines.includes('.env') && !lines.includes('/.env')) {
      fs.appendFileSync(gitignorePath, currentIgnore.endsWith('\n') ? '.env\n' : '\n.env\n');
    }
  }

  // .env.example: template for the gitignored .fleet/.env; never clobber.
  const dotEnvExamplePath = path.join(fleetDir, '.env.example');
  if (!fs.existsSync(dotEnvExamplePath)) fs.writeFileSync(dotEnvExamplePath, DOT_ENV_EXAMPLE);

  console.log(`wrote ${manifestPath}`);
  if (setupExists) console.log(`kept existing ${setupPath}`);
  else console.log(`wrote ${setupPath}`);
  console.log(`wrote ${gitkeepPath}`);
  if (existing) console.log(`\n${BROWNFIELD_GUIDANCE}`);
  else console.log('\nEdit .fleet/manifest.json (repo URL, pickup gate) and .fleet/setup.sh before delegating.');
  return EXIT_OK;
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

/** git stdout in cwd, or undefined on any failure. */
function gitValue(args: string[]): string | undefined {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  const out = res.status === 0 ? res.stdout.trim() : '';
  return out === '' ? undefined : out;
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

async function cmdDelegate(args: string[]): Promise<number> {
  const { values, positionals } = parseCommand(
    args,
    { mode: { type: 'string' }, finish: { type: 'string' }, manifest: { type: 'string' }, watch: { type: 'boolean' } },
    1,
    1,
  );
  const target = positionals[0];
  const manifestPath = typeof values.manifest === 'string' ? values.manifest : path.join('.fleet', 'manifest.json');

  const rawManifest = readJsonFile(manifestPath, 'manifest');
  const manifestCheck = validateManifest(rawManifest);
  if (!manifestCheck.ok) {
    for (const line of formatFindings(manifestPath, manifestCheck.errors)) console.error(line);
    return EXIT_FAILURE;
  }
  // Safe: validated against manifest.schema.json just above.
  const manifest = rawManifest as Manifest;

  const modes = loadPresets();
  const modeName = typeof values.mode === 'string' ? values.mode : 'implement';
  const preset = modes[modeName];
  if (!preset) fail(`unknown mode "${modeName}" — available: ${Object.keys(modes).join(', ')}`);

  const flagFinish = typeof values.finish === 'string' ? values.finish : undefined;

  // Resolve issue title at dispatch (best-effort; absent degrades gracefully).
  let issueTitle: string | undefined;
  if (/^\d+$/.test(target)) {
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
  const orderCheck = validateWorkOrder(workOrder);
  if (!orderCheck.ok) {
    for (const line of formatFindings('work order', orderCheck.errors)) console.error(line);
    return EXIT_FAILURE;
  }

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
      console.log(`fleet: building job image ${tag} from ${base} ...`);
      buildJobImage({ tag, baseTag: base, manifest: rawManifest as ImageManifest });
      console.log(`fleet: job image ready: ${tag}`);
    } else {
      console.log(`fleet: job image exists (${tag}), skipping build`);
    }
    imageOverride = tag;
  }

  const body: Record<string, unknown> = { workOrder, manifest, env, sync };
  if (imageOverride !== undefined) body.image = imageOverride;

  const res = await daemonCall('POST', '/jobs', body);
  if (res.status !== 201) return daemonFailure(res, 'delegate');
  // Daemon API contract: POST /jobs → 201 {job}.
  const created = res.json as { job: { id: string; state: string } };
  console.log(`${created.job.id} ${created.job.state}`);

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
    console.error('fleet: warning: could not write to .fleet/dispatched.jsonl');
  }

  if (values.watch === true) return followJob(created.job.id, true);
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

async function daemonCall(
  method: string,
  reqPath: string,
  body?: unknown,
  onLine?: (line: string) => void,
): Promise<DaemonResponse> {
  try {
    return await request(method, reqPath, body, { onLine });
  } catch (err) {
    fail(`cannot reach daemon at ${describeTarget()}: ${errorMessage(err)}`);
  }
}

function daemonFailure(res: DaemonResponse, what: string): number {
  // Daemon API contract: schema failures return {errors: [...ajv error objects]};
  // non-schema failures (409 not-blocked, 422 bad option) return {error: string}.
  const body = res.json as { errors?: AjvError[]; error?: string } | undefined;
  if (body && Array.isArray(body.errors)) {
    for (const line of formatFindings(what, body.errors)) console.error(line);
  } else if (body && typeof body.error === 'string') {
    console.error(`${what} failed: ${body.error}`);
  } else {
    console.error(`${what} failed: daemon returned ${res.status}${res.body ? ` ${res.body.trim()}` : ''}`);
  }
  return EXIT_FAILURE;
}

type Job = {
  id: string;
  state: string;
  marker?: string;
  workOrder?: { mode?: string; target?: string; title?: string };
  updatedAt?: string;
};

function formatJob(job: Job): string {
  const state = typeof job.marker === 'string' ? `${job.state}(${job.marker})` : job.state;
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
    const line = (await rl.question(prompt)).trim();
    if (line === '') return undefined;
    if (line.startsWith('text:')) return { text: line.slice('text:'.length).trim() };
    const [option, ...restWords] = line.split(/\s+/);
    const text = restWords.join(' ');
    return text ? { option, text } : { option };
  } finally {
    rl.close();
  }
}

/**
 * Follow a job to a terminal state, printing events. With answerMode, pending
 * decisions are answered from stdin between poll cycles. Watching is a view,
 * never a lifeline: disconnecting changes nothing for the job.
 */
async function followJob(jobId: string, answerMode: boolean): Promise<number> {
  let after: number | undefined;
  let terminal = false;
  let pendingDecision: FleetEvent | undefined;
  const noColor = logsNoColor(process.env as Record<string, string | undefined>, process.stdout.isTTY ?? false);

  while (!terminal) {
    const query = after === undefined ? '?follow=1' : `?after=${after}&follow=1`;
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

  if (!subcommand || subcommand === 'list') {
    const res = await daemonCall('GET', `/jobs/${encodeURIComponent(jobId)}/artifacts`);
    if (res.status !== 200) return daemonFailure(res, 'artifacts');
    const body = res.json as { artifacts?: { path: string; bytes: number }[] };
    if (!body.artifacts || body.artifacts.length === 0) {
      console.log('no artifacts');
      return EXIT_OK;
    }
    for (const artifact of body.artifacts) {
      console.log(`${artifact.path}  ${artifact.bytes} bytes`);
    }
    return EXIT_OK;
  }

  if (subcommand === 'get') {
    const { values, positionals: getPos } = parseCommand(rest, { out: { type: 'string' } }, 1, 1);
    const artifactPath = getPos[0];
    // Encode each path segment separately so slashes are preserved.
    const encodedPath = artifactPath.split('/').map(encodeURIComponent).join('/');
    const res = await daemonCall('GET', `/jobs/${encodeURIComponent(jobId)}/artifacts/${encodedPath}`);
    if (res.status !== 200) return daemonFailure(res, 'artifacts get');
    // Daemon returns JSON {path, content (base64), bytes, sha256}.
    const body = res.json as { path?: string; content?: string; bytes?: number; sha256?: string };
    if (!body.content) fail('artifacts get: daemon returned no content');
    const buffer = Buffer.from(body.content, 'base64');
    // Verify end-to-end integrity; the daemon stamps sha256 at store time.
    if (body.sha256) {
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== body.sha256) fail(`artifacts get: sha256 mismatch for ${artifactPath} — content corrupted in transit`);
    }
    if (typeof values.out === 'string') {
      const filename = path.basename(artifactPath);
      const outPath = path.join(values.out, filename);
      fs.writeFileSync(outPath, buffer);
      console.log(`saved to ${outPath}`);
    } else {
      process.stdout.write(buffer);
    }
    return EXIT_OK;
  }

  console.error(`fleet artifacts: unknown subcommand: ${subcommand}`);
  return EXIT_USAGE;
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
  const tokens = pickup.trim().split(/\s+/);
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) { skipNext = false; continue; }
    if (token === '-c' || token === '--command') { skipNext = true; continue; }
    if (token.startsWith('-') || INTERPRETERS.has(token)) continue;
    return token;
  }
  return undefined;
}

function cmdDoctor(args: string[]): number {
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
      const tokens = pickup.trim().split(/\s+/);
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

  if (findings.length === 0) {
    console.log('doctor: clean');
    return EXIT_OK;
  }
  for (const finding of findings) console.error(finding);
  return EXIT_FAILURE;
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
  options: Record<string, { type: 'string' | 'boolean' }>,
  minPositionals: number,
  maxPositionals: number,
): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
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

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(renderBanner(80, !process.stdout.isTTY || 'NO_COLOR' in process.env, detectColorLevel(process.env)) + '\n');
        console.log(HELP);
        return command === undefined ? EXIT_USAGE : EXIT_OK;
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
      case 'lint':
        return cmdLint(rest);
      case 'delegate':
        return await cmdDelegate(rest);
      case 'resume':
        return await cmdResume(rest);
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
      case 'board':
        return await cmdBoard(rest);
      case 'image':
        return await cmdImage(rest);
      case 'artifacts':
        return await cmdArtifacts(rest);
      case 'doctor':
        return cmdDoctor(rest);
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
