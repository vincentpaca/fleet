/**
 * Fleet runner entrypoint. Runs inside the sandbox next to the workspace.
 *
 * Env in: FLEET_JOB_ID, FLEET_DAEMON_URL, FLEET_RUNNER_TOKEN,
 * FLEET_WORKSPACE, FLEET_HARNESS_CMD (optional override; default derived
 * from manifest harness.cli).
 *
 * Sequence: state running → pickup gate (nonzero → settle BLOCKED + state
 * cancelled reason "pickup-gate" → exit) → spawn harness → translate
 * stream-json stdout to events → settle → state done (or settle partial +
 * state cancelled reason "harness-exit" on nonzero harness exit).
 *
 * Stream events are fire-and-forget into the sink's bounded retry queue
 * (issue #109): emit() cannot reject, the stdout reader pauses when the
 * buffer is near-full, and sink.flush() drains before settle/park. Dropped
 * events are counted and surface in the settle notes.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { EventSink } from './events.ts';
import { translateLine } from './translate.ts';
import { DecisionWatcher } from './decisions.ts';
import { WallClockTimer } from './wall-clock.ts';
import { IdleTimer } from './idle.ts';
import { composeSettle } from './settle.ts';
import { collectArtifacts } from './artifacts.ts';
import { setupWorkspace, pushWork, pushWip, pushCheckpoint, getHeadSha, createDraftPr, composeDraftPrText, gitCredentialEnv, findOpenPr, remoteMovedBeyond } from './git.ts';
import { buildHarnessCommand, describeHarnessPlan, parseVersion } from './harness.ts';
import { authFailureFrom, authFailureIn } from './auth-failure.ts';
import { materializeWorkspace } from './workspace.ts';
import { runSetupScript, dropPrivileges } from './setup.ts';
import { parseDurationMs, idleLimitMs, blockHotLimitMs, checkpointLimitMs, mergedLimits, heartbeatMs, toMinutes, SETTLE_HEARTBEAT_MS } from '../shared/time.ts';
import { writeRetainRequest } from '../shared/retained.ts';
import { killTree } from '../shared/process.ts';
import { buildStamp } from '../shared/build-stamp.ts';

/**
 * Hard cap on one harness stdout line (#139). Readline buffers the whole line
 * before 'line' fires, but everything downstream — the capture file, the
 * translator's JSON.parse, the event it may become — must not carry an
 * unbounded payload. Generous: real stream-json lines with embedded file
 * contents run to the hundreds of KB, never MBs.
 */
const MAX_LINE_CHARS = 1_048_576;
const LINE_TRUNCATION_MARKER = '…[truncated by fleet runner]';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`runner: missing required env ${name}`);
    process.exit(2);
  }
  return value;
}

/**
 * Privilege boundary (#196): root belongs to setup, never to the job. The
 * container starts as root so the operator-authored setup.script can install
 * system packages; this drops to the unprivileged job user (no-op off-root)
 * and aborts the job if the drop fails — continuing would hand the harness
 * uid 0, the exact thing the boundary exists to prevent.
 */
async function dropOrAbort(sink: EventSink, workspace: string): Promise<void> {
  const drop = dropPrivileges(workspace);
  if (drop.kind === 'skipped') return;
  await sink.emit({ type: 'log', text: drop.note, who: 'runner' });
  if (drop.kind === 'failed') {
    await settleBlocked(sink, `fix privilege drop: ${drop.detail}`);
    await sink.emit({ type: 'state', state: 'cancelled', reason: 'privilege-drop' });
    process.exit(1);
  }
}

/**
 * Grade a delivered branch against reality: an open PR on it is `pr-open`,
 * anything else is `pushed`. Shared by the continuation path (#80), where the
 * adopted branch's PR is detected and never created, and the no-publish path
 * (#208), where delivery is prompt-owned and an agent-opened PR is what the
 * settle reports. `missing` is emitted only when the caller expected a PR — a
 * continuation without one is worth a note, a prose dispatch without one is
 * the default. A lookup failure degrades to `pushed`, never to a claim.
 */
async function gradeBranchPr(opts: {
  workspace: string;
  branch: string;
  sink: EventSink;
  found: (url: string) => string;
  missing?: string;
}): Promise<{ rung: 'pr-open' | 'pushed'; prUrl?: string }> {
  try {
    const existingPr = findOpenPr(opts.workspace, opts.branch);
    if (existingPr !== undefined) {
      await opts.sink.emit({ type: 'log', text: opts.found(existingPr.url), who: 'runner' });
      return { rung: 'pr-open', prUrl: existingPr.url };
    }
    if (opts.missing !== undefined) {
      await opts.sink.emit({ type: 'log', text: opts.missing, who: 'runner' });
    }
    return { rung: 'pushed' };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).split('\n')[0];
    await opts.sink.emit({ type: 'log', text: `PR lookup failed (proceeding as pushed): ${msg}`, who: 'runner' });
    return { rung: 'pushed' };
  }
}

