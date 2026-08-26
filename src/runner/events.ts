/**
 * Event emitter for the runner: posts events to the daemon's internal
 * endpoint, owning the monotonic seq counter (starts at 0) for the job.
 *
 * Posting is serialized so events arrive in ascending seq order. Delivery
 * survives daemon blips (issue #109):
 *
 * - Every post gets a finite timeout and real retries with exponential
 *   backoff — a transient outage no longer fails an event after one
 *   instant retry.
 * - A post whose attempts are exhausted, or that the buffer sheds under
 *   pressure, is *dropped and counted*, never turned into a rejected
 *   promise: emit()/emitBatch() cannot reject, so a fire-and-forget caller
 *   can no longer die of an orphaned rejection. A permanent failure leaves
 *   a seq gap the daemon tolerates; the cumulative drop count surfaces in
 *   the settle notes (see composeSettle).
 * - The pending buffer is bounded. Under pressure, droppable events
 *   (log/think) are shed in favour of state/settle/decision events.
 * - A retried post answered 422 with a body naming seq/duplicate counts as
 *   delivered: the write was applied but its response was lost. Full
 *   daemon-side idempotency (`deduped: true`) lands with Wave-2 #113; this
 *   heuristic keeps the runner alive until then.
 */

import { setTimeout as delay } from 'node:timers/promises';

export type EventBody = Record<string, unknown>;

/**
 * The producer's event shape, as posted to `/internal/jobs/:id/events`:
 * carries `job` and `at`, and its seq is the runner's claim — the daemon
 * re-stamps the authoritative one. Deliberately NOT named like the consumer
 * view (`FleetEvent`, src/shared/events.ts): the two are different contracts,
 * and one name across both is how a reader conflates them (#128).
 */
type RunnerEvent = {
  job: string;
  seq: number;
  at: string;
  type: string;
} & EventBody;

/** Event types that may be shed when the buffer is full. */
const DROPPABLE: Record<string, true> = { log: true, think: true };

/** Positive integer from env or the fallback. */
function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** One buffered, not-yet-delivered post (single JSON body or ndjson batch). */
type PendingPost = {
  payload: string;
  contentType: string;
  /** Events carried by this post (one, or many for a batch). */
  events: RunnerEvent[];
  /** True when every carried event may be shed under pressure. */
  droppable: boolean;
  /** Resolved once the post is delivered or permanently abandoned. */
  completion: Promise.withResolvers<void>;
};


export class EventSink {
  readonly jobId: string;
  readonly daemonUrl: string;
  readonly token: string;
  /** Cumulative count of events dropped (buffer pressure + failed sends). */
  dropped = 0;
  /** Message from the most recent permanent delivery failure, if any. */
  lastDeliveryError: string | undefined;
  private seq = 0;
  /** Bounded FIFO of unsent posts, in ascending seq order. */
  private buffer: PendingPost[] = [];
  /** True while the pump owns a send attempt. */
  private sending = false;
  private pumping = false;
  private idleWaiters: (() => void)[] = [];
  private pressureWarned = false;
  /** Depth-change hook: the runner pauses harness stdout above a watermark. */
  private readonly onDepth: ((depth: number) => void) | undefined;
  private readonly maxPending: number;
  private readonly postTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;

  constructor(opts: {
    jobId: string;
    daemonUrl: string;
    token: string;
    /** Buffered-post cap; overflow sheds droppable posts first. Default 256. */
    maxPending?: number;
    onDepth?: (depth: number) => void;
  }) {
    this.jobId = opts.jobId;
    this.daemonUrl = opts.daemonUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.onDepth = opts.onDepth;
    this.maxPending = opts.maxPending ?? envInt('FLEET_EVENT_BUFFER_MAX', 256);
    this.postTimeoutMs = envInt('FLEET_EVENT_POST_TIMEOUT_MS', 15_000);
    this.retryBaseMs = envInt('FLEET_EVENT_RETRY_BASE_MS', 500);
    this.retryMaxMs = envInt('FLEET_EVENT_RETRY_MAX_MS', 8_000);
    this.maxAttempts = envInt('FLEET_EVENT_MAX_ATTEMPTS', 5);
  }

  /** Build a full event, claiming the next seq. */
  private build(body: EventBody): RunnerEvent {
    return {
      job: this.jobId,
      seq: this.seq++,
      at: new Date().toISOString(),
      ...body,
    } as RunnerEvent;
  }

  /** Emit a single event (one JSON body per request). Never rejects. */
  emit(body: EventBody): Promise<RunnerEvent> {
    const event = this.build(body);
    const post: PendingPost = {
      payload: JSON.stringify(event),
      contentType: 'application/json',
      events: [event],
      droppable: DROPPABLE[String(event.type)] === true,
      completion: Promise.withResolvers<void>(),
    };
    this.admit(post);
    return post.completion.promise.then(() => event);
  }

