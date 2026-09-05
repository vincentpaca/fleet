// End to end against a real repo that is not this one (#224).
//
// Every job Fleet has ever run targeted its own dogfood repo, driven by
// claude-code. Two things are therefore unproven: that Fleet works against a
// foreign repo, and that any other harness CLI can satisfy the job contract.
// This file is the axis both of those live on — one test per harness, all
// three dispatching against the *same* committed `cli: "claude-code"` manifest
// in the target repo, because an override short-circuits above the cli guard
// (src/runner/harness.ts:104 returns before the `cli !== 'claude-code'` refusal
// at :113).
//
// What it proves, and what it deliberately does not: the settle report is read
// off `.fleet/out/report.json` on disk (src/runner/settle.ts:150-163), so
// DELIVERY is harness-agnostic and every row asserts it. The TRANSCRIPT is not
// — src/runner/translate.ts speaks claude-code `stream-json` and has no adapter
// registry — so only the row whose `translated` flag is set makes a claim about
// log events. That asymmetry is the point: this test makes the boundary
// visible rather than pretending it isn't there.
//
// Substrate is Docker, not ProcessProvider (which runs the harness on the host
// and tests neither the image nor the privilege drop) and not ECS
// (src/providers/ecs.ts:589 refuses per-job image overrides, so one deployment
// serves exactly one harness CLI). Docker is the only substrate that gives
// each row its own image, which is what makes the multi-harness axis buildable.
//
//   FLEET_TARGET_REPO_URL=https://github.com/<owner>/<repo>.git \
//   GH_TOKEN=... CLAUDE_CODE_OAUTH_TOKEN=... node --test test/e2e-foreign-repo.test.ts
//
// The target repo carries the scaffold (`.fleet/manifest.json`,
// `.claude/commands/qa.md`, `README.md`); see the issue. Nothing about it —
// name, owner or URL — belongs in this tree, which is why the pointer is an
// env var (docs/decisions.md#d10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { imageExistsLocally } from '../src/cli/images.ts';
import { gitCredentialEnv, jobBranch } from '../src/runner/git.ts';
import { startDockerLoop, removeJobContainer, type LoopEvent } from './docker-loop.ts';

const run = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');

/**
 * The dispatch target. A single prose token, so `dispatchShape` gives
 * `publish:false` and `finish:'inspected'`: no draft PR, and a branch name with
 * no sanitisation surprises. The target repo's manifest must carry no
 * `gates.default_finish` or `reachableRepoDefault` (src/cli/dispatch.ts:130)
 * would override `inspected` with the repo default.
 */
const TARGET = 'qa-probe';

/** What the target repo's committed `/qa` command writes, and the content it must carry. */
const ARTIFACT = 'qa-probe.txt';
const ARTIFACT_CONTENT = 'qa-probe ok';

/**
 * The scaffold report's `next_action`, asserted instead of `status`. A status
 * check is not falsifiable here: src/runner/settle.ts:100-102 synthesises
 * `{status:'READY', next_action:'review the draft PR'}` whenever a PR exists
 * and no report was found on disk. Nothing in the runner can produce this
 * string, so only the harness having written the file makes it appear.
 */
const NEXT_ACTION = 'qa probe complete';

/**
 * Real model work, not a fake harness measured in milliseconds — do not copy
 * the 30s deadline the other e2e tests use. The scaffold's `limits.wall_clock`
 * is the other half of the bound: without both, a wedged job hangs `npm test`
 * until the daemon's 20m idle backstop, which a chatty harness never trips.
 */
const DEADLINE_MS = 15 * 60 * 1000;

/** How long to wait for container-to-host routing to come good before giving up. */
const REACHABILITY_WAIT_MS = 3 * 60 * 1000;

/**
 * A git config shipped into the sandbox, and the reason it has to exist.
 *
 * When the target is a bare repo on this machine it is mounted into the
 * container, where it belongs to a uid the container has never heard of. Git
 * then refuses it as "dubious ownership" (CVE-2022-24765) and the job dies at
 * the clone. Docker Desktop hides this by presenting mounts as owned by the
 * accessing user, so it reproduces only on Linux — which is to say, only in CI.
 *
 * safe.directory is honoured from protected scopes alone: GIT_CONFIG_COUNT and
 * `-c` are deliberately ignored for it, so the value has to arrive as a file
 * that GIT_CONFIG_GLOBAL points at. It rides workspace.sync because sync files
 * are materialised before the clone and preserveDispatchFiles only reads them,
 * so the file is on disk exactly when git looks.
 */