async function main(): Promise<void> {
  const jobId = requireEnv('FLEET_JOB_ID');
  const daemonUrl = requireEnv('FLEET_DAEMON_URL');
  const token = requireEnv('FLEET_RUNNER_TOKEN');
  const workspace = requireEnv('FLEET_WORKSPACE');

  materializeWorkspace(workspace);

  // Re-entry answer (issue #6): present when the daemon re-launches a parked
  // job after an operator answer. The runner writes it to out/ after the wipe
  // so the status-driven harness finds it immediately on its first check.
  const reentryAnswerB64 = process.env.FLEET_REENTRY_ANSWER_JSON;
  let reentryAnswer: { decisionId: string; answer: { option?: string; text?: string } } | undefined;
  if (reentryAnswerB64) {
    try {
      reentryAnswer = JSON.parse(Buffer.from(reentryAnswerB64, 'base64').toString('utf8')) as {
        decisionId: string;
        answer: { option?: string; text?: string };
      };
    } catch {
      // Ignore malformed env; proceed without pre-materialised answer.
    }
  }
  // Re-entry decision seed (issue #110): the daemon passes the highest decision
  // ordinal already in the job's log so the fresh runner's ids stay unique
  // across park/resume — without this the first new decision would be d1 again
  // and collide with the old d1 answer still in the daemon's event log.
  const decisionSeed = parseInt(process.env.FLEET_REENTRY_DECISION_SEED ?? '', 10);
  const reentryDecisionSeed = Number.isInteger(decisionSeed) && decisionSeed > 0 ? decisionSeed : undefined;
  // Auto-retry (#30): attempt number of this launch (2 = the one automatic
  // retry). Set by the daemon; the workspace setup renames the previous
  // attempt's branch before creating this attempt's own.
  const retryAttempt = retryAttemptEnv();
  // Event delivery backpressure (#109): when the sink's bounded buffer is
  // near-full, pause the harness stdout reader instead of queueing without
  // bound; resume below the low watermark. The hook is wired to the
  // readline interface once it exists.
  const EVENT_PAUSE_AT = 128;
  const EVENT_RESUME_AT = 32;
  let manageBackpressure: (() => void) | undefined;
  const sink = new EventSink({
    jobId,
    daemonUrl,
    token,
    onDepth: () => manageBackpressure?.(),
  });
  await sink.emit({ type: 'state', state: 'running' });

  // Deployment skew (#207): name the build this runner image carries, so a job
  // run on a stale image is diagnosable from its own log — the #197 incident
  // was exactly a runner image predating an already-merged fix, with nothing in
  // the record to say so. Silent when unstamped: an image predating the stamp
  // has nothing honest to report.
  const imageStamp = buildStamp();
  if (imageStamp !== undefined) {
    await sink.emit({ type: 'log', text: `runner image built at ${imageStamp}`, who: 'runner' });
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(
      readFileSync(join(workspace, '.fleet', 'manifest.json'), 'utf8'),
    );
  } catch (err) {
    await settleBlocked(sink, 'add a readable .fleet/manifest.json to the workspace');
    await sink.emit({ type: 'state', state: 'cancelled', reason: 'manifest' });
    console.error(`runner: cannot read manifest: ${String(err)}`);
    process.exit(1);
  }

  // --- Privilege boundary, early half (#196). ---
  // No setup.script declared → no root work is coming: drop before the clone,
  // the order read, everything. With a script declared the runner stays root
  // through the clone (the script runs in the cloned workspace) and drops
  // right after the setup outcome below — even when the marker says the image
  // baked it, because that check itself must read the boot user's $HOME.
  const setupDecl = ((manifest.setup ?? {}) as Record<string, unknown>).script;
  const setupScript = typeof setupDecl === 'string' ? setupDecl : '';
  if (setupScript === '') {
    await dropOrAbort(sink, workspace);
  }

  // Work-order target: names the job branch and rides into the harness prompt.
  let target = 'work';
  let orderTitle: string | undefined;
  let authorityPublish = false;
  // Continuation (#80): an order carrying `continues` adopts the named PR
  // branch instead of creating a fresh one — its presence IS the adoption
  // declaration (#36). Schema-validated at dispatch; the shape check here only
  // guards direct runner invocations.
  let continues: { pr: number; branch: string } | undefined;
  // Per-dispatch limit overrides (#134): the work order's limits win over the
  // manifest's. Merged below through the same chokepoint the daemon uses.
  let orderLimits: unknown;
  try {
    const order = JSON.parse(readFileSync(join(workspace, '.fleet', 'order.json'), 'utf8'));
    if (typeof order.target === 'string' && order.target !== '') target = order.target;
    orderLimits = order.limits;
    if (typeof order.title === 'string' && order.title) orderTitle = order.title;
    authorityPublish = order?.authority?.publish === true;
    if (typeof order?.continues?.pr === 'number' && typeof order?.continues?.branch === 'string' && order.continues.branch !== '') {
      continues = { pr: order.continues.pr, branch: order.continues.branch };
    }
  } catch {
    // No staged order (direct runner invocation): branch/prompt fall back.
  }

  // --- Git credentials, ambient for the whole job tree. ---
  // The workspace lifecycle, the pickup gate, and the repo's own harness all
  // spawn git/gh themselves; wiring gh as the credential helper only inside
  // git.ts left the gate's ls-remote unauthenticated (#9's first cloud job
  // died there). Applies only when the job env ships a GitHub token; adds
  // process env for children, never touches git config on the host.
  Object.assign(process.env, gitCredentialEnv());

  // --- Workspace git lifecycle (#2): branch pushed at creation. ---
  // Activated by FLEET_GIT_URL, resolved by the CLI at dispatch; providers
  // stay git-agnostic and git-less tests simply do not set it.
  const gitUrl = process.env.FLEET_GIT_URL;
  let branch: string | undefined;
  let base: string | undefined;
  // Continuation (#80): the adopted branch's tip at setup. Delivery is judged
  // against this SHA, never against base — the adopted branch is always ahead
  // of base with the original job's commits.
  let adoptedTip: string | undefined;
  if (gitUrl) {
    try {
      const setup = setupWorkspace(workspace, {
        url: gitUrl,
        jobId,
        target,
        name: process.env.FLEET_GIT_NAME,
        email: process.env.FLEET_GIT_EMAIL,
        // Re-entry: check out the existing job branch (WIP commit) instead of
        // creating a fresh branch from the base. No push — no collision guard.
        reentry: !!reentryAnswer,
        // Adoption (#80): check out the continued PR's head branch. Same
        // no-push mechanics as re-entry, and re-entry of a parked
        // adoption lands on this branch too.
        ...(continues !== undefined ? { adoptBranch: continues.branch } : {}),
        // Auto-retry (#30): rename the previous attempt's branch first.
        ...(retryAttempt !== undefined ? { retryAttempt } : {}),
      });
      branch = setup.branch;
      base = setup.base;
      if (continues !== undefined) adoptedTip = getHeadSha(workspace);
      if (setup.released !== undefined) {
        await sink.emit({
          type: 'log',
          text: `claim released: previous attempt's branch renamed to ${setup.released}`,
          who: 'runner',
        });
      }
      await sink.emit({
        type: 'log',
        text: continues !== undefined
          ? `workspace adopted branch ${branch} (continues PR #${continues.pr})`
          : `workspace on branch ${branch} (pushed)`,
        who: 'runner',
      });
    } catch (err) {
      const firstLine = String(err instanceof Error ? err.message : err).split('\n')[0];
      await settleBlocked(sink, `fix workspace git: ${firstLine}`);
      await sink.emit({ type: 'state', state: 'cancelled', reason: 'git' });
      process.exit(1);
    }
  }
  // --- Setup script (#49): one-layer images carry no repo setup layer. ---
  // The two-layer build bakes manifest setup.script into the job image and
  // leaves a marker; when the marker is absent — the ECS task definition's
  // pinned :runner image, a bare setup.image, the process provider's host —
  // the runner runs the script here, after the clone and before the gate, so
  // the gate probes the environment the manifest actually promised. The
  // announce line is awaited before the blocking spawnSync for the same
  // reason the gate's is: it dates the silence the stall backstops measure.
  if (setupScript !== '') {
    await sink.emit({ type: 'log', text: `setup script: ${setupScript}`, who: 'runner' });
    const setupOutcome = runSetupScript({
      workspace,
      manifest,
      ...(process.env.FLEET_SETUP_TIMEOUT_MS
        ? { timeoutMs: parseInt(process.env.FLEET_SETUP_TIMEOUT_MS, 10) || undefined }
        : {}),
    });
    if (setupOutcome.kind !== 'none') {
      await sink.emit({ type: 'log', text: setupOutcome.note, who: 'runner' });
    }
    if (setupOutcome.kind === 'failed') {
      await settleBlocked(sink, `fix setup script: ${setupOutcome.detail}`);
      await sink.emit({ type: 'state', state: 'cancelled', reason: 'setup-script' });
      process.exit(1);
    }
    // Privilege boundary, late half (#196): setup — the only root work — is
    // done (ran, baked, or missing). Everything after runs as the job user.
    await dropOrAbort(sink, workspace);
  }

  // --- Pickup gate: must exit 0 or the job aborts before model spend. ---
  const gates = (manifest.gates ?? {}) as Record<string, unknown>;
  const pickup = typeof gates.pickup === 'string' ? gates.pickup : '';
  // Bracket the gate with events. It is a blocking spawnSync that emits
  // nothing, and the daemon's stall backstop (#39) reads silence on the event
  // stream: an unannounced gate looks exactly like a wedged runner.
  // The timeout keeps diagnosis runner-side: a hung gate wedges the event
  // loop entirely, and while the daemon stall backstop reaps it eventually,
  // a bounded spawnSync surfaces the failure here instead.
  await sink.emit({ type: 'log', text: `pickup gate: ${pickup || '(none)'}`, who: 'runner' });
  const gateTimeoutMs =
    parseInt(process.env.FLEET_GATE_TIMEOUT_MS ?? '', 10) || 60_000;
  const gate = spawnSync(pickup, {
    shell: true,
    cwd: workspace,
    encoding: 'utf8',
    env: process.env,
    timeout: gateTimeoutMs,
    killSignal: 'SIGKILL',
    // SIGKILL, not the default SIGTERM: a gate that traps SIGTERM keeps
    // spawnSync blocked past its own timeout, which is the wedge the timeout
    // exists to break. Signalling the shell still orphans any grandchild it
    // spawned, but the runner is free to report instead of hanging.
  });
  if (gate.status === null) {
    const reason = gate.signal !== null
      ? `pickup gate timed out after ${gateTimeoutMs / 1000}s (killed with ${gate.signal})`
      : `pickup gate failed: ${gate.error?.message ?? 'unknown error'}`;
    await settleBlocked(sink, reason);
    await sink.emit({ type: 'state', state: 'cancelled', reason: 'pickup-gate' });
    process.exit(1);
  }
  if (gate.status !== 0) {
    const output = `${gate.stdout ?? ''}\n${gate.stderr ?? ''}`;
    const firstLine =
      output.split('\n').map((line) => line.trim()).find((line) => line !== '') ??
      '(no output)';
    await settleBlocked(sink, `fix pickup gate: ${firstLine}`);
    await sink.emit({ type: 'state', state: 'cancelled', reason: 'pickup-gate' });
    process.exit(1);
  }

  // --- Harness ---
  // Fresh out/ channel: a decision.json or report.json that arrived with the
  // clone (committed by accident upstream) must never speak for this job.
  rmSync(join(workspace, '.fleet', 'out'), { recursive: true, force: true });
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });

  // Re-entry: write the pre-materialised answer file so the status-driven
  // harness finds it immediately without needing to raise a new decision.
  if (reentryAnswer) {
    writeFileSync(
      join(workspace, '.fleet', 'out', `answer-${reentryAnswer.decisionId}.json`),
      JSON.stringify(reentryAnswer.answer, null, 2) + '\n',
    );
  }

  const harness = (manifest.harness ?? {}) as Record<string, unknown>;
  const cli = typeof harness.cli === 'string' ? harness.cli : 'claude-code';
  const probe = !process.env.FLEET_HARNESS_CMD && cli === 'claude-code'
    ? spawnSync('claude', ['--version'], { encoding: 'utf8' })
    : undefined;
  const plan = buildHarnessCommand({
    manifest,
    target,
    override: process.env.FLEET_HARNESS_CMD,
    actualVersion: probe?.stdout ? parseVersion(probe.stdout) : undefined,
    continues,
  });
  if (!plan) {
    await settleBlocked(sink, `no harness command derivable for cli "${cli}" — set harness.commands or FLEET_HARNESS_CMD`);
    await sink.emit({ type: 'state', state: 'cancelled', reason: 'harness-cmd' });
    process.exit(1);
  }
  for (const note of plan.notes) {
    await sink.emit({ type: 'log', text: note, who: 'runner' });
  }
  const cmd = describeHarnessPlan(plan);
  // Last event before the harness owns the stream: it dates the silence the
  // stall detectors measure, and it is the line an operator reads to see which
  // command the job actually launched.
  await sink.emit({ type: 'log', text: `pickup gate passed; starting harness: ${cmd}`, who: 'runner' });

  const startedAt = Date.now();

  // Parse limits; build timers so the decision watcher can pause the wall-clock
  // while blocked and park the job when block_hot expires. Work-order limits
  // override manifest limits (#134) — same merge the daemon applies at intake.
  const limits = mergedLimits(manifest.limits, orderLimits);
  const wallClockStr = typeof limits.wall_clock === 'string' ? limits.wall_clock : undefined;
  const wallClockLimitMs = wallClockStr !== undefined ? parseDurationMs(wallClockStr) : undefined;
  const wallClock = wallClockLimitMs !== undefined ? new WallClockTimer(wallClockLimitMs, startedAt) : undefined;

  // Always a number (#134): a job whose question is never answered must park
  // at the documented default rather than keeping the container hot forever.
  const blockHotMs = blockHotLimitMs(limits);

  // Stall detection (#39): unlike wall_clock this is always armed — a running
  // job that emits nothing is never in an intended state. The threshold defaults
  // when limits.idle is absent, so the label falls back to the same number.
  const idleMs = idleLimitMs(limits);
  const idleLabel = typeof limits.idle === 'string' ? limits.idle : `${toMinutes(idleMs)}m`;
  const idle = new IdleTimer(idleMs, startedAt);

  const watcher = new DecisionWatcher({ workspace, sink, wallClock, idle, blockHotMs, decisionSeed: reentryDecisionSeed });
  watcher.start();

  // The harness child gets NO runner-scoped FLEET_* env: nested fleet
  // processes inside the workspace (the delegated agent running this repo's
  // own tests, a nested CLI call) must never inherit this job's identity,
  // token, git activation, or capture sink. Both leak classes happened live:
  // FLEET_STREAM_CAPTURE polluted a calibration fixture; FLEET_GIT_URL made
  // nested test-runners attempt real clones.
  const capture = process.env.FLEET_STREAM_CAPTURE;
  // Lazily-opened append stream for FLEET_STREAM_CAPTURE (#109 minor):
  // one buffered writer instead of a synchronous append per line.
  let captureStream: WriteStream | undefined;
  const childEnv = {
    ...(plan.env ?? {}),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('FLEET_')),
    ),
  };
  // argv, not a shell string, on the derived path: the prompt carries a target
  // and (on an adoption) a PR branch name nobody here chose, and a shell would
  // expand `$(...)` in either before claude ever saw it (#241). Only the
  // operator-authored FLEET_HARNESS_CMD asks for a shell, and buildHarnessCommand
  // is where that asymmetry is decided.
  const child = spawn(plan.file, plan.args, {
    shell: plan.shell,
    cwd: workspace,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so a timeout can take the whole harness tree down —
    // see killTree: the harness forks (its own Bash tool, an override's shell)
    // and signalling the child alone leaves those running.
    detached: true,
  });

  // The harness is in its own process group now, so a signal aimed at the
  // runner (provider terminate, an operator's Ctrl-C on a process-provider
  // daemon) no longer reaches it by inheritance. Forward it, or cancelling a
  // job leaves a live harness burning tokens with nowhere to report.
  //
  // The full teardown (SIGTERM → grace → SIGKILL, best-effort WIP push,
  // best-effort settle, exit) is installed once the helpers below are defined.
  // Until then — the narrow window between spawn and helper definition — a
  // bare kill+exit is the best we can do, and it matches the old behavior.
  let cancelTeardown: ((signal: NodeJS.Signals) => Promise<void>) | undefined;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      if (cancelTeardown !== undefined) void cancelTeardown(signal);
      else { killTree(child, 'SIGTERM'); process.exit(1); }
    });
  }

  const stderrTail: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail.push(chunk);
    if (stderrTail.length > 20) stderrTail.shift();
  });

  // Fire-and-forget stream delivery (#109): emit() cannot reject, but every
  // pushed emit still gets a .catch so an unexpected failure is recorded to
  // stderr — never an orphaned rejection. Ordering and completion are the
  // sink's business; the runner awaits sink.flush() before settling.
  const forget = (pending: Promise<unknown>): void => {
    pending.catch((err) => {
      console.error(`runner: event emit rejected: ${String(err instanceof Error ? err.message : err)}`);
    });
  };
  const lines = createInterface({ input: child.stdout });
  let outputPaused = false;
  manageBackpressure = () => {
    if (!outputPaused && sink.depth >= EVENT_PAUSE_AT) {
      outputPaused = true;
      lines.pause();
    } else if (outputPaused && sink.depth <= EVENT_RESUME_AT) {
      outputPaused = false;
      lines.resume();
    }
  };
  // Liveness coalescing (#50), timer-driven (#197). The translator drops the
  // harness's own heartbeats, so a job inside one long tool call is alive on
  // stdout and silent on the event stream — and the daemon's backstop only
  // sees the event stream. One bounded line per window keeps that visible
  // without the flood; the timer (startKeepalive, armed below) owns emitting
  // it, so a harness that goes FULLY silent — no stdout at all, waiting on a
  // backgrounded command — still beats. `liveness.lastEmitAt` is the shared
  // coalescing mark: the stdout handler stamps it on every emitted event.
  const heartbeatWindow =
    parseInt(process.env.FLEET_HEARTBEAT_MS ?? '', 10) || heartbeatMs(idleMs);
  const liveness = { lastEmitAt: startedAt };
  // Line-length cap (#139): truncate, mark, and continue — never crash on an
  // unbounded line. Only the first truncation is announced; a harness that
  // streams many oversized lines must not turn the cap into its own flood.
  let truncatedLines = 0;
  const capLine = (raw: string): string => {
    if (raw.length <= MAX_LINE_CHARS) return raw;
    truncatedLines += 1;
    if (truncatedLines === 1) {
      forget(sink.emit({
        type: 'log',
        who: 'runner',
        text: `harness emitted a ${raw.length}-char line; truncated to ${MAX_LINE_CHARS} (later truncations are silent)`,
      }));
    }
    return raw.slice(0, MAX_LINE_CHARS) + LINE_TRUNCATION_MARKER;
  };
  // Auth-failure evidence (#205): the first harness-authored line naming a
  // dead credential, kept so a nonzero exit can park behind a decision
  // instead of riding out as cancelled(harness-exit). Detection alone never
  // acts — see the exit race below.
  let authEvidence: string | undefined;
  lines.on('line', (rawLine) => {
    // Any output line is proof of life, translatable or not: the stall clock
    // measures silence on the harness's own stream, not event throughput.
    idle.touch();
    const line = capLine(rawLine);
    if (capture) {
      captureStream ??= createWriteStream(capture, { flags: 'a' });
      captureStream.write(line + '\n');
    }
    const translated = translateLine(line);
    authEvidence ??= authFailureFrom(translated);
    // A dropped line is proof of life but not an event: the keepalive timer
    // owns the "harness working" line now (#197), one per window whether the
    // dropped lines arrive in a flood (#50) or stop arriving entirely.
    if (translated.length === 0) return;
    // {"type":"result"} marks the end of the run; it precedes settle and is
    // not itself an event — and it is not a silent line either, so it must not
    // trigger a keepalive one line before the settle.
    const bodies = translated.filter((item) => item.type !== 'result');
    liveness.lastEmitAt = Date.now();
    if (bodies.length === 1) forget(sink.emit(bodies[0]));
    else if (bodies.length > 1) forget(sink.emitBatch(bodies));
  });

  const exit = Promise.withResolvers<number>();
  /** True once 'close' has fired: the tree is gone AND the pipes are released. */
  let harnessClosed = false;
  /**
   * Resolves when the signal handler's teardown takes over. The main flow
   * races it and then stands down: the teardown owns push, settle and exit
   * from that point, and two paths pushing the same workspace is worse than
   * either one alone.
   */
  const cancelPromise = Promise.withResolvers<void>();
  child.on('close', (code) => {
    harnessClosed = true;
    exit.resolve(code ?? 1);
  });
  // Spawn failure (EMFILE/EAGAIN under fd pressure): the 'error' event fires
  // instead of 'close', and without a listener it is an uncaught exception —
  // the runner crashes with no settle and no log. Resolve the exit promise with
  // a synthetic code so the normal teardown path (settle + state cancelled) runs.
  child.on('error', (err) => {
    if (harnessClosed) return; // already exited normally
    forget(sink.emit({
      type: 'log',
      text: `harness spawn failed: ${String(err instanceof Error ? err.message : err).split('\n')[0]}`,
      who: 'runner',
    }));
    harnessClosed = true;
    exit.resolve(127);
  });

  const linesDone = Promise.withResolvers<void>();
  lines.once('close', () => linesDone.resolve());

  // Bounded pushes (#152): every push the runner makes shells out to git,
  // which hangs without bound on a black-holed remote or a credential helper
  // waiting on a prompt. execFileSync blocks the event loop, so a hung push
  // doesn't just eat a budget — it stops every runner-side timer from firing,
  // wedging the runner until the provider's outer SIGKILL. The park and stall
  // paths have no outer deadline at all; there the wedge lasts until the
  // daemon's backstop reaps the job, and the backstop cannot push. Generous by
  // default — its only job is to exist.
  const GIT_TIMEOUT_MS =
    parseInt(process.env.FLEET_GIT_TIMEOUT_MS ?? '', 10) || 120_000;

  // Keepalive (#197): timer-driven for the harness process's entire lifetime.
  // Liveness is the process, not its stdout — see startKeepalive. Every path
  // out of the race below clears it; the settle heartbeat (#139) takes over.
  const harnessAlive = (): boolean =>
    !harnessClosed && child.exitCode === null && child.signalCode === null;
  const keepalive = startKeepalive({
    sink,
    idle,
    startedAt,
    windowMs: heartbeatWindow,
    liveness,
    harnessAlive,
    forget,
  });

  // Checkpoint WIP pushes (#190): armed only for git-backed jobs, cleared by
  // every teardown path before it makes its own push.
  const checkpoints = gitUrl && branch !== undefined
    ? startCheckpoints({
        workspace,
        branch,
        jobId,
        sink,
        forget,
        intervalMs: checkpointLimitMs(limits),
        pushTimeoutMs: GIT_TIMEOUT_MS,
        active: harnessAlive,
      })
    : undefined;
  /** Every exit from the run phase funnels through here before it pushes. */
  const stopRunPhaseTimers = (): void => {
    clearInterval(keepalive);
    if (checkpoints !== undefined) clearInterval(checkpoints);
  };

  // --- Harness exit race: wall-clock, stall, block_hot (park), or normal exit ---
  // All four are armed regardless; whichever fires first wins.
  const graceMs =
    parseInt(process.env.FLEET_WALL_CLOCK_GRACE_MS ?? '', 10) || 30_000;

  /** Set when a timer, not the harness, ended the run: drives reason + report. */
  let timeout: { reason: 'wall-clock' | 'stall'; nextAction: string } | undefined;
  let exitCode: number;

  /**
   * End the harness: SIGTERM the tree, grace, then SIGKILL it. Always returns.
   *
   * Two traps live here, both of which cost a job. `child.killed` only records
   * that a signal was *sent*, so guarding the escalation on it (as this code
   * once did) means SIGKILL never arrives. And the child forks — the harness
   * runs its own tools, and an override runs under a shell — so signalling its
   * pid alone leaves a descendant alive holding the stdout pipe: 'close' never
   * fires and the runner waits forever instead of settling. A stalled harness
   * is precisely the process that will not exit on its own (#39), so the kill,
   * not the harness, has to be what ends the run.
   */
  const endHarness = async (grace = graceMs): Promise<void> => {
    killTree(child, 'SIGTERM');
    await Promise.race([exit.promise, delay(grace)]);
    // Escalate unless 'close' already fired. Not `child.exitCode` — the child can
    // be dead while a process it forked lives on holding the pipe, which is
    // the case this escalation exists for. 'close' is the honest signal that
    // nothing is left to kill, and skipping the signal then also avoids aiming
    // -pid at a group id the kernel may since have recycled.
    if (!harnessClosed) {
      killTree(child, 'SIGKILL');
      await Promise.race([exit.promise, delay(grace)]);
    }
  };

  /**
   * Wait for the stdout reader to finish, but never unboundedly: 'close' needs
   * EOF on the pipe, and a survivor that escaped the group kill (a harness that
   * setsid()s itself) holds the write end open. Settling late beats not
   * settling, so past the grace window the runner takes the stream down itself.
   */
  const drainOutput = async (grace = graceMs): Promise<void> => {
    const drained = await Promise.race([
      linesDone.promise.then(() => true),
      delay(grace).then(() => false),
    ]);
    if (drained) return;
    lines.close();
    child.stdout.destroy();
    await sink.emit({
      type: 'log',
      text: 'harness stdout still open after the kill; settling without it',
      who: 'runner',
    });
  };

  /** Close the FLEET_STREAM_CAPTURE writer so buffered lines hit disk. */
  const endCapture = (): Promise<void> => {
    if (captureStream === undefined) return Promise.resolve();
    const stream = captureStream;
    captureStream = undefined;
    return new Promise<void>((resolve) => stream.end(resolve));
  };

  // --- Cancel teardown (#111): the signal handler's real teardown path. ---
  // The old handler was killTree(SIGTERM) + process.exit(1) — no SIGKILL
  // escalation, no WIP push, no settle. A cancel of a nearly-done job threw
  // away everything uncommitted, and a SIGTERM-trapping harness survived as a
  // zombie. This runs the same escalation as endHarness, then best-effort
  // pushes WIP and settles, all inside a hard deadline.
  //
  // The deadline has to fit inside the shortest grace a provider gives between
  // SIGTERM and SIGKILL, because past it the teardown is cut off mid-sentence:
  // ECS is 30s (stopTimeout, pinned in infra/aws/main.tf rather than inherited
  // from an AWS default), and the docker provider stops the container with an
  // explicit grace before removing it (DockerProvider.STOP_GRACE_SECONDS —
  // `rm -f` alone is SIGKILL and no teardown would run at all). 20s leaves both
  // a margin and the teardown room to finish.
  const CANCEL_DEADLINE_MS =
    parseInt(process.env.FLEET_CANCEL_DEADLINE_MS ?? '', 10) || 20_000;
  // Killing the harness gets a slice of the cancel budget, not all of it.
  // endHarness and drainOutput default to `graceMs` — the wall-clock grace, 30s
  // — which on a SIGTERM-trapping harness (the case this exists for) exhausts
  // the deadline before the push or the settle is attempted, leaving a cancel
  // that kills the tree and throws the work away. Which is the bug. These two
  // are what is left over from, not what is taken out of, the work that matters:
  // ~6s to kill, ~2s to drain, ~8s for the push, and the remaining ~4s for
  // the settle — which outranks the push (#152): the settle is what the
  // operator reads, the WIP push is best-effort recovery of work that may not
  // exist. A push that cannot finish in its slice was never going to finish
  // inside the deadline; failing it buys the settle its window.
  const cancelKillGraceMs = Math.max(500, Math.floor(CANCEL_DEADLINE_MS * 0.15));
  const cancelDrainGraceMs = Math.max(250, Math.floor(CANCEL_DEADLINE_MS * 0.1));
  const cancelPushTimeoutMs =
    Math.min(GIT_TIMEOUT_MS, Math.max(1_000, Math.floor(CANCEL_DEADLINE_MS * 0.4)));
  /** Best-effort WIP push: the job is cancelled, but partial work may be
   *  recoverable. pushWip commits uncommitted changes and pushes whatever is
   *  ahead of the remote — a commit the harness made but never pushed is
   *  exactly the delivery a stall teardown must not drop (#197). Returns
   *  whether work landed, for the settle's empty-handed accounting. */
  const cancelPushWip = async (signal: NodeJS.Signals): Promise<boolean> => {
    if (!gitUrl || !branch) return false;
    try {
      const outcome = pushWip(workspace, `cancelled: ${signal}`, cancelPushTimeoutMs);
      await sink.emit({
        type: 'log',
        text: outcome === 'pushed'
          ? `wip pushed to ${branch} (cancelled)`
          : `workspace clean at cancel; no new commit beyond ${branch}`,
        who: 'runner',
      });
      return outcome === 'pushed';
    } catch (err) {
      await sink.emit({
        type: 'log',
        text: `wip push failed (cancelling anyway): ${String(err instanceof Error ? err.message : err).split('\n')[0]}`,
        who: 'runner',
      });
      return false;
    }
  };

  /** Best-effort settle: a PARTIAL report so the transcript explains itself.
   *  Collects what already exists in .fleet/out/artifacts first (#197): the
   *  container dies with the cancel, so an artifact not uploaded here is
   *  gone — job-mt9y7vel's answer.md died exactly this way. Tightly bounded:
   *  the settle itself still outranks everything (#152). */
  const cancelSettle = async (signal: NodeJS.Signals, workPushed: boolean): Promise<void> => {
    try {
      const artifacts = await collectArtifacts({
        workspace,
        jobId,
        daemonUrl,
        token,
        uploadTimeoutMs: Math.max(1_000, Math.floor(CANCEL_DEADLINE_MS * 0.1)),
      });
      const { body, notes } = composeSettle({
        jobId,
        startedAt,
        decisions: watcher.count,
        workspace,
        produced: artifacts.produced,
        workPushed,
        ...(sink.dropped > 0 ? { droppedEvents: sink.dropped } : {}),
      });
      body.report = { status: 'PARTIAL', next_action: `job cancelled: runner received ${signal}` };
      for (const note of [...artifacts.notes, ...notes]) {
        await sink.emit({ type: 'log', text: note, who: 'runner' });
      }
      await sink.emit(body);
    } catch (err) {
      await sink.emit({
        type: 'log',
        text: `settle failed (cancelling): ${String(err instanceof Error ? err.message : err).split('\n')[0]}`,
        who: 'runner',
      });
    }
  };

  cancelTeardown = async (signal) => {
    cancelPromise.resolve();
    // First act: a checkpoint tick firing mid-teardown would block the event
    // loop for its push bound and eat the deadline the teardown lives inside.
    stopRunPhaseTimers();
    const deadline = delay(CANCEL_DEADLINE_MS).then(() => 'timeout' as const);
    const teardown = (async () => {
      await sink.emit({
        type: 'log',
        text: `runner received ${signal}; tearing down`,
        who: 'runner',
      });
      await endHarness(cancelKillGraceMs);
      await drainOutput(cancelDrainGraceMs);
      await endCapture();
      await watcher.stop();
      await sink.flush();
      const workPushed = await cancelPushWip(signal);
      await cancelSettle(signal, workPushed);
      await sink.emit({ type: 'state', state: 'cancelled', reason: 'signal' });
      await sink.flush();
      return 'done' as const;
    })();

    // The exit is in a finally, and the teardown's rejection is caught rather
    // than raced: the signal handler calls this without awaiting it, so a throw
    // anywhere above (a sink.emit against a daemon that is already gone is the
    // likely one) would otherwise become an unhandled rejection with no exit —
    // and the main flow, having stood down, waits on it forever. A cancelled
    // runner that never exits is the zombie this whole change is about.
    try {
      const outcome = await Promise.race([
        teardown.catch((err: unknown) => {
          console.error(`runner: cancel teardown failed: ${String(err)}`);
          return 'failed' as const;
        }),
        deadline,
      ]);
      if (outcome !== 'done') {
        // Deadline blown, or the teardown threw partway: the tree may still be
        // up and nothing else is going to kill it.
        killTree(child, 'SIGKILL');
      }
    } finally {
      process.exit(1);
    }
  };

  // Park signal: resolves with the decision id when block_hot fires. Always
  // armed — blockHotLimitMs defaults when the merged limits carry no value.
  const parkPromise = watcher.parked.then(
    (decisionId) => ({ kind: 'parked' as const, decisionId }),
  );

  // Wall-clock: resolves when active runtime >= limit. Never resolves if unset.
  const wallClockExpired: Promise<void> = wallClock !== undefined
    ? (async () => {
        while (!wallClock.expired()) {
          await delay(Math.min(250, Math.max(1, wallClock.remainingMs())));
        }
      })()
    : new Promise<void>(() => {}); // never

  // Stall: resolves when the idle clock runs out. Always armed — but the
  // keepalive re-marks the clock while the harness PROCESS is alive (#197), so
  // in practice this fires only for the wedge process liveness cannot vouch
  // for: the harness process exited while a leaked child holds the stdout pipe
  // open, so 'close' never fires and the exit race never resolves.
  const idleExpired: Promise<void> = (async () => {
    while (!idle.expired()) {
      await delay(Math.min(250, Math.max(1, idle.remainingMs())));
    }
  })();

  const result = await Promise.race([
    exit.promise.then((code) => ({ kind: 'exit' as const, code })),
    wallClockExpired.then(() => ({ kind: 'wall-clock' as const })),
    idleExpired.then(() => ({ kind: 'stall' as const })),
    parkPromise,
    cancelPromise.promise.then(() => ({ kind: 'cancel' as const })),
  ]);

  // Run phase over: the settle/park path owns every push from here, and the
  // settle heartbeat (#139) owns liveness. Idempotent with the cancel
  // teardown's own clear.
  stopRunPhaseTimers();

  if (result.kind === 'cancel') {
    // Stand down: the teardown owns push, settle and exit from here. It always
    // reaches process.exit — deadline blown, throw, or clean — so this wait
    // cannot outlive it.
    await new Promise<void>(() => {});
  }

  if (result.kind === 'parked') {
    // block_hot expired: commit WIP, emit blocked/parked, exit 0.
    // The harness is still running (waiting for its answer); terminate it now.
    await endHarness();
    await drainOutput();
    await sink.flush();
    await endCapture();
    await watcher.stop(); // already stopped internally; awaits the loop wind-down

    if (gitUrl && branch) {
      try {
        const wipOutcome = pushWip(workspace, `block_hot expired: ${result.decisionId}`, GIT_TIMEOUT_MS);
        await sink.emit({
          type: 'log',
          text: wipOutcome === 'pushed'
            ? `wip pushed to ${branch} (parked)`
            : `workspace clean at park; no new commit beyond ${branch}`,
          who: 'runner',
        });
      } catch (err) {
        await sink.emit({
          type: 'log',
          text: `wip push failed (parking anyway): ${String(err instanceof Error ? err.message : err).split('\n')[0]}`,
          who: 'runner',
        });
      }
    }

    await sink.emit({ type: 'state', state: 'blocked', marker: 'parked' });
    process.exit(0);
  }

  // Auth-failure park (#205): a harness that died complaining about its
  // credential is not a mystery exit. Instead of cancelled(harness-exit),
  // raise a decision and park — the operator answers it like any other, and
  // the daemon's existing re-entry machinery relaunches the job. Only a
  // nonzero exit paired with harness-authored evidence takes this path.
  if (result.kind === 'exit' && result.code !== 0) {
    const evidence = authEvidence ?? authFailureIn(stderrTail.join(''));
    if (evidence !== undefined) {
      await parkOnAuthFailure({
        sink,
        watcher,
        workspace,
        evidence,
        branch: gitUrl ? branch : undefined,
        pushTimeoutMs: GIT_TIMEOUT_MS,
        drainOutput,
        endCapture,
      });
    }
  }

  if (result.kind === 'wall-clock' || result.kind === 'stall') {
    // The idle duration is the diagnosis, so it rides both the live log line
    // and the settle report — the transcript must say why the job died.
    const silentFor = `no harness output for ${toMinutes(idle.idleMs())}m (idle limit ${idleLabel})`;
    timeout = result.kind === 'wall-clock'
      ? {
          reason: 'wall-clock',
          nextAction: `job cancelled: wall-clock limit (${wallClockStr ?? 'unknown'}) reached`,
        }
      : {
          reason: 'stall',
          nextAction: `job cancelled: ${silentFor} — inspect the last events for where it went silent`,
        };
    await sink.emit({
      type: 'log',
      text: result.kind === 'wall-clock'
        ? `wall-clock limit (${wallClockStr}) reached; sending SIGTERM`
        : `stalled: ${silentFor}; sending SIGTERM`,
      who: 'runner',
    });
    // Grace period inside endHarness: clean shutdown first, SIGKILL after.
    await endHarness();
    // Timer cancellation always fails the job regardless of how the harness
    // exited (it may exit 0 if it handles SIGTERM gracefully).
    exitCode = 1;
  } else {
    // result.kind === 'exit'
    exitCode = result.code;
  }

  await drainOutput();
  await sink.flush();
  await endCapture();
  await watcher.stop();

  // Settle heartbeat (#139): the liveness line above lives in the stdout
  // handler and dies with the harness — exactly when the settle work (WIP/work
  // push, PR create, artifact upload) starts racing the daemon's backstops.
  // The idle sweep measures event-stream silence and, firing, terminates the
  // container without pushing anything; one bounded line per window keeps it
  // fed for as long as the settle honestly takes. The wall-clock backstop is
  // deliberately NOT extended: after a wall-clock expiry the whole settle —
  // SIGTERM grace (30s default) + pushes + PR + artifacts — must fit inside
  // its fixed margin (DEFAULT_BACKSTOP_MARGIN_MS, 90s). That is the budget.
  const settleStartedAt = Date.now();
  const settleHeartbeatWindow =
    parseInt(process.env.FLEET_SETTLE_HEARTBEAT_MS ?? '', 10) || SETTLE_HEARTBEAT_MS;
  const settleHeartbeat = setInterval(() => {
    forget(sink.emit({
      type: 'log',
      who: 'runner',
      text: `settling — ${toMinutes(Date.now() - settleStartedAt)}m in (pushing work, collecting artifacts)`,
    }));
  }, settleHeartbeatWindow);

  // Deliver the work (#2): commit and push whatever the harness produced —
  // partial work included; evidence over tidiness.
  let pushNote: string | undefined;
  let workPushed = false;
  // Set when the push failed and the workspace is the only copy of the work
  // (#38): the provider keeps the directory instead of deleting it, and the
  // path rides out in a settle note.
  let retainedWorkspace: string | undefined;
  if (gitUrl && branch) {
    try {
      const outcome = pushWork(workspace, target, jobId, exitCode === 0, base, GIT_TIMEOUT_MS);
      workPushed = outcome === 'pushed' || outcome === 'delivered';
      // Adopted branch (#80): 'delivered' means ahead-of-base, which the
      // adopted branch is by construction. Delivery on a continuation is real
      // only when the remote moved beyond the tip this job adopted.
      if (continues !== undefined && adoptedTip !== undefined && outcome !== 'pushed') {
        workPushed = remoteMovedBeyond(workspace, branch, adoptedTip, GIT_TIMEOUT_MS);
      }
      pushNote = outcome === 'pushed' ? `work pushed to ${branch}`
        : workPushed ? `work already on ${branch} (agent pushed; runner push unnecessary or rejected)`
        : continues !== undefined ? `no new commits beyond the adopted tip of ${branch}`
        : `workspace clean; nothing beyond ${branch} creation`;
    } catch (err) {
      const reason = String(err instanceof Error ? err.message : err).split('\n')[0];
      pushNote = `WORK PUSH FAILED: ${reason}`;
      try {
        writeRetainRequest(workspace, {
          jobId,
          target,
          branch,
          ...(base !== undefined ? { base } : {}),
          ok: exitCode === 0,
          reason,
          at: new Date().toISOString(),
        });
        retainedWorkspace = workspace;
      } catch (markErr) {
        pushNote += ` (workspace NOT retained: ${String(markErr instanceof Error ? markErr.message : markErr).split('\n')[0]})`;
      }
    }
    await sink.emit({ type: 'log', text: pushNote, who: 'runner' });
  }

  const ok = exitCode === 0;

  // PR delivery (#3): open a draft PR when authority.publish is granted and
  // the harness succeeded. Never merges — createDraftPr has no merge path.
  let prUrl: string | undefined;
  let settleRung: string | undefined;
  if (ok) {
    if (gitUrl && branch && !workPushed) {
      // Nothing landed on the branch: whatever the harness claims, there is no
      // deliverable. Claiming 'pushed' here was a real bug (#34's first run:
      // work done in harness-subagent worktrees, never applied, rung overstated).
      settleRung = undefined;
      await sink.emit({
        type: 'log',
        text: 'no work commits on the branch — no rung claimed; report claims are unverified',
        who: 'runner',
      });
    } else if (gitUrl && branch && continues !== undefined) {
      // Continuation (#80): never create a PR — the adopted branch already has
      // one, and the work just pushed updated it in place. Detect it and report
      // it as this settle's PR; a PR that has since closed degrades to 'pushed'.
      const graded = await gradeBranchPr({
        workspace, branch, sink,
        found: (url) => `continued PR updated: ${url} (head ${getHeadSha(workspace)})`,
        missing: `no open PR found for ${branch} (was #${continues.pr}); work pushed, no PR claimed`,
      });
      prUrl = graded.prUrl;
      settleRung = graded.rung;
    } else if (gitUrl && branch && base && authorityPublish) {
      try {
        // Compose per the delivery standard: report sections, never raw JSON.
        let report: Record<string, unknown> | undefined;
        try {
          report = JSON.parse(readFileSync(join(workspace, '.fleet', 'out', 'report.json'), 'utf8'));
        } catch { /* thin PR text is the honest fallback */ }
        // Title stamped at dispatch (in order.json); never re-fetched from gh.
        const pr = composeDraftPrText({ target, issueTitle: orderTitle, jobId, report });
        prUrl = createDraftPr(workspace, { base, branch, title: pr.title, body: pr.body });
        const headSha = getHeadSha(workspace);
        await sink.emit({ type: 'log', text: `draft PR opened: ${prUrl} (head ${headSha})`, who: 'runner' });
        settleRung = 'pr-open';
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err).split('\n')[0];
        await sink.emit({ type: 'log', text: `PR creation failed (proceeding as pushed): ${msg}`, who: 'runner' });
        settleRung = 'pushed';
      }
    } else if (gitUrl && branch) {
      // Git is set up but authority.publish not granted — branch was pushed at
      // creation and again at pushWork, so at least 'pushed'. Delivery on this
      // path is prompt-owned (#208, docs/decisions.md#d17): the sandbox has gh
      // and can open a PR when the prompt asks for one, so the settle grades
      // what actually happened — an agent-opened PR on the job branch settles
      // at 'pr-open' (exceeding a prose target, which D6 blesses); none found
      // stays the honest 'pushed'. Status never lies in either direction.
      const graded = await gradeBranchPr({
        workspace, branch, sink,
        found: (url) => `agent-opened PR detected: ${url} (head ${getHeadSha(workspace)})`,
      });
      prUrl = graded.prUrl;
      settleRung = graded.rung;
    } else {
      settleRung = 'implemented';
    }
  }

  // Artifact delivery (issue #18): upload files from .fleet/out/artifacts/
  // before composing the settle so produced[] can list them. Over-cap files
  // are noted and skipped; the settle always proceeds.
  const { produced: artifactProduced, notes: artifactNotes } = await collectArtifacts({
    workspace,
    jobId,
    daemonUrl,
    token,
  });
  for (const note of artifactNotes) {
    await sink.emit({ type: 'log', text: note, who: 'runner' });
  }

  const { body, notes } = composeSettle({
    jobId,
    startedAt,
    decisions: watcher.count,
    workspace,
    ...(sink.dropped > 0 ? { droppedEvents: sink.dropped } : {}),
    produced: artifactProduced,
    workPushed,
    ...(settleRung !== undefined ? { rung: settleRung } : {}),
    ...(retainedWorkspace !== undefined ? { retainedWorkspace } : {}),
    prUrl,
  });
  for (const note of notes) {
    await sink.emit({ type: 'log', text: note, who: 'runner' });
  }
  if (!ok && body.report === undefined) {
    if (timeout !== undefined) {
      body.report = { status: 'PARTIAL', next_action: timeout.nextAction };
    } else {
      const hint = stderrTail.join('').trim().split('\n').at(-1) ?? '';
      body.report = {
        status: 'PARTIAL',
        next_action: `inspect harness exit ${exitCode}${hint ? `: ${hint.slice(0, 200)}` : ''}`,
      };
    }
  } else if (timeout !== undefined && body.report !== undefined) {
    // A harness that was killed mid-run may still have left a report behind; it
    // cannot know it was cancelled. Record why in not_done rather than letting
    // its own account be the settle's last word.
    const report = body.report as Record<string, unknown>;
    const notDone = Array.isArray(report.not_done) ? report.not_done as unknown[] : [];
    body.report = { ...report, not_done: [...notDone, timeout.nextAction] };
  }
  clearInterval(settleHeartbeat);
  await sink.emit(body);

  if (ok) {
    await sink.emit({ type: 'state', state: 'done' });
    process.exit(0);
  } else {
    const reason = timeout?.reason ?? 'harness-exit';
    await sink.emit({ type: 'state', state: 'cancelled', reason });
    process.exit(1);
  }
}