  /** Emit several events as one ndjson batch request. Never rejects. */
  emitBatch(bodies: EventBody[]): Promise<RunnerEvent[]> {
    if (bodies.length === 0) return Promise.resolve([]);
    const events = bodies.map((body) => this.build(body));
    const post: PendingPost = {
      payload: events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      contentType: 'application/x-ndjson',
      events,
      droppable: events.every((event) => DROPPABLE[String(event.type)] === true),
      completion: Promise.withResolvers<void>(),
    };
    this.admit(post);
    return post.completion.promise.then(() => events);
  }

  /** Current number of buffered (not yet delivered or abandoned) posts. */
  get depth(): number {
    return this.buffer.length;
  }

  /**
   * Resolves when every accepted post has been delivered or abandoned:
   * the tail wait that replaced the unbounded emits array (#109).
   */
  flush(): Promise<void> {
    if (!this.pumping && !this.sending && this.buffer.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Claim a buffer slot and start the pump. Synchronous on purpose: seq
   * order equals claim order, so admission must never reorder the buffer
   * (the daemon rejects seq regressions). Overflow sheds droppables —
   * preferentially already-buffered ones, keeping must-deliver events.
   */
  private admit(post: PendingPost): void {
    while (this.buffer.length >= this.maxPending) {
      // Prefer shedding the incoming line over an already-queued one.
      if (post.droppable) {
        this.shed(post.events.length);
        if (!this.pressureWarned) {
          this.pressureWarned = true;
          console.error(
            `runner: event buffer full (${this.maxPending}); shedding log/think events` +
            ` — ${this.dropped} dropped so far`,
          );
        }
        post.completion.resolve();
        return;
      }
      // Must-deliver event with a full buffer: shed a buffered droppable
      // (splicing keeps seq order), else the oldest post whatever it is.
      const droppableAt = this.buffer.findIndex((item) => item.droppable);
      const [evicted] = this.buffer.splice(droppableAt !== -1 ? droppableAt : 0, 1);
      this.shed(evicted.events.length);
      evicted.completion.resolve();
    }
    this.buffer.push(post);
    this.notifyDepth();
    this.ensurePump();
  }

  private shed(count: number): void {
    this.dropped += count;
    this.notifyDepth();
  }

  private ensurePump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pump();
  }

  /** Serial sender: head-of-line retries with backoff; failures drop+count. */
  private async pump(): Promise<void> {
    while (this.buffer.length > 0) {
      const post = this.buffer[0];
      this.sending = true;
      try {
        await this.postWithRetry(post);
      } catch (err) {
        this.shed(post.events.length);
        this.lastDeliveryError = String(err instanceof Error ? err.message : err);
        console.error(
          `runner: event delivery failed after ${this.maxAttempts} attempts` +
          ` (seq ${post.events[0].seq}${post.events.length > 1 ? `-${post.events.at(-1)?.seq}` : ''}):` +
          ` ${this.lastDeliveryError} — continuing without it`,
        );
      }
      this.sending = false;
      this.buffer.shift();
      // Resolve completion AFTER dequeuing so flush() doesn't see a lingering
      // post whose promise already settled; both delivery and drop resolve it.
      post.completion.resolve();
      this.notifyDepth();
    }
    this.pumping = false;
    // A later admit() re-warns; the buffer has fully drained here.
    this.pressureWarned = false;
    this.signalIdle();
  }

  private signalIdle(): void {
    if (this.pumping || this.sending || this.buffer.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private notifyDepth(): void {
    this.onDepth?.(this.buffer.length);
  }

  private async postWithRetry(post: PendingPost): Promise<void> {
    const url =
      `${this.daemonUrl}/internal/jobs/${encodeURIComponent(this.jobId)}/events`;
    let lastError = '';
    for (let attempt = 1; ; attempt++) {
      let status = 0;
      let bodyText = '';
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': post.contentType,
            'x-fleet-runner-token': this.token,
          },
          body: post.payload,
          // A stalled daemon must hold the serialized queue for seconds,
          // not undici's ~300s default: every post gets a finite timeout.
          signal: AbortSignal.timeout(this.postTimeoutMs),
        });
        status = response.status;
        bodyText = await response.text().catch(() => '');
        if (response.ok) return;
      } catch (err) {
        lastError = String(err instanceof Error ? err.message : err);
      }
      // Write applied but the response was lost: a matching retry comes
      // back 422 with the rejection naming the duplicate seq. Counting
      // that as fatal would drop an event the daemon actually recorded.
      if (
        status === 422 &&
        attempt > 1 &&
        /seq|duplicate|dedup/i.test(bodyText)
      ) {
        return;
      }
      // Only transient failures retry: network errors, timeouts, 5xx, 429.
      // Other 4xx responses are deterministic rejections — drop and count.
      const transient = status === 0 || status === 429 || status >= 500;
      if (!transient || attempt >= this.maxAttempts) {
        throw new Error(
          lastError ||
          `daemon rejected event post (${status}): ${bodyText.slice(0, 500)}`,
        );
      }
      await delay(Math.min(this.retryBaseMs * 2 ** (attempt - 1), this.retryMaxMs));
    }
  }
}
