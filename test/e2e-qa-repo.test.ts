// End to end against a real repo that is not this one (#224).
//
// Every job Fleet has ever run targeted its own dogfood repo, driven by
// claude-code. Two things are therefore unproven: that Fleet works against a
// foreign repo, and that any other harness CLI can satisfy the job contract.
// This file is the axis both of those live on — one test per harness, all
// three dispatching against the *same* committed `cli: "claude-code"` manifest
// in the QA repo, because an override short-circuits above the cli guard
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
//   FLEET_QA_REPO=https://github.com/<owner>/<repo>.git \
//   GH_TOKEN=... CLAUDE_CODE_OAUTH_TOKEN=... node --test test/e2e-qa-repo.test.ts
//
// The QA repo carries the scaffold (`.fleet/manifest.json`,
// `.claude/commands/qa.md`, `README.md`); see the issue. Nothing about it —
// name, owner or URL — belongs in this tree, which is why the pointer is an
// env var (docs/decisions.md#d10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
 * no sanitisation surprises. The QA repo's manifest must carry no
 * `gates.default_finish` or `reachableRepoDefault` (src/cli/dispatch.ts:130)
 * would override `inspected` with the repo default.
 */
const TARGET = 'qa-probe';

/** What the QA repo's committed `/qa` command writes, and the content it must carry. */
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
  'CODEX_AUTH_B64',
  'OPENCODE_AUTH_B64',
  'NODE_EXTRA_CA_CERTS',
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
const OVERRIDE_PROMPT =
  'Read .claude/commands/task.md in this repository and do exactly what it says. '
  + 'Write every deliverable as a file under .fleet/out/artifacts/ — files anywhere else are not collected. '
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
    // `exec` is codex's non-interactive mode. The sandbox flag is not
    // recklessness: the container IS the sandbox, and codex's own confinement
    // on top of it only blocks the writes the job exists to make — the same
    // reasoning behind claude-code's --allowedTools in the derived command.
    // --skip-git-repo-check because the workspace is a fresh clone whose
    // provenance codex has no way to recognise.
    command: `codex exec --sandbox danger-full-access --skip-git-repo-check ${JSON.stringify(OVERRIDE_PROMPT)}`,
    // The credential is the operator's own ~/.codex/auth.json, handed over
    // base64 and placed by the target repo's setup.sh. It cannot ride
    // workspace.sync: a declared-but-missing sync file fails EVERY dispatch,
    // including the rows that do not need it.
    //
    // KNOWN FAILURE on an org-managed account, and NOT the wrong entry point:
    // `codex exec` is OpenAI's documented headless/CI mode, which normally
    // runs with no approval prompt at all under whatever sandbox it is given.
    //
    // What breaks it here is admin-enforced `requirements.toml`, delivered on
    // ChatGPT business sign-in and attached to the ACCOUNT rather than the
    // machine — which is why it applies inside the container although only
    // auth.json was copied in. It pins the filesystem read-only and forces an
    // approval policy, and exec mode has no way to answer an approval ("file
    // change approval is not supported in exec mode"), so every write is
    // declined. The same command succeeds on the operator's own machine, where
    // the escalation is answered. Verified against danger-full-access,
    // workspace-write, a trusted project entry, a TTY, bubblewrap with relaxed
    // seccomp, and --dangerously-bypass-approvals-and-sandbox.
    //
    // Fixable only outside Fleet: an admin can allow non-interactive use via a
    // granular approval policy, or the job can authenticate with
    // OPENAI_API_KEY, which is not a workspace sign-in and so carries no
    // managed requirements. The row stays live because it passes on an
    // account without them.
    translated: false,
  },
  {
    id: 'opencode',
    image: 'fleet-runner:opencode-latest',
    command: `opencode run ${JSON.stringify(OVERRIDE_PROMPT)}`,
    missingCredentials: () =>
      process.env.OPENCODE_AUTH_B64
        ? []
        : ['OPENCODE_AUTH_B64 unset — export it with: export OPENCODE_AUTH_B64=$(base64 < ~/.local/share/opencode/auth.json)'],
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

/** The QA repo pointer. Only called once the skip line has proved it is set. */
function qaRepo(): string {
  return process.env.FLEET_QA_REPO as string;
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
  // that answer is the wrong one, and a private QA repo then reports
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
 * A fresh checkout of the QA repo, which the CLI child gets as its cwd.
 * Never `process.chdir`: nothing in src/ or test/ does, and a foreign checkout
 * inside the repo tree would land in the scanners' path. Dispatching from the
 * checkout is also what makes the manifest's `workspace.repo: "origin"`
 * sentinel resolve (src/cli/main.ts:824-825), so the QA repo's own committed
 * manifest is the artifact under test.
 */
async function cloneQaRepo(): Promise<string> {
  const project = mkdtempSync(join(tmpdir(), 'fleet-qa-proj-'));
  await run('git', ['clone', '--quiet', qaRepo(), project], { env: gitEnv() });
  return project;
}

/** Every branch on the QA remote, as full ref names. */
function remoteHeads(): string[] {
  const listed = execFileSync('git', ['ls-remote', '--heads', qaRepo()], { env: gitEnv(), encoding: 'utf8' });
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
    execFileSync('git', ['push', '--quiet', qaRepo(), ...mine.map((ref) => `:${ref}`)], {
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Best effort: a cleanup failure must not mask the assertion that failed
    // first, but it must not pass silently either.
    console.error(`e2e-qa-repo: could not delete ${prefix}* from the QA remote: ${String(err)}`);
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
    CODEX_AUTH_B64: process.env.CODEX_AUTH_B64 ?? '',
    OPENCODE_AUTH_B64: process.env.OPENCODE_AUTH_B64 ?? '',
    GH_TOKEN: process.env.GH_TOKEN ?? '',
    // Points at the mount, not at the host path: the container's filesystem is
    // its own. Empty when the host has no extra CA, which is the normal case.
    NODE_EXTRA_CA_CERTS: hostCaFile() === undefined ? '' : CONTAINER_CA,
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
    `claim branch ${branch} is not on the QA remote; events: ${digest(events)}`,
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

/** Dispatch one row against the QA repo and hold it to the contract. */
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
    '--sync', '',
    '--env-vars', ENV_VARS.join(', '),
    '--pickup', 'npm test',
    '--command-path', COMMAND_PATH,
    '--critic', 'code-reviewer',
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
  const loop = await startDockerLoop(t, row.image, caMountArgs());
  await assertDaemonReachable(loop.dockerHostAddr, loop.port, caMountArgs());
  const project = await cloneQaRepo();
  const env = dispatchEnv(row, loop.port);

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
  const delegated = await fleet(['delegate', TARGET]);
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
    // The `return` is load-bearing: a bare t.skip() marks the test skipped and
    // then keeps running the body. No existsSync clause either — the other
    // env-pointer gates in this suite point at files, this one is a URL.
    if (!process.env.FLEET_QA_REPO) return t.skip('FLEET_QA_REPO not set');
    const missing = unmetPrerequisites(row);
    if (missing.length > 0) return t.skip(`${row.id} row not runnable: ${missing.join('; ')}`);
    await runProbe(t, row);
  });
}