/**
 * Park a job whose harness exited complaining about its credential (#205).
 * Same teardown steps as the block_hot park, minus the kill (the harness is
 * already gone): drain, push WIP, raise the decision, emit blocked/parked,
 * exit 0. Never returns.
 *
 * The decision is honest about the one thing re-entry cannot do: the daemon
 * relaunches with the env captured at dispatch, so a token refreshed on the
 * operator's machine does NOT reach this job — Fleet never runs OAuth flows
 * or refreshes vendor tokens (that boundary moves only via the credential
 * broker, #10). Retry therefore helps only when the failure was transient or
 * fixed server-side; a genuinely dead credential means cancel + re-dispatch.
 */
async function parkOnAuthFailure(opts: {
  sink: EventSink;
  watcher: DecisionWatcher;
  workspace: string;
  evidence: string;
  branch: string | undefined;
  pushTimeoutMs: number;
  drainOutput: () => Promise<void>;
  endCapture: () => Promise<void>;
}): Promise<never> {
  const { sink, watcher, branch } = opts;
  await opts.drainOutput();
  await sink.flush();
  await opts.endCapture();
  await watcher.stop();
  await sink.emit({ type: 'log', text: `harness auth failure recognized: ${opts.evidence}`, who: 'runner' });

  if (branch !== undefined) {
    try {
      const wipOutcome = pushWip(opts.workspace, 'auth failure: parked', opts.pushTimeoutMs);
      await sink.emit({
        type: 'log',
        text: wipOutcome === 'pushed'
          ? `wip pushed to ${branch} (parked on auth failure)`
          : `workspace clean at park; no new commit beyond ${branch}`,
        who: 'runner',
      });
    } catch (err) {
      await sink.emit({
        type: 'log',
        text: `wip push failed (parking anyway): ${String(err instanceof Error ? err.message : err).split('\n')[0]}`,
        who: 'runner',
      });
    }
  }

  await watcher.raise(authParkDecision(opts.evidence));
  await sink.emit({ type: 'state', state: 'blocked', marker: 'parked' });
  process.exit(0);
}

