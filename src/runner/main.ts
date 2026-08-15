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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { EventSink } from './events.ts';
import { translateLine } from './translate.ts';
import { DecisionWatcher } from './decisions.ts';
import { composeSettle } from './settle.ts';

const HARNESS_DEFAULTS: Record<string, string> = {
  'claude-code': 'claude -p --output-format stream-json --verbose',
};

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
  const watcher = new DecisionWatcher({ workspace, sink });
  watcher.start();

  const harness = (manifest.harness ?? {}) as Record<string, unknown>;
  const cli = typeof harness.cli === 'string' ? harness.cli : 'claude-code';
  const cmd = process.env.FLEET_HARNESS_CMD ?? HARNESS_DEFAULTS[cli];
  if (!cmd) {
    await watcher.stop();
    await settleBlocked(sink, `no harness command known for cli "${cli}"`);
    await sink.emit({ type: 'state', state: 'cancelled', reason: 'harness-cmd' });
    process.exit(1);
  }

  const startedAt = Date.now();
  const child = spawn(cmd, {
    shell: true,
    cwd: workspace,
    env: process.env,
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

  const ok = exitCode === 0;
  const { body, notes } = composeSettle({
    jobId,
    startedAt,
    decisions: watcher.count,
    workspace,
    ...(ok ? { rung: 'implemented' } : {}),
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
