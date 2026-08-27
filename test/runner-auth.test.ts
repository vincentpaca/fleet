/**
 * Mid-job auth failure parks behind a decision (#205).
 *
 * Before this, a harness that died complaining about its credential rode out
 * as cancelled(harness-exit) — a cryptic exit 1 for the one failure whose fix
 * ("refresh, then retry or re-dispatch") the operator has to be taught. These
 * tests fail on the old code: the plain and stderr shapes ended cancelled,
 * and no decision event existed.
 *
 * The scope tests pin the conservative side: auth-looking strings inside job
 * CONTENT (assistant text) must not park, and neither must a signature seen
 * on a run that exits 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDaemon, type PostedEvent } from './runner-mock-daemon.ts';
import { authFailureIn, AUTH_FAILURE_SIGNATURES } from '../src/runner/auth-failure.ts';

const runnerMain = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url));
const authHarness = fileURLToPath(new URL('../fixtures/auth-fail-harness.mjs', import.meta.url));

// ---------- the matcher itself ----------

test('authFailureIn: recognizes each documented signature, on its own line, clipped', () => {
  for (const signature of AUTH_FAILURE_SIGNATURES) {
    const hit = authFailureIn(`before\nsome ${signature} complaint\nafter`);
    assert.ok(hit !== undefined, `signature not recognized: ${signature}`);
    assert.equal(hit, `some ${signature} complaint`, 'evidence is the matching line alone');
  }
  const long = `Invalid API key ${'x'.repeat(400)}`;
  assert.ok(authFailureIn(long)!.length <= 201, 'evidence is clipped');
  assert.equal(authFailureIn('a perfectly healthy line'), undefined);
});

// ---------- end to end through the real runner ----------

function writeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-auth-'));
  mkdirSync(join(workspace, '.fleet', 'out'), { recursive: true });
  writeFileSync(
    join(workspace, '.fleet', 'manifest.json'),
    JSON.stringify({
      version: 1,
      setup: { image: 'node:22' },
      workspace: { repo: 'origin', strategy: 'branch-per-job' },
      harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }] },
      gates: { pickup: 'node -e "process.exit(0)"' },
    }),
  );
  return workspace;
}

async function runToExit(
  mode: string,
  jobId: string,
  token: string,
  daemonUrl: string,
  workspace: string,
): Promise<number> {
  const child = spawn(process.execPath, [runnerMain], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FLEET_'))),
      FLEET_JOB_ID: jobId,
      FLEET_DAEMON_URL: daemonUrl,
      FLEET_RUNNER_TOKEN: token,
      FLEET_WORKSPACE: workspace,
      FLEET_HARNESS_CMD: `node ${authHarness} ${mode}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = Promise.withResolvers<number>();
  child.on('close', (code) => exited.resolve(code ?? -1));
  return await exited.promise;
}

function lastState(events: PostedEvent[]): PostedEvent | undefined {
  return [...events].reverse().find((event) => event.type === 'state');
}

test('a harness dying on a plain-line credential refusal parks with the decision, not cancelled(harness-exit)', async () => {
  const token = 'auth-park-token';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace();
  try {
    const code = await runToExit('plain', 'job-auth-plain', token, daemon.url, workspace);
    assert.equal(code, 0, 'a park is a clean exit, not a failure');

    const decision = daemon.events.find((event) => event.type === 'decision');
    assert.ok(decision, `no decision event; events: ${JSON.stringify(daemon.events)}`);
    assert.equal(decision.id, 'd1');
    assert.match(String(decision.question), /authentication failed/i);
    const options = decision.options as Array<{ id: string; recommended?: boolean }>;
    assert.deepEqual(options.map((option) => option.id), ['retry', 'abort']);
    assert.equal(options.find((option) => option.recommended)?.id, 'retry');
    assert.match(String(decision.note), /Invalid API key/, 'the note carries the harness evidence');

    const state = lastState(daemon.events);
    assert.equal(state?.state, 'blocked', `expected blocked, got ${JSON.stringify(state)}`);
    assert.equal(state?.marker, 'parked');
    assert.ok(
      !daemon.events.some((event) => event.type === 'state' && event.reason === 'harness-exit'),
      'the cryptic cancelled(harness-exit) must not appear',
    );
    assert.deepEqual(daemon.rejected, [], 'every emitted event is schema-valid');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('the refusal on stderr alone still parks — the CLI error channel counts', async () => {
  const token = 'auth-park-stderr';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace();
  try {
    const code = await runToExit('stderr', 'job-auth-stderr', token, daemon.url, workspace);
    assert.equal(code, 0);
    assert.ok(daemon.events.some((event) => event.type === 'decision'), 'decision raised');
    const state = lastState(daemon.events);
    assert.equal(state?.state, 'blocked');
    assert.equal(state?.marker, 'parked');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('auth-looking strings inside assistant CONTENT do not park: still cancelled(harness-exit)', async () => {
  // A job whose WORK is about auth (this repo included) echoes these strings
  // through tool_results and assistant text all day; mistaking that for a
  // dead credential would park healthy-but-failed jobs behind a lying
  // decision. Conservative scope: content channels are never scanned.
  const token = 'auth-scope-token';
  const daemon = await startMockDaemon({ token });
  const workspace = writeWorkspace();
  try {
    const code = await runToExit('content', 'job-auth-content', token, daemon.url, workspace);
    assert.equal(code, 1, 'an ordinary harness failure stays a failure');
    assert.ok(!daemon.events.some((event) => event.type === 'decision'), 'no decision');
    const state = lastState(daemon.events);
    assert.equal(state?.state, 'cancelled');
    assert.equal(state?.reason, 'harness-exit');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});