/** The auth-failure park's decision content (#205), decision-file shaped. */
function authParkDecision(evidence: string): Parameters<DecisionWatcher['raise']>[0] {
  return {
    question: 'Harness authentication failed — the credential this job was dispatched with is expired or invalid.',
    options: [
      {
        id: 'retry',
        label: 'Retry with the stored credential',
        detail: 'Relaunches with the credential captured at dispatch. Helps when the failure was transient or fixed server-side; a token refreshed on your machine does not reach this job.',
        recommended: true,
      },
      {
        id: 'abort',
        label: 'Refresh locally and re-dispatch instead',
        detail: 'Refresh on your machine (claude setup-token, then fleet setup repo), cancel this job (fleet cancel), reclaim its branch if needed (fleet reclaim), and dispatch fresh. Note: any answer relaunches once; a still-dead credential parks again.',
      },
    ],
    note: `harness reported: ${evidence} — Fleet never refreshes vendor tokens (#10); refresh happens on your machine.`,
    who: 'runner',
  };
}

/** FLEET_RETRY_ATTEMPT as a number, when it names a real retry (#30). */
function retryAttemptEnv(): number | undefined {
  const parsed = parseInt(process.env.FLEET_RETRY_ATTEMPT ?? '', 10);
  return Number.isInteger(parsed) && parsed > 1 ? parsed : undefined;
}