const GITCONFIG_PATH = '.fleet/e2e-gitconfig';

/** The command file the target repo's author wrote; `setup repo` points the manifest at it. */
const COMMAND_PATH = '.claude/commands/task.md';

/**
 * Every env var name the generated manifest declares. Dispatch resolves each
 * one and refuses on any that is `undefined` (src/cli/main.ts:806), so a row
 * supplies '' for the credentials it does not use.
 */
const ENV_VARS = [
  'FLEET_HARNESS_CMD',
  'GH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENCODE_AUTH_B64',
  'NODE_EXTRA_CA_CERTS',
  'GIT_CONFIG_GLOBAL',
];

/**
 * The prompt the non-claude rows carry.
 *
 * A `FLEET_HARNESS_CMD` override returns before the runner builds anything
 * (src/runner/harness.ts:104), which means it suppresses both the derived
 * `/<command> <target>` prompt AND the injected output contract. So an
 * override row has to say both itself. It points at the target repo's own
 * command file rather than restating the task, so all three rows are driven by
 * one source of truth and a change to the task cannot make the rows disagree.
 */
/** Overridable so a machine with different provider access can still run the row. */
/** The command file body, mirroring what a hosted target repo commits. */
const TASK_BODY = [
  'Do exactly these two things and nothing else.',
  '',
  '1. Write `.fleet/out/artifacts/qa-probe.txt` whose entire content is the single line:',
  '',
  '   qa-probe ok',
  '',
  '2. Write `.fleet/out/report.json` with exactly this content:',
  '',
  '   {"status":"READY","verification":["wrote artifacts/qa-probe.txt"],"not_done":[],"next_action":"qa probe complete"}',
  '',
  'Do not add any other key to the report. Then stop.',
  '',
].join('\n');

const OMP_MODEL = process.env.FLEET_OMP_MODEL ?? 'gpt-5';
const OPENCODE_MODEL = process.env.FLEET_OPENCODE_MODEL ?? 'openai/gpt-5';

const OVERRIDE_PROMPT =
  'Read .claude/commands/task.md in this repository and do exactly what it says, '
  + 'including the exact file paths it names. Artifacts belong under .fleet/out/artifacts/; '
  + 'the report is not an artifact and belongs at .fleet/out/report.json exactly. '
  + 'Do not ask questions; there is nobody to answer them.';

type HarnessRow = {
  id: string;
  /**
   * The runner base image this row's CLI lives in. Deliberately NOT a host
   * `PATH` probe: under Docker the binary is in the image, so `onPath()` would
   * skip rows that would have worked. A built image whose CLI is broken fails
   * loudly at the harness spawn, which is the honest outcome.
   */
  image: string;
  /**
   * The row's `FLEET_HARNESS_CMD`. Empty string is deliberate for claude-code:
   * src/cli/main.ts:806 hard-fails a declared-but-*unset* var, while '' is
   * falsy at src/runner/harness.ts:104 — so the row takes the derived-command
   * path production uses (the `/qa <target>` prompt, the OUTPUT_CONTRACT
   * injection, the version probe) instead of the escape hatch that
   * short-circuits above all of it. The harness with an adapter is tested
   * through its adapter.
   *
   * `undefined` means no invocation string has been pinned for that CLI yet,
   * and the row cannot run.
   */
  command: string | undefined;
  /** Credentials the row still needs, each phrased as its own skip reason. */
  missingCredentials: () => string[];
  /** Whether src/runner/translate.ts can read this CLI's stream format. */
  translated: boolean;
};

