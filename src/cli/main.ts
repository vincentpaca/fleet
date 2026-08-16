#!/usr/bin/env node
// fleet — operator CLI. Exit codes: 0 ok, 1 failure, 2 usage.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateWorkOrder, jobStates } from '../validate.mjs';
import { request, describeTarget, type DaemonResponse } from './client.ts';
import { cmdBoard } from './board.ts';
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
  status [jobId]                           List jobs (blocked first) or show one job
  logs <jobId> [--after seq]               Dump job events
  attach <jobId> [--answer]                Follow job events until done/cancelled
                                           (--answer: respond to decisions from stdin)
  answer <jobId> [--option id] [--text s]  Answer a blocked job's decision
  cancel <jobId>                           Cancel a job
  board [--once]                           Full-screen live view (--once or non-TTY: static render)
  doctor                                   Environment checks (Phase 1 stub)
  version                                  Print version and exit

Flags:
  --version                                Print version and exit

Daemon address: FLEET_DAEMON_URL, or unix socket at $FLEET_HOME/daemon.sock (default ~/.fleet).`;

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
// on the same repo can point at different infra).
const FLEET_GITIGNORE = `out/
infra/
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
  const gitignorePath = path.join(fleetDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) fs.writeFileSync(gitignorePath, FLEET_GITIGNORE);

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

  for (const line of findings) console.error(line);
  if (findings.length > 0) return EXIT_FAILURE;
  console.log(`lint ok: ${checked} file(s) valid`);
  return EXIT_OK;
}

// ---------- delegate ----------

type Manifest = {
  workspace?: { repo?: string; sync?: string[] };
  env?: { vars?: string[] };
  gates?: { default_finish?: string };
  harness?: { cli?: string; cli_version?: string };
};

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
  const workOrder = {
    mode: preset.mode,
    target,
    finish: flagFinish ?? preset.finish ?? manifest.gates?.default_finish ?? 'merge-ready',
    authority: preset.authority,
    report: preset.report ?? 'status-first',
  };
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

  const env: Record<string, string> = {};
  for (const name of manifest.env?.vars ?? []) {
    const value = process.env[name];
    if (value === undefined) fail(`missing env var: ${name} (listed in manifest env.vars, not set in this shell)`);
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
    env.FLEET_GIT_URL = resolved;
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

type FleetEvent = {
  seq: number;
  type: string;
  state?: string;
  reason?: string;
  marker?: string;
  text?: string;
  value?: number;
  id?: string;
  question?: string;
  options?: Array<{ id: string; label?: string; recommended?: boolean }>;
  decision?: string;
  option?: string;
  by?: string;
  rung?: string;
  minutes?: number;
  report?: { status?: string; next_action?: string };
};

function formatEvent(event: FleetEvent): string {
  const head = `[${event.seq}] ${event.type}`;
  switch (event.type) {
    case 'state': {
      const extras = [event.reason && `reason=${event.reason}`, event.marker && `marker=${event.marker}`]
        .filter(Boolean)
        .join(' ');
      return `${head} ${event.state}${extras ? ` ${extras}` : ''}`;
    }
    case 'phase':
    case 'think':
    case 'log':
      return `${head} ${event.text ?? ''}`;
    case 'progress':
      return `${head} ${Math.round((event.value ?? 0) * 100)}%`;
    case 'decision': {
      const options = (event.options ?? [])
        .map((o) => `  - ${o.id}${o.recommended ? ' (recommended)' : ''}${o.label ? `: ${o.label}` : ''}`)
        .join('\n');
      return `${head} ${event.id}: ${event.question}\n${options}\n  answer with: fleet answer <jobId> --option <id> [--text s]`;
    }
    case 'answer':
      return `${head} ${event.decision} → ${event.option ?? '(free text)'}${event.text ? ` "${event.text}"` : ''}${event.by ? ` by ${event.by}` : ''}`;
    case 'settle':
      return `${head} rung=${event.rung ?? '?'} status=${event.report?.status ?? '?'}${event.report?.next_action ? ` next: ${event.report.next_action}` : ''}`;
    default:
      return `${head} ${JSON.stringify({ ...event, seq: undefined, type: undefined })}`;
  }
}

function printEventLine(line: string): FleetEvent | undefined {
  try {
    const event: FleetEvent = JSON.parse(line);
    console.log(formatEvent(event));
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
  workOrder?: { mode?: string; target?: string };
  updatedAt?: string;
};

function formatJob(job: Job): string {
  const state = typeof job.marker === 'string' ? `${job.state}(${job.marker})` : job.state;
  const mode = job.workOrder?.mode ?? '?';
  const target = job.workOrder?.target ?? '?';
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
  const { values, positionals } = parseCommand(args, { after: { type: 'string' } }, 1, 1);
  const jobId = positionals[0];
  const after = typeof values.after === 'string' ? values.after : undefined;
  if (after !== undefined && !/^-?\d+$/.test(after)) throw new UsageError('--after takes an integer sequence number');
  const query = after === undefined ? '' : `?after=${after}`;
  const res = await daemonCall('GET', `/jobs/${encodeURIComponent(jobId)}/events${query}`, undefined, printEventLine);
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

  while (!terminal) {
    const query = after === undefined ? '?follow=1' : `?after=${after}&follow=1`;
    const res = await daemonCall('GET', `/jobs/${encodeURIComponent(jobId)}/events${query}`, undefined, (line) => {
      const event = printEventLine(line);
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

function cmdDoctor(args: string[]): number {
  parseCommand(args, {}, 0, 0);
  console.error('doctor: NOT IMPLEMENTED — Phase 1 stub.');
  console.error('Planned checks: docker CLI, aws CLI, daemon socket reachability, FLEET_HOME layout.');
  console.error('Until then: `fleet lint` validates your manifest and `fleet status` proves the daemon is up.');
  return EXIT_FAILURE;
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