/**
 * Run-phase keepalive (#197): one bounded "harness working" line per window,
 * timer-driven for the harness process's entire lifetime. The previous
 * implementation lived in the stdout handler and fired only when a dropped
 * line ARRIVED — a harness waiting silently on a backgrounded command emitted
 * nothing, the daemon's idle sweep read the event silence as a dead runner,
 * and job-mt9y7vel was terminated while it was actively finishing.
 *
 * Each beat also re-marks the runner's own stall clock: a live harness process
 * is not a stall, however quiet its stdout — silence is normal inside a long
 * tool call or behind a backgrounded command. The stall path still catches the
 * one wedge process liveness cannot vouch for: a harness whose process is gone
 * while a leaked child holds the stdout pipe open, so 'close' never fires.
 */
function startKeepalive(opts: {
  sink: EventSink;
  idle: IdleTimer;
  startedAt: number;
  windowMs: number;
  /** Shared with the stdout handler: when the last event was emitted. */
  liveness: { lastEmitAt: number };
  harnessAlive: () => boolean;
  forget: (pending: Promise<unknown>) => void;
}): ReturnType<typeof setInterval> {
  const tick = (): void => {
    if (!opts.harnessAlive()) return;
    const now = Date.now();
    if (now - opts.liveness.lastEmitAt < opts.windowMs) return;
    opts.liveness.lastEmitAt = now;
    opts.idle.touch(now);
    opts.forget(opts.sink.emit({
      type: 'log',
      who: 'runner',
      text: `harness working — ${toMinutes(now - opts.startedAt)}m elapsed, no reportable output`,
    }));
  };
  // Sub-second ticking costs nothing and keeps the coalescing check (above)
  // the only cadence that matters — including under test-sized windows.
  const timer = setInterval(tick, Math.max(25, Math.min(opts.windowMs, 1_000)));
  timer.unref();
  return timer;
}