const ROWS: HarnessRow[] = [
  {
    id: 'claude-code',
    image: 'fleet-runner:claude-code-latest',
    command: '',
    // The container has its own HOME, so the ~/.claude/.credentials.json a
    // `claude /login` session leaves on the host never reaches the job — the
    // token is the only channel, and DockerProvider.envFileContents
    // (src/providers/docker.ts:64) carries it from the manifest's env.vars.
    missingCredentials: () =>
      process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? []
        : ['CLAUDE_CODE_OAUTH_TOKEN unset or empty (a host `claude /login` does not reach the container)'],
    translated: true,
  },
  {
    id: 'codex',
    image: 'fleet-runner:codex-latest',
    // Authenticated with an API key rather than the ChatGPT sign-in, and that
    // is load-bearing. Admin-enforced requirements.toml attaches to a
    // *workspace sign-in*: on a business plan it pins the filesystem read-only
    // and forces an approval policy that `codex exec` cannot answer ("file
    // change approval is not supported in exec mode"), so every write is
    // declined whatever flags it is given — verified against every sandbox
    // mode, a trusted project entry, a TTY, and bubblewrap with relaxed
    // seccomp. An API key is not a workspace session, so no managed
    // requirements arrive and this command alone governs the run. opencode
    // reached the same place by the same route: its credential store holds API
    // keys, which is why it never met any of this.
    //
    // Bypassing codex's own sandbox is deliberate rather than reckless: the
    // container IS the sandbox, so a second one nested inside it can only
    // subtract. It also does not work here — codex's Linux sandbox wants
    // namespaces Docker withholds and fails with a namespace configuration
    // error even once policy permits it.
    // The key has to reach codex through its auth file, not the environment:
    // OPENAI_API_KEY alone is ignored and the API answers 401 "missing
    // bearer". Written here rather than in the target repo's setup script
    // because setup.sh is generated by `fleet setup repo` and knows nothing
    // about harnesses — this is the row's own business.
    command:
      `sh -c 'mkdir -p "$HOME/.codex" && `
      + `printf "{\\"auth_mode\\":\\"apikey\\",\\"OPENAI_API_KEY\\":\\"%s\\"}" "$OPENAI_API_KEY" > "$HOME/.codex/auth.json" && `
      + `chmod 600 "$HOME/.codex/auth.json" && `
      + `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${JSON.stringify(JSON.stringify(OVERRIDE_PROMPT))}'`,
    missingCredentials: () =>
      process.env.OPENAI_API_KEY
        ? []
        : ['OPENAI_API_KEY unset — a ChatGPT sign-in carries managed requirements that decline every write in exec mode'],
    translated: false,
  },
  {
    id: 'opencode',
    image: 'fleet-runner:opencode-latest',
    // The model is pinned rather than left to the default. opencode picks a
    // default per its own config, and when that lands on a model the operator's
    // key cannot reach it exits non-zero with "Model not found" — after having
    // already edited and pushed, so the run looks like a harness that did the
    // work and then failed. Naming the model makes the row depend on a
    // credential the operator demonstrably has instead of on opencode's
    // default drifting.
    command: `opencode run --model ${OPENCODE_MODEL} ${JSON.stringify(OVERRIDE_PROMPT)}`,
    missingCredentials: () =>
      process.env.OPENCODE_AUTH_B64
        ? []
        : ['OPENCODE_AUTH_B64 unset — export it with: export OPENCODE_AUTH_B64=$(base64 < ~/.local/share/opencode/auth.json)'],
    translated: false,
  },
  {
    // "oh my pi" — @oh-my-pi/pi-coding-agent, binary `omp`. Added because the
    // escape hatch is the point: nothing in src/ knows this harness exists, and
    // it still runs. `-p` is its non-interactive mode and `--auto-approve`
    // skips the tool prompts no one is there to answer; the model is named for
    // the same reason opencode's is, so the row depends on a credential the
    // operator demonstrably has rather than on a default that may drift.
    id: 'omp',
    image: 'fleet-runner:omp-latest',
    command: `omp -p --auto-approve --model ${OMP_MODEL} ${JSON.stringify(OVERRIDE_PROMPT)}`,
    missingCredentials: () =>
      process.env.OPENAI_API_KEY ? [] : ['OPENAI_API_KEY unset — omp reads provider keys from the environment'],
    translated: false,
  },
  {
    // A harness that is not a model at all: a shell one-liner writing exactly
    // what the probe task asks for. It proves the delivery path — setup repo,
    // clone, gate, harness spawn, report read, artifact collection, settle —
    // without a provider account, a token, or a cent of spend, which is what
    // makes it the row CI can run on every pull request. The four real rows
    // cover "does this CLI work"; this one covers "does Fleet work", and only
    // the second needs to gate a merge.
    id: 'stub',
    image: 'fleet-runner:claude-code-latest',
    command:
      `sh -c 'mkdir -p .fleet/out/artifacts && `
      + `printf "%s\\n" ${JSON.stringify(ARTIFACT_CONTENT)} > .fleet/out/artifacts/${ARTIFACT} && `
      + `printf "%s" ${JSON.stringify(JSON.stringify({
          status: 'READY',
          verification: [`wrote artifacts/${ARTIFACT}`],
          not_done: [],
          next_action: NEXT_ACTION,
        }))} > .fleet/out/report.json'`,
    missingCredentials: () => [],
    translated: false,
  },
];

