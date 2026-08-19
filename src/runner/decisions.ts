/**
 * Decision-file watcher: polls $FLEET_WORKSPACE/.fleet/out/decision.json
 * every 500ms. Valid file → decision event (ids d1, d2, ...), long-poll the
 * daemon for the operator's answer, write .fleet/out/answer-<id>.json for
 * the harness, delete decision.json, keep watching. Invalid file → write
 * decision-error.json with the validation errors, delete decision.json,
 * emit a log event, keep watching.
 *
 * block_hot (issue #6): when blockHotMs is set, a timer fires after that
 * duration while awaiting an answer. On expiry the watcher signals parking
 * via the `parked` promise (resolves with the decision id) and stops its
 * loop. The runner then commits WIP, emits state blocked/parked, and exits.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
// @ts-ignore -- plain-JS module, no type declarations
import { validateDecisionFile } from '../validate.mjs';
import type { EventSink } from './events.ts';
import type { WallClockTimer } from './wall-clock.ts';
import type { IdleTimer } from './idle.ts';

export type Answer = { option?: string; text?: string };

/**
 * A meter that must not run while the job waits on an operator: the wall-clock
 * budget (blocked time is not billed) and the idle timer (a harness polling for
 * an answer is silent on purpose, not stalled).
 */
type PausableMeter = { block(now?: number): void; resume(now?: number): void };

export class DecisionWatcher {
  /** Number of decisions raised so far (valid ones only). */
  count = 0;
  readonly intervalMs: number;
  private readonly sink: EventSink;
  private readonly outDir: string;
  private stopped = false;
  private readonly decisionPath: string;
  private loop: Promise<void> = Promise.resolve();
  /** Raw content seen failing JSON.parse last tick — tolerates one mid-write read. */
  private pendingRaw: string | null = null;
  /** Meters paused while awaiting an answer (wall-clock budget, idle timer). */
  private readonly meters: PausableMeter[];
  /** Optional block_hot limit in ms: fires when the hot window expires. */
  private readonly blockHotMs: number | undefined;
  /** Resolves with the decision id when block_hot fires (never resolves if unset). */
  readonly parked: Promise<string>;
  private readonly parkResolve: (id: string) => void;

  constructor(opts: {
    workspace: string;
    sink: EventSink;
    intervalMs?: number;
    wallClock?: WallClockTimer;
    idle?: IdleTimer;
    blockHotMs?: number;
  }) {
    this.sink = opts.sink;
    this.outDir = join(opts.workspace, '.fleet', 'out');
    this.decisionPath = join(this.outDir, 'decision.json');
    this.intervalMs = opts.intervalMs ?? 500;
    this.meters = [opts.wallClock, opts.idle].filter(
      (meter): meter is PausableMeter => meter !== undefined,
    );
    this.blockHotMs = opts.blockHotMs;
    let resolve!: (id: string) => void;
    this.parked = new Promise<string>((r) => { resolve = r; });
    this.parkResolve = resolve;
  }

  start(): void {
    this.loop = this.run();
  }

  /** Stop watching; resolves when the loop has fully wound down. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      await delay(this.intervalMs);
    }
  }

  private async tick(): Promise<void> {
    if (!existsSync(this.decisionPath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.decisionPath, 'utf8');
    } catch {
      return; // vanished between existsSync and read
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      this.pendingRaw = null;
    } catch {
      // Possibly a mid-write read: give the writer one interval to finish.
      if (this.pendingRaw !== raw) {
        this.pendingRaw = raw;
        return;
      }
      this.pendingRaw = null;
      await this.reject([{ message: 'decision.json is not valid JSON' }]);
      return;
    }

    const { ok, errors } = validateDecisionFile(parsed);
    if (!ok) {
      await this.reject(errors);
      return;
    }

    const file = parsed as Record<string, unknown>;
    const id = `d${++this.count}`;
    await this.sink.emit({
      type: 'decision',
      id,
      question: file.question,
      options: file.options,
      ...(file.who !== undefined ? { who: file.who } : {}),
      ...(file.note !== undefined ? { note: file.note } : {}),
    });

    const answer = await this.awaitAnswer(id);
    if (answer === null) return; // stopped (or parked) while waiting
    writeFileSync(
      join(this.outDir, `answer-${id}.json`),
      JSON.stringify(answer, null, 2) + '\n',
    );
    rmSync(this.decisionPath, { force: true });
  }

  private async reject(errors: unknown): Promise<void> {
    writeFileSync(
      join(this.outDir, 'decision-error.json'),
      JSON.stringify({ errors }, null, 2) + '\n',
    );
    rmSync(this.decisionPath, { force: true });
    await this.sink.emit({
      type: 'log',
      text: `invalid decision file rejected; details in .fleet/out/decision-error.json`,
      who: 'runner',
    });
  }

  /** Long-poll the daemon until the operator answers this decision.
   *  Returns null when stopped or when the block_hot timer fires (parking). */
  private async awaitAnswer(id: string): Promise<Answer | null> {
    // Pause the meters: blocked time counts against neither the wall-clock
    // budget nor the stall threshold.
    for (const meter of this.meters) meter.block();
    const url =
      `${this.sink.daemonUrl}/internal/jobs/${encodeURIComponent(this.sink.jobId)}` +
      `/answer?decision=${encodeURIComponent(id)}`;

    // block_hot timer: when the hot window expires, signal parking and stop.
    let parkTimer: ReturnType<typeof setTimeout> | null = null;
    if (this.blockHotMs !== undefined) {
      parkTimer = setTimeout(() => {
        this.parkResolve(id);
        this.stopped = true;
      }, this.blockHotMs);
    }

    try {
      while (!this.stopped) {
        let response: Response;
        try {
          response = await fetch(url, {
            headers: { 'x-fleet-runner-token': this.sink.token },
          });
        } catch {
          await delay(this.intervalMs);
          continue;
        }
        if (response.ok && response.status !== 204) {
          return (await response.json()) as Answer;
        }
        await response.arrayBuffer().catch(() => {});
        // 204 / timeout cycle from the daemon: poll again.
      }
      return null;
    } finally {
      if (parkTimer !== null) clearTimeout(parkTimer);
      // Resume the meters whether an answer was received, the watcher was
      // stopped, or the block_hot timer fired.
      for (const meter of this.meters) meter.resume();
    }
  }
}