/**
 * Checkpoint WIP pushes (#190): commit-and-push the workspace to the job
 * branch every interval, so a container killed at any moment — wall-clock
 * cliff, a stall cancel whose teardown push then fails, a plain SIGKILL —
 * loses at most one interval of work instead of all of it. Same bounded
 * commit-and-push machinery as the park/cancel pushes (#152). Failures log
 * and the run continues: never fatal, and the interval guard retries at the
 * next checkpoint rather than in a tight loop. The teardown/settle pushes
 * then move an incremental delta, shrinking the very window #152 raced.
 */
function startCheckpoints(opts: {
  workspace: string;
  branch: string;
  jobId: string;
  sink: EventSink;
  intervalMs: number;
  pushTimeoutMs: number;
  /** False once the harness is down: the settle/teardown owns pushes then. */
  active: () => boolean;
  forget: (pending: Promise<unknown>) => void;
}): ReturnType<typeof setInterval> {
  let lastAttemptAt = Date.now();
  const tick = (): void => {
    if (!opts.active()) return;
    const now = Date.now();
    // The push is execFileSync, so a slow one queues missed ticks behind it;
    // the re-check keeps it to one attempt per interval, never a burst.
    if (now - lastAttemptAt < opts.intervalMs) return;
    lastAttemptAt = now;
    try {
      const outcome = pushCheckpoint(opts.workspace, `fleet job ${opts.jobId}`, opts.pushTimeoutMs);
      if (outcome === 'pushed') {
        opts.forget(opts.sink.emit({
          type: 'log',
          who: 'runner',
          text: `checkpoint: wip pushed to ${opts.branch}`,
        }));
      }
    } catch (err) {
      opts.forget(opts.sink.emit({
        type: 'log',
        who: 'runner',
        text: `checkpoint push failed (continuing): ${String(err instanceof Error ? err.message : err).split('\n')[0]}`,
      }));
    }
  };
  const timer = setInterval(tick, Math.max(25, Math.min(opts.intervalMs, 1_000)));
  timer.unref();
  return timer;
}

/** Contract shape for aborts before/without a harness result. */
async function settleBlocked(sink: EventSink, nextAction: string): Promise<void> {
  await sink.emit({
    type: 'settle',
    outcome: { produced: [], findings: 0, decisions: 0 },
    report: { status: 'BLOCKED', next_action: nextAction },
  });
}

main().catch((err) => {
  console.error(`runner: fatal: ${String(err)}`);
  process.exit(1);
});