/**
 * Where a mounted extra CA lands inside the container. Only used when the host
 * has one.
 */
const CONTAINER_CA = '/etc/fleet-extra-ca.pem';

/** The host's extra CA bundle, when it has one and the file is really there. */
function hostCaFile(): string | undefined {
  const path = process.env.NODE_EXTRA_CA_CERTS;
  return path && existsSync(path) ? path : undefined;
}

/**
 * A TLS-inspecting proxy (corporate networks routinely run one) reissues
 * certificates under a private root. The host trusts it — that is what
 * NODE_EXTRA_CA_CERTS on the host means — but a container is a fresh trust
 * store, so the harness's calls to its own model API fail to verify and the
 * job dies for a reason that looks nothing like a proxy. When the host has
 * such a CA, hand the container the same one; when it does not, add nothing.
 */
function caMountArgs(): string[] {
  const ca = hostCaFile();
  return ca === undefined ? [] : ['-v', `${ca}:${CONTAINER_CA}:ro`];
}

/**
 * When the target is a bare repo on this machine, the container has to be able
 * to reach it — its filesystem is its own, so a host path resolves to nothing
 * and the job dies at the clone having logged almost nothing. Mounted at the
 * SAME absolute path it has on the host, because the URL the runner receives
 * is whatever `git remote get-url origin` reported at dispatch, and rewriting
 * that would mean teaching the CLI about this test. Read-write: the job pushes
 * its claim branch there, which is the whole point of a foreign remote.
 *
 * Empty for a hosted target, which the container reaches over the network like
 * any other.
 */
function targetMountArgs(): string[] {
  if (process.env.FLEET_TARGET_REPO_URL) return [];
  const bare = targetRepoUrl();
  return ['-v', `${bare}:${bare}`];
}

/**
 * A foreign repository, without needing GitHub.
 *
 * `FLEET_TARGET_REPO_URL` points at a real remote when someone wants the live
 * article — network clone, gh lookups, a token. Absent, this seeds a bare repo
 * in tmp with the same shape: a small project, its own test suite, and the
 * command file describing the task. It is every bit as foreign as a hosted one
 * — what the test cares about is that the repository is not Fleet — and it
 * needs no secret, no token and no write access to anything, so the stub row
 * runs on any checkout and in CI with nothing configured.
 *
 * A regression gate that requires provisioning a personal access token is a
 * gate that runs nowhere.
 */
let seededRemote: string | undefined;

function targetRepoUrl(): string {
  const configured = process.env.FLEET_TARGET_REPO_URL;
  if (configured) return configured;
  if (seededRemote !== undefined) return seededRemote;

  const dir = mkdtempSync(join(tmpdir(), 'fleet-target-remote-'));
  const bare = join(dir, 'target.git');
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  mkdirSync(join(seed, 'src'), { recursive: true });
  mkdirSync(join(seed, 'test'), { recursive: true });
  mkdirSync(join(seed, '.claude', 'commands'), { recursive: true });

  writeFileSync(join(seed, 'package.json'), JSON.stringify({
    name: 'slugmaker', version: '0.3.1', type: 'module',
    scripts: { test: 'node --test test/*.test.js' },
  }, null, 2) + '\n');
  writeFileSync(join(seed, 'src', 'slug.js'),
    'export function slugify(text) {\n'
    + "  if (typeof text !== 'string') throw new TypeError('slugify expects a string');\n"
    + "  return text.toLowerCase().replace(/[\\s_]+/g, '-').replace(/[^a-z0-9-]+/g, '')\n"
    + "    .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');\n"
    + '}\n');
  writeFileSync(join(seed, 'test', 'slug.test.js'),
    "import { test } from 'node:test';\n"
    + "import assert from 'node:assert/strict';\n"
    + "import { slugify } from '../src/slug.js';\n"
    + "test('lowercases and hyphenates', () => { assert.equal(slugify('Hello World'), 'hello-world'); });\n"
    + "test('drops unsafe characters', () => { assert.equal(slugify('Wow!!! Really???'), 'wow-really'); });\n"
    + "test('rejects non-strings', () => { assert.throws(() => slugify(null), TypeError); });\n");
  writeFileSync(join(seed, COMMAND_PATH), TASK_BODY);

  const git = (args: string[]) => execFileSync('git', [
    '-c', 'user.name=fleet-e2e', '-c', 'user.email=fleet-e2e@example.com', ...args,
  ], { cwd: seed, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'slugmaker']);
  git(['push', '-q', bare, 'main']);

  seededRemote = bare;
  return bare;
}

