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
import { parseDurationMs, idleLimitMs, heartbeatMs, toMinutes } from '../shared/time.ts';
import { writeRetainRequest } from '../shared/retained.ts';
import { killTree } from '../shared/process.ts';

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
  // Continuation (#80): a followthrough order carrying `continues` adopts the
  // named PR branch instead of creating a fresh one. Schema-validated at
  // dispatch; the shape check here only guards direct runner invocations.
  let continues: { pr: number; branch: string } | undefined;
  try {
    const order = JSON.parse(readFileSync(join(workspace, '.fleet', 'order.json'), 'utf8'));
    if (typeof order.target === 'string' && order.target !== '') target = order.target;
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
        // followthrough lands on this branch too.
        ...(continues !== undefined ? { adoptBranch: continues.branch } : {}),
      });
      branch = setup.branch;
      base = setup.base;
      if (continues !== undefined) adoptedTip = getHeadSha(workspace);
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
  // --- Pickup gate: must exit 0 or the job aborts before model spend. ---
  const gates = (manifest.gates ?? {}) as Record<string, unknown>;
  const pickup = typeof gates.pickup === 'string' ? gates.pickup : '';
  // Bracket the gate with events. It is a blocking spawnSync that emits
  // nothing, and the daemon's stall backstop (#39) reads silence on the event
  // stream: an unannounced gate looks exactly like a wedged runner.
  await sink.emit({ type: 'log', text: `pickup gate: ${pickup || '(none)'}`, who: 'runner' });
  const gate = spawnSync(pickup, {
    shell: true,
    cwd: workspace,
    encoding: 'utf8',
    env: process.env,
  });
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
  // while blocked and park the job when block_hot expires.
  const limits = (manifest.limits ?? {}) as Record<string, unknown>;
  const wallClockStr = typeof limits.wall_clock === 'string' ? limits.wall_clock : undefined;
  const wallClockLimitMs = wallClockStr !== undefined ? parseDurationMs(wallClockStr) : undefined;
  const wallClock = wallClockLimitMs !== undefined ? new WallClockTimer(wallClockLimitMs, startedAt) : undefined;

  const blockHotStr = typeof limits.block_hot === 'string' ? limits.block_hot : undefined;
  const blockHotMs = blockHotStr !== undefined ? parseDurationMs(blockHotStr) : undefined;

  // Stall detection (#39): unlike wall_clock this is always armed — a running
  // job that emits nothing is never in an intended state. The threshold defaults
  // when limits.idle is absent, so the label falls back to the same number.
  const idleMs = idleLimitMs(limits);
  const idleLabel = typeof limits.idle === 'string' ? limits.idle : `${toMinutes(idleMs)}m`;
  const idle = new IdleTimer(idleMs, startedAt);

  const watcher = new DecisionWatcher({ workspace, sink, wallClock, idle, blockHotMs });
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
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      killTree(child, 'SIGTERM');
      process.exit(1);
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
  lines.on('line', (line) => {
    // Any output line is proof of life, translatable or not: the stall clock
    // measures silence on the harness's own stream, not event throughput.
    idle.touch();
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
  child.on('close', (code) => {
    harnessClosed = true;
    exit.resolve(code ?? 1);
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
  const endHarness = async (): Promise<void> => {
    killTree(child, 'SIGTERM');
    await Promise.race([exit.promise, delay(graceMs)]);
    // Escalate unless 'close' already fired. Not `child.exitCode` — the shell can
    // be dead while the harness it forked lives on holding the pipe, which is
    // the case this escalation exists for. 'close' is the honest signal that
    // nothing is left to kill, and skipping the signal then also avoids aiming
    // -pid at a group id the kernel may since have recycled.
    if (!harnessClosed) {
      killTree(child, 'SIGKILL');
      await Promise.race([exit.promise, delay(graceMs)]);
    }
  };

  /**
   * Wait for the stdout reader to finish, but never unboundedly: 'close' needs
   * EOF on the pipe, and a survivor that escaped the group kill (a harness that
   * setsid()s itself) holds the write end open. Settling late beats not
   * settling, so past the grace window the runner takes the stream down itself.
   */
  const drainOutput = async (): Promise<void> => {
    const drained = await Promise.race([
      linesDone.promise.then(() => true),
      delay(graceMs).then(() => false),
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

  // Park signal: resolves with the decision id when block_hot fires.
  // Silently never resolves if blockHotMs is not set.
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
  ]);

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
        const wipOutcome = pushWip(workspace, `block_hot expired: ${result.decisionId}`);
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
      const outcome = pushWork(workspace, target, jobId, exitCode === 0, base);
      workPushed = outcome === 'pushed' || outcome === 'delivered';
      // Adopted branch (#80): 'delivered' means ahead-of-base, which the
      // adopted branch is by construction. Delivery on a continuation is real
      // only when the remote moved beyond the tip this job adopted.
      if (continues !== undefined && adoptedTip !== undefined && outcome !== 'pushed') {
        workPushed = remoteMovedBeyond(workspace, branch, adoptedTip);
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
