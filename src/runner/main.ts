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
import { setupWorkspace, pushWork, pushWip, getHeadSha, createDraftPr, composeDraftPrText, gitCredentialEnv, findOpenPr, remoteMovedBeyond } from './git.ts';
import { buildHarnessCommand, parseVersion } from './harness.ts';
import { materializeWorkspace } from './workspace.ts';
import { runSetupScript } from './setup.ts';
import { parseDurationMs, idleLimitMs, blockHotLimitMs, mergedLimits, heartbeatMs, toMinutes, SETTLE_HEARTBEAT_MS } from '../shared/time.ts';
import { writeRetainRequest } from '../shared/retained.ts';
import { killTree } from '../shared/process.ts';

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
  const setupDecl = ((manifest.setup ?? {}) as Record<string, unknown>).script;
  const setupScript = typeof setupDecl === 'string' ? setupDecl : '';
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
  const cmd = plan.cmd;
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
  const child = spawn(cmd, {
    shell: true,
    cwd: workspace,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so a timeout can take the whole harness tree down —
    // see killTree: signalling the shell alone is not enough.
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
  // Liveness coalescing (#50). The translator drops the harness's own
  // heartbeats, so a job inside one long tool call is alive on stdout and
  // silent on the event stream — and the daemon's backstop only sees the
  // event stream, where it terminates the container without pushing WIP.
  // One bounded line per window keeps that visible without the flood.
  const heartbeatWindow =
    parseInt(process.env.FLEET_HEARTBEAT_MS ?? '', 10) || heartbeatMs(idleMs);
  let lastEmitAt = startedAt;
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
    if (translated.length === 0) {
      // The translator dropped this line. Coalesce: one heartbeat per window,
      // never one per dropped line — the flood is what #50 was about.
      const now = Date.now();
      if (now - lastEmitAt >= heartbeatWindow) {
        lastEmitAt = now;
        forget(sink.emit({
          type: 'log',
          who: 'runner',
          text: `harness working — ${toMinutes(now - startedAt)}m elapsed, no reportable output`,
        }));
      }
      return;
    }
    // {"type":"result"} marks the end of the run; it precedes settle and is
    // not itself an event — and it is not a silent line either, so it must not
    // trigger a heartbeat one line before the settle.
    const bodies = translated.filter((item) => item.type !== 'result');
    lastEmitAt = Date.now();
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
   * once did) means SIGKILL never arrives. And `shell: true` makes the child a
   * shell that may fork rather than exec, so signalling its pid alone leaves the
   * real harness alive holding the stdout pipe — 'close' never fires and the
   * runner waits forever instead of settling. A stalled harness is precisely the
   * process that will not exit on its own (#39), so the kill, not the harness,
   * has to be what ends the run.
   */
  const endHarness = async (grace = graceMs): Promise<void> => {
    killTree(child, 'SIGTERM');
    await Promise.race([exit.promise, delay(grace)]);
    // Escalate unless 'close' already fired. Not `child.exitCode` — the shell can
    // be dead while the harness it forked lives on holding the pipe, which is
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
  // Bounded pushes (#152): every push the runner makes after the harness is
  // done shells out to git, which hangs without bound on a black-holed remote
  // or a credential helper waiting on a prompt. execFileSync blocks the event
  // loop, so a hung push doesn't just eat a budget — it stops the cancel
  // deadline timer from ever firing, wedging the runner until the provider's
  // outer SIGKILL. The park and stall paths have no outer deadline at all;
  // there the wedge lasts until the daemon's backstop reaps the job, and the
  // backstop cannot push. Generous by default — its only job is to exist.
  const GIT_TIMEOUT_MS =
    parseInt(process.env.FLEET_GIT_TIMEOUT_MS ?? '', 10) || 120_000;
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
   *  recoverable. pushWip commits and pushes only when there are changes. */
  const cancelPushWip = async (signal: NodeJS.Signals): Promise<void> => {
    if (!gitUrl || !branch) return;
    try {
      const outcome = pushWip(workspace, `cancelled: ${signal}`, cancelPushTimeoutMs);
      await sink.emit({
        type: 'log',
        text: outcome === 'pushed'
          ? `wip pushed to ${branch} (cancelled)`
          : `workspace clean at cancel; no new commit beyond ${branch}`,
        who: 'runner',
      });
    } catch (err) {
      await sink.emit({
        type: 'log',
        text: `wip push failed (cancelling anyway): ${String(err instanceof Error ? err.message : err).split('\n')[0]}`,
        who: 'runner',
      });
    }
  };

  /** Best-effort settle: a PARTIAL report so the transcript explains itself. */
  const cancelSettle = async (signal: NodeJS.Signals): Promise<void> => {
    try {
      const { body, notes } = composeSettle({
        jobId,
        startedAt,
        decisions: watcher.count,
        workspace,
        ...(sink.dropped > 0 ? { droppedEvents: sink.dropped } : {}),
      });
      body.report = { status: 'PARTIAL', next_action: `job cancelled: runner received ${signal}` };
      for (const note of notes) {
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
      await cancelPushWip(signal);
      await cancelSettle(signal);
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

  // Stall: resolves when the harness has been silent (and unblocked) for the
  // idle threshold. Always armed — see idleLimitMs's default.
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
      try {
        const existingPr = findOpenPr(workspace, branch);
        if (existingPr !== undefined) {
          prUrl = existingPr.url;
          settleRung = 'pr-open';
          await sink.emit({ type: 'log', text: `continued PR updated: ${prUrl} (head ${getHeadSha(workspace)})`, who: 'runner' });
        } else {
          settleRung = 'pushed';
          await sink.emit({ type: 'log', text: `no open PR found for ${branch} (was #${continues.pr}); work pushed, no PR claimed`, who: 'runner' });
        }
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err).split('\n')[0];
        settleRung = 'pushed';
        await sink.emit({ type: 'log', text: `PR lookup failed (proceeding as pushed): ${msg}`, who: 'runner' });
      }
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
      // creation and again at pushWork; the runner reached at least 'pushed'.
      settleRung = 'pushed';
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

/** FLEET_RETRY_ATTEMPT as a number, when it names a real retry (#30). */
function retryAttemptEnv(): number | undefined {
  const parsed = parseInt(process.env.FLEET_RETRY_ATTEMPT ?? '', 10);
  return Number.isInteger(parsed) && parsed > 1 ? parsed : undefined;
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