/**
 * gh-as-credential-helper for the test process's own git calls (clone, the
 * branch check, the cleanup delete). The runner installs its copy inside the
 * container and it never reaches here, and this process has no helper of its
 * own — so an https push would prompt or fail without this.
 */
function gitEnv(): NodeJS.ProcessEnv {
  // The empty `credential.helper` first is not decoration: an operator machine
  // usually has an OS-keychain helper in ~/.gitconfig, and git asks helpers in
  // order and takes the first answer. With two GitHub accounts on the machine
  // that answer is the wrong one, and a private target repo then reports
  // "Repository not found" — an auth failure wearing a 404's clothes. An empty
  // value resets the list, so gh's helper is the only one asked. The runner
  // never needs this: its container has no helper to displace.
  const cleared = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
  // gitCredentialEnv appends to the inherited entries rather than clobbering
  // them (#139), so the reset survives and the helper lands at index 1.
  return { ...cleared, ...gitCredentialEnv(cleared) };
}

/** What `docker image inspect` calls this host's architecture. */
function hostDockerArch(): string {
  return process.arch === 'x64' ? 'amd64' : process.arch;
}

/**
 * The image's architecture, or undefined when it cannot be read.
 *
 * Worth a prerequisite of its own because the failure it prevents is silent
 * and expensive: `images/build.sh` targets the *deployment's* architecture, so
 * an operator who has deployed to ECS has an amd64 `fleet-runner:<cli>-latest`
 * sitting in their local docker. On an arm64 host that image runs under
 * emulation, and an emulated container started with `docker run -d` — which is
 * exactly how DockerProvider starts it — exits immediately with no logs at
 * all. The runner never posts `state: running`, so the job sits `queued` until
 * the deadline and the only evidence is a 15-minute timeout on a container
 * that left nothing behind. Foreground runs of the same image work, which
 * makes it worse to diagnose. Fail fast and name the rebuild instead.
 */
