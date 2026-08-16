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
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { EventSink } from './events.ts';
import { translateLine } from './translate.ts';
import { DecisionWatcher } from './decisions.ts';
import { composeSettle } from './settle.ts';
import { setupWorkspace, pushWork, getHeadSha, createDraftPr } from './git.ts';
import { buildHarnessCommand, parseVersion } from './harness.ts';

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

  const sink = new EventSink({ jobId, daemonUrl, token });
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
  let authorityPublish = false;
  try {
    const order = JSON.parse(readFileSync(join(workspace, '.fleet', 'order.json'), 'utf8'));
    if (typeof order.target === 'string' && order.target !== '') target = order.target;
    authorityPublish = order?.authority?.publish === true;
  } catch {
    // No staged order (direct runner invocation): branch/prompt fall back.
  }

  // --- Workspace git lifecycle (#2): branch pushed at creation. ---
  // Activated by FLEET_GIT_URL, resolved by the CLI at dispatch; providers
  // stay git-agnostic and git-less tests simply do not set it.
  const gitUrl = process.env.FLEET_GIT_URL;
  let branch: string | undefined;
  let base: string | undefined;
  if (gitUrl) {
    try {
      const setup = setupWorkspace(workspace, {
        url: gitUrl,
        jobId,
        target,
        name: process.env.FLEET_GIT_NAME,
        email: process.env.FLEET_GIT_EMAIL,
      });
      branch = setup.branch;
      base = setup.base;
      await sink.emit({ type: 'log', text: `workspace on branch ${branch} (pushed)`, who: 'runner' });
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
  const watcher = new DecisionWatcher({ workspace, sink });
  watcher.start();

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
  });
  if (!plan) {
    await watcher.stop();
    await settleBlocked(sink, `no harness command derivable for cli "${cli}" — set harness.commands or FLEET_HARNESS_CMD`);
    await sink.emit({ type: 'state', state: 'cancelled', reason: 'harness-cmd' });
    process.exit(1);
  }
  for (const note of plan.notes) {
    await sink.emit({ type: 'log', text: note, who: 'runner' });
  }
  const cmd = plan.cmd;

  const startedAt = Date.now();
  // The harness child gets NO runner-scoped FLEET_* env: nested fleet
  // processes inside the workspace (the delegated agent running this repo's
  // own tests, a nested CLI call) must never inherit this job's identity,
  // token, git activation, or capture sink. Both leak classes happened live:
  // FLEET_STREAM_CAPTURE polluted a calibration fixture; FLEET_GIT_URL made
  // nested test-runners attempt real clones.
  const capture = process.env.FLEET_STREAM_CAPTURE;
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('FLEET_')),
  );
  const child = spawn(cmd, {
    shell: true,
    cwd: workspace,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrTail: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail.push(chunk);
    if (stderrTail.length > 20) stderrTail.shift();
  });

  const emits: Promise<unknown>[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (capture) appendFileSync(capture, line + '\n');
    const translated = translateLine(line);
    const bodies = translated.filter((item) => item.type !== 'result');
    // {"type":"result"} marks the end of the run; it precedes settle and is
    // not itself an event.
    if (bodies.length === 1) emits.push(sink.emit(bodies[0]));
    else if (bodies.length > 1) emits.push(sink.emitBatch(bodies));
  });

  const exit = Promise.withResolvers<number>();
  child.on('close', (code) => exit.resolve(code ?? 1));
  const linesDone = Promise.withResolvers<void>();
  lines.once('close', () => linesDone.resolve());
  const exitCode = await exit.promise;
  await linesDone.promise;
  await Promise.all(emits);
  await watcher.stop();

  // Deliver the work (#2): commit and push whatever the harness produced —
  // partial work included; evidence over tidiness.
  let pushNote: string | undefined;
  if (gitUrl && branch) {
    try {
      const outcome = pushWork(workspace, target, jobId, exitCode === 0);
      pushNote = outcome === 'pushed' ? `work pushed to ${branch}` : `workspace clean; nothing beyond ${branch} creation`;
    } catch (err) {
      pushNote = `WORK PUSH FAILED: ${String(err instanceof Error ? err.message : err).split('\n')[0]}`;
    }
    await sink.emit({ type: 'log', text: pushNote, who: 'runner' });
  }

  const ok = exitCode === 0;

  // PR delivery (#3): open a draft PR when authority.publish is granted and
  // the harness succeeded. Never merges — createDraftPr has no merge path.
  let prUrl: string | undefined;
  let settleRung: string | undefined;
  if (ok) {
    if (gitUrl && branch && base && authorityPublish) {
      try {
        // Collect the harness report for the PR body; fall back to a minimal string.
        let prBody: string;
        try {
          const rawReport = readFileSync(join(workspace, '.fleet', 'out', 'report.json'), 'utf8');
          prBody = rawReport;
        } catch {
          prBody = `Fleet job ${jobId}: ${target}`;
        }
        prUrl = createDraftPr(workspace, { base, branch, title: target, body: prBody });
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

  const { body, notes } = composeSettle({
    jobId,
    startedAt,
    decisions: watcher.count,
    workspace,
    ...(settleRung !== undefined ? { rung: settleRung } : {}),
    prUrl,
  });
  for (const note of notes) {
    await sink.emit({ type: 'log', text: note, who: 'runner' });
  }
  if (!ok && body.report === undefined) {
    const hint = stderrTail.join('').trim().split('\n').at(-1) ?? '';
    body.report = {
      status: 'PARTIAL',
      next_action: `inspect harness exit ${exitCode}${hint ? `: ${hint.slice(0, 200)}` : ''}`,
    };
  }
  await sink.emit(body);

  if (ok) {
    await sink.emit({ type: 'state', state: 'done' });
    process.exit(0);
  } else {
    await sink.emit({ type: 'state', state: 'cancelled', reason: 'harness-exit' });
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
