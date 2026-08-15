import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EventSink } from '../src/runner/events.ts';
import { DecisionWatcher } from '../src/runner/decisions.ts';
import { startMockDaemon } from './runner-mock-daemon.ts';

const VALID_DECISION = {
  question: 'Which storage backend should the export use?',
  who: 'author',
  note: 'Policy call: cost vs durability tradeoff the work order does not settle.',
  options: [
    { id: 's3', label: 'Object storage', recommended: true },
    { id: 'efs', label: 'Shared filesystem' },
  ],
};

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('condition not met in time');
    await delay(20);
  }
}

test('valid decision file round-trips: event → answer long-poll → answer file', async () => {
  const token = 'test-token-decisions';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-dec-'));
  const outDir = join(workspace, '.fleet', 'out');
  mkdirSync(outDir, { recursive: true });

  const sink = new EventSink({ jobId: 'job-dec-1', daemonUrl: daemon.url, token });
  const watcher = new DecisionWatcher({ workspace, sink, intervalMs: 25 });
  watcher.start();
  try {
    writeFileSync(join(outDir, 'decision.json'), JSON.stringify(VALID_DECISION));

    // The decision event must be raised before any answer exists — this
    // proves at least one empty long-poll cycle happens first.
    await until(() => daemon.events.some((event) => event.type === 'decision'));
    const decision = daemon.events.find((event) => event.type === 'decision');
    assert.ok(decision);
    assert.equal(decision.id, 'd1');
    assert.equal(decision.question, VALID_DECISION.question);
    assert.equal(decision.who, 'author');
    assert.deepEqual(decision.options, VALID_DECISION.options);

    daemon.answer('d1', { option: 's3', text: 'stay in object storage' });

    await until(() => existsSync(join(outDir, 'answer-d1.json')));
    const answer = JSON.parse(readFileSync(join(outDir, 'answer-d1.json'), 'utf8'));
    assert.deepEqual(answer, { option: 's3', text: 'stay in object storage' });

    await until(() => !existsSync(join(outDir, 'decision.json')));
    assert.equal(watcher.count, 1);
    assert.deepEqual(daemon.rejected, []);
  } finally {
    await watcher.stop();
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('second decision gets id d2 and its own answer file', async () => {
  const token = 'test-token-decisions-2';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-dec-'));
  const outDir = join(workspace, '.fleet', 'out');
  mkdirSync(outDir, { recursive: true });

  const sink = new EventSink({ jobId: 'job-dec-2', daemonUrl: daemon.url, token });
  const watcher = new DecisionWatcher({ workspace, sink, intervalMs: 25 });
  watcher.start();
  try {
    daemon.answer('d1', { option: 's3' });
    daemon.answer('d2', { text: 'free-text answer' });

    writeFileSync(join(outDir, 'decision.json'), JSON.stringify(VALID_DECISION));
    await until(() => existsSync(join(outDir, 'answer-d1.json')));
    await until(() => !existsSync(join(outDir, 'decision.json')));

    writeFileSync(join(outDir, 'decision.json'), JSON.stringify(VALID_DECISION));
    await until(() => existsSync(join(outDir, 'answer-d2.json')));

    assert.equal(watcher.count, 2);
    assert.deepEqual(
      daemon.events.filter((event) => event.type === 'decision').map((event) => event.id),
      ['d1', 'd2'],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(outDir, 'answer-d2.json'), 'utf8')),
      { text: 'free-text answer' },
    );
  } finally {
    await watcher.stop();
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('invalid decision file → decision-error.json + log event, watcher keeps going', async () => {
  const token = 'test-token-decisions-3';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-dec-'));
  const outDir = join(workspace, '.fleet', 'out');
  mkdirSync(outDir, { recursive: true });

  const sink = new EventSink({ jobId: 'job-dec-3', daemonUrl: daemon.url, token });
  const watcher = new DecisionWatcher({ workspace, sink, intervalMs: 25 });
  watcher.start();
  try {
    // Missing options entirely → schema-invalid.
    writeFileSync(join(outDir, 'decision.json'), JSON.stringify({ question: 'lonely?' }));

    await until(() => existsSync(join(outDir, 'decision-error.json')));
    await until(() => !existsSync(join(outDir, 'decision.json')));

    const errorFile = JSON.parse(readFileSync(join(outDir, 'decision-error.json'), 'utf8'));
    assert.ok(Array.isArray(errorFile.errors) && errorFile.errors.length > 0);

    await until(() => daemon.events.some((event) => event.type === 'log'));
    const log = daemon.events.find((event) => event.type === 'log');
    assert.ok(log);
    assert.match(String(log.text), /invalid decision file/);

    assert.equal(watcher.count, 0);
    assert.deepEqual(daemon.events.filter((event) => event.type === 'decision'), []);

    // Watcher is still alive: a valid decision after the bad one still works.
    daemon.answer('d1', { option: 's3' });
    writeFileSync(join(outDir, 'decision.json'), JSON.stringify(VALID_DECISION));
    await until(() => existsSync(join(outDir, 'answer-d1.json')));
    assert.equal(watcher.count, 1);
  } finally {
    await watcher.stop();
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});

test('non-JSON decision file is rejected after the mid-write grace tick', async () => {
  const token = 'test-token-decisions-4';
  const daemon = await startMockDaemon({ token });
  const workspace = mkdtempSync(join(tmpdir(), 'fleet-dec-'));
  const outDir = join(workspace, '.fleet', 'out');
  mkdirSync(outDir, { recursive: true });

  const sink = new EventSink({ jobId: 'job-dec-4', daemonUrl: daemon.url, token });
  const watcher = new DecisionWatcher({ workspace, sink, intervalMs: 25 });
  watcher.start();
  try {
    writeFileSync(join(outDir, 'decision.json'), '{"question": "trunca');
    await until(() => existsSync(join(outDir, 'decision-error.json')));
    assert.ok(!existsSync(join(outDir, 'decision.json')));
    assert.equal(watcher.count, 0);
  } finally {
    await watcher.stop();
    rmSync(workspace, { recursive: true, force: true });
    await daemon.close();
  }
});