function imageArch(tag: string): string | undefined {
  try {
    return execFileSync('docker', ['image', 'inspect', tag, '--format', '{{.Architecture}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Every prerequisite this row is still missing, or [] when it can run. */
function unmetPrerequisites(row: HarnessRow): string[] {
  const missing = row.missingCredentials();
  if (row.command === undefined) missing.push(`no FLEET_HARNESS_CMD invocation is pinned for ${row.id}`);
  if (!imageExistsLocally(row.image)) {
    missing.push(`runner image ${row.image} is not built`);
    return missing;
  }
  const arch = imageArch(row.image);
  const host = hostDockerArch();
  if (arch !== undefined && arch !== host) {
    missing.push(
      `runner image ${row.image} is ${arch} but this host is ${host} — an emulated container dies silently when started detached. `
        + `Rebuild it: docker build --platform linux/${host} --build-arg HARNESS_CLI=${row.id} -t ${row.image} -f images/runner/Dockerfile .`,
    );
  }
  return missing;
}

/**
 * A fresh checkout of the target repo, which the CLI child gets as its cwd.
 * Never `process.chdir`: nothing in src/ or test/ does, and a foreign checkout
 * inside the repo tree would land in the scanners' path. Dispatching from the
 * checkout is also what makes the manifest's `workspace.repo: "origin"`
 * sentinel resolve (src/cli/main.ts:824-825), so the target repo's own committed
 * manifest is the artifact under test.
 */
async function cloneTargetRepo(): Promise<string> {
  const project = mkdtempSync(join(tmpdir(), 'fleet-target-proj-'));
  await run('git', ['clone', '--quiet', targetRepoUrl(), project], { env: gitEnv() });
  return project;
}

/** Every branch on the target remote, as full ref names. */
function remoteHeads(): string[] {
  const listed = execFileSync('git', ['ls-remote', '--heads', targetRepoUrl()], { env: gitEnv(), encoding: 'utf8' });
  return listed
    .split('\n')
    .map((line) => line.split('\t')[1])
    .filter((ref): ref is string => typeof ref === 'string' && ref !== '');
}

/**
 * Leave the remote as we found it. Scoped to this run's own job id, because
 * `node --test` runs files concurrently and two developers may share one QA
 * repo. The prefix match is not an equality check on purpose: #30's auto-retry
 * renames a dead claim to `<branch>-attempt<n-1>` rather than deleting it
 * (src/runner/git.ts:272-275), so those have to go too.
 */
function deleteJobRefs(jobId: string): void {
  const prefix = `refs/heads/${jobBranch(TARGET, jobId)}`;
  try {
    const mine = remoteHeads().filter((ref) => ref.startsWith(prefix));
    if (mine.length === 0) return;
    execFileSync('git', ['push', '--quiet', targetRepoUrl(), ...mine.map((ref) => `:${ref}`)], {
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Best effort: a cleanup failure must not mask the assertion that failed
    // first, but it must not pass silently either.
    console.error(`e2e-foreign-repo: could not delete ${prefix}* from the target remote: ${String(err)}`);
  }
}

/**
 * The env the CLI child dispatches with. DockerProvider builds the container
 * env from `spec.env` alone — the manifest's `env.vars` resolved at dispatch —
 * so nothing is inherited the way ProcessProvider would inherit it, and every
 * declared var has to resolve here. Dispatch rejects only `undefined`, so a
 * row supplies '' for the credentials it does not use.
 */
function dispatchEnv(row: HarnessRow, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FLEET_DAEMON_URL: `http://127.0.0.1:${port}`,
    // Tests own their state (#136): the CLI is a pure client here (the daemon
    // above owns the real home), but nothing may reach ~/.fleet by accident.
    FLEET_HOME: mkdtempSync(join(tmpdir(), 'fleet-qa-home-')),
    FLEET_HARNESS_CMD: row.command,
    // Every credential the scaffold declares must resolve, including the ones
    // this row does not use: dispatch rejects `undefined` and accepts ''. The
    // non-claude credentials ride base64 rather than workspace.sync because a
    // declared-but-missing sync file fails EVERY dispatch, including this row.
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENCODE_AUTH_B64: process.env.OPENCODE_AUTH_B64 ?? '',
    GH_TOKEN: process.env.GH_TOKEN ?? '',
    // Points at the mount, not at the host path: the container's filesystem is
    // its own. Empty when the host has no extra CA, which is the normal case.
    NODE_EXTRA_CA_CERTS: hostCaFile() === undefined ? '' : CONTAINER_CA,
    // A container path, and this env is also the CLI child's, so it replaces
    // the HOST's global config too — which is where the operator's git
    // identity lives, and dispatch refuses without one. The identity is
    // therefore supplied at command scope, which git honours for user.* (only
    // safe.directory is restricted to protected scopes, which is the whole
    // reason the file has to travel).
    GIT_CONFIG_GLOBAL: `/workspace/${GITCONFIG_PATH}`,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'fleet-e2e',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'fleet-e2e@example.com',
  };
}

/** One line per event, for a failure message that names what actually happened. */
function digest(events: LoopEvent[]): string {
  return events.map((e) => `${e.type}${typeof e.text === 'string' ? ` ${e.text}` : ''}`).join(' | ');
}

/**
 * The runner's own note when it dropped an invalid report — the settle
 * validates the block in situ with `unevaluatedProperties: false`
 * (src/runner/settle.ts:109-121), so one extra key in report.json fails the
 * next_action assertion for a reason that has nothing to do with the harness.
 * This is where a builder should look when that happens.
 */
function reportNotes(events: LoopEvent[]): string {
  const notes = events
    .filter((e) => e.type === 'log' && typeof e.text === 'string' && e.text.startsWith('report omitted from settle'))
    .map((e) => String(e.text));
  return notes.length > 0 ? notes.join(' | ') : '(no report-omitted note)';
}

/** The delivery contract, asserted for every row. */
async function assertDelivery(
  jobId: string,
  events: LoopEvent[],
  fleet: (args: string[]) => Promise<{ stdout: string }>,
): Promise<void> {
  const branch = jobBranch(TARGET, jobId);
  assert.ok(
    remoteHeads().includes(`refs/heads/${branch}`),
    `claim branch ${branch} is not on the target remote; events: ${digest(events)}`,
  );

  const settle = events.find((e) => e.type === 'settle');
  assert.ok(settle, `no settle event; events: ${digest(events)}`);
  const report = settle.report as { next_action?: string } | undefined;
  assert.equal(
    report?.next_action,
    NEXT_ACTION,
    `settle did not carry the scaffold's report; ${reportNotes(events)}; settle: ${JSON.stringify(settle)}`,
  );

  // A bare filename, not the workspace-relative path: src/runner/artifacts.ts
  // stores `relative(artifactsDir, fullPath)`.
  const produced = (settle.outcome as { produced?: Array<{ path?: string }> } | undefined)?.produced ?? [];
  assert.ok(
    produced.some((entry) => entry.path === ARTIFACT),
    `produced[] does not list ${ARTIFACT}: ${JSON.stringify(produced)}`,
  );

  const { stdout } = await fleet(['artifacts', jobId, 'get', ARTIFACT]);
  // Trimmed: the trailing newline is the model's choice and nobody controls it.
  assert.equal(stdout.trim(), ARTIFACT_CONTENT, `${ARTIFACT} did not round-trip through the artifact lane`);
}

/** Dispatch one row against the target repo and hold it to the contract. */
/**
 * Prove a container can reach this daemon before spending a job on it.
 *
 * Without this the failure is a fifteen-minute timeout on a job stuck at
 * `queued`, with an empty container log and nothing naming the cause — the
 * runner posts `state: running` as its first act, so an unreachable daemon and
 * a container that never started look identical from the outside. The probe
 * costs one container start and turns that into an immediate, specific
 * message. Reachability is not a given even on a working machine: Docker
 * Desktop's host-gateway alias is the only route from a container back to the
 * host, and a VPN or TLS-inspecting proxy can take it away without warning.
 */
async function assertDaemonReachable(hostAddr: string, port: number, extraRunArgs: string[]): Promise<void> {
  const probeOnce = async (): Promise<boolean> => {
    try {
      await run(
      'docker',
      [
        'run', '--rm', '--add-host', 'host.docker.internal:host-gateway', ...extraRunArgs,
        '--entrypoint', 'sh', 'fleet-runner:claude-code-latest', '-c',
        `node -e "const c=new AbortController();setTimeout(()=>c.abort(),8000);`
          + `fetch('http://${hostAddr}:${port}/health',{signal:c.signal})`
          + `.then(r=>r.text()).then(()=>process.exit(0)).catch(()=>process.exit(1))"`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
      );
      return true;
    } catch {
      return false;
    }
  };

  // Retried, not one-shot. Container-to-host routing is not reliably steady on
  // every machine — on at least one it drops out for a minute at a time and
  // comes back on its own, with nothing in Docker or the host to show for it.
  // A one-shot probe turns that into a coin flip on a test that costs real
  // model tokens to run, so wait for the window rather than fail into it. The
  // bound still exists: an outage longer than this is a real problem and the
  // message says what to do about it.
  const deadline = Date.now() + REACHABILITY_WAIT_MS;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    if (await probeOnce()) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  assert.fail(
    `a container could not reach the test daemon at ${hostAddr}:${port} in ${attempts} attempts over `
      + `${Math.round(REACHABILITY_WAIT_MS / 1000)}s, so no job could ever report in. `
      + 'On Linux set FLEET_DOCKER_HOST_ADDR=172.17.0.1; on macOS this usually means Docker Desktop '
      + 'or a VPN has taken the host-gateway route away — restarting Docker Desktop clears it.',
  );
}

/**
 * What a user types before their first dispatch. The manifest is generated
 * here rather than committed to the target repo, because generating it is part
 * of what an end-to-end run has to prove: a repository that already carries a
 * manifest is one somebody set up by hand, and testing against that skips the
 * step every real adopter performs.
 *
 * Every prompt gets a flag, so the interview never blocks on a terminal. Async
 * for the same reason everything else on this path is: a synchronous child
 * would freeze the daemon's event loop, and the daemon has to keep answering
 * while containers are alive.
 */
async function setupRepo(project: string, image: string, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  const args = [
    'setup', 'repo', '--yes',
    '--repo', 'origin',
    // The daemon launches manifest.setup.image when no per-job override exists
    // (src/daemon/server.ts:628), so under the docker provider this IS the job
    // container. A bare node image would start without the runner in it.
    '--image', image,
    '--setup-command', 'npm install --no-fund --no-audit',
    '--sync', GITCONFIG_PATH,
    '--env-vars', ENV_VARS.join(', '),
    '--pickup', 'npm test',
    // No --command-path / --critic: setup stopped asking which command to run
    // (#240). The instruction is named at dispatch instead, below.
  ];
  try {
    const res = await run('node', [cli, ...args], { cwd: project, env });
    return { code: 0, out: `${res.stdout}${res.stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

async function runProbe(t: { after(fn: () => void): void }, row: HarnessRow): Promise<void> {
  const runArgs = [...caMountArgs(), ...targetMountArgs()];
  const loop = await startDockerLoop(t, row.image, runArgs);
  await assertDaemonReachable(loop.dockerHostAddr, loop.port, caMountArgs());
  const project = await cloneTargetRepo();
  const env = dispatchEnv(row, loop.port);

  // Before setup repo, not after: the interview refuses a --sync path that is
  // not already in the checkout, and .fleet/ does not exist in a fresh clone.
  mkdirSync(join(project, '.fleet'), { recursive: true });
  writeFileSync(join(project, GITCONFIG_PATH), '[safe]\n\tdirectory = *\n');

  // Step one of the journey, and a real assertion: a failure here means an
  // adopter cannot onboard their repo at all.
  const setup = await setupRepo(project, row.image, env);
  assert.equal(setup.code, 0, `fleet setup repo failed on a fresh checkout:\n${setup.out.slice(-2000)}`);
  assert.ok(existsSync(join(project, '.fleet', 'manifest.json')), 'setup repo reported success but wrote no manifest');

  // The journey does not end at generating .fleet/ — a job clones the REMOTE,
  // so anything setup repo wrote is invisible to it until it is committed.
  // That is what an adopter does next, and skipping it is how the codex row
  // silently lost its setup script (and with it, its credential).
  await run('git', ['add', '.fleet'], { cwd: project, env: gitEnv() });
  const staged = await run('git', ['diff', '--cached', '--name-only'], { cwd: project, env: gitEnv() });
  if (staged.stdout.trim() !== '') {
    await run('git', ['-c', 'user.name=fleet-e2e', '-c', 'user.email=fleet-e2e@example.com',
      'commit', '-q', '-m', 'Add the Fleet manifest generated by fleet setup repo'], { cwd: project, env: gitEnv() });
    await run('git', ['push', '--quiet', 'origin', 'HEAD:main'], { cwd: project, env: gitEnv() });
  }

  const fleet = (args: string[]) => run('node', [cli, ...args], { cwd: project, env });
  // The dispatch shape #240 exists for: an identity to name the job, and the
  // target repo's OWN slash command as the instruction — which is the thing
  // Fleet used to compose from the manifest and now never touches.
  const delegated = await fleet(['delegate', TARGET, '--prompt', `/${basename(COMMAND_PATH, '.md')} ${TARGET}`]);
  const jobId = delegated.stdout.trim().split(/\s+/).find((word) => word.startsWith('job-'));
  assert.ok(jobId, `no job id in delegate output: ${delegated.stdout}`);
  t.after(() => removeJobContainer(jobId));
  t.after(() => deleteJobRefs(jobId));

  const state = await loop.waitFor(
    jobId,
    (s) => s === 'done' || s === 'cancelled',
    `a terminal state for ${jobId} (setup → clone → gate → ${row.id} → settle)`,
    DEADLINE_MS,
  );
  const events = await loop.events(jobId);
  assert.equal(state, 'done', `job did not settle clean; events: ${digest(events)}`);

  await assertDelivery(jobId, events, fleet);

  if (row.translated) {
    assert.ok(
      events.some((e) => e.type === 'log' && typeof e.text === 'string' && e.text.startsWith('tool_use ')),
      `no tool_use log event — the translator saw no tool calls; events: ${digest(events)}`,
    );
  }
}

for (const row of ROWS) {
  test(`${row.id}: a real job against a foreign repo delivers the artifact and the report`, async (t) => {
    // No pointer gate: without FLEET_TARGET_REPO_URL the target is a bare repo
    // seeded in tmp, so the stub row runs anywhere. Only rows needing a model
    // credential skip, and they say which one is missing.
    const missing = unmetPrerequisites(row);
    if (missing.length > 0) return t.skip(`${row.id} row not runnable: ${missing.join('; ')}`);
    await runProbe(t, row);
  });
}
