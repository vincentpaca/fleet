/**
 * Event emitter for the runner: posts events to the daemon's internal
 * endpoint, owning the monotonic seq counter (starts at 0) for the job.
 *
 * Posting is serialized so events arrive in seq order. Network errors are
 * retried once; a second failure (or any non-2xx response) rejects loudly —
 * the runner must never silently drop events.
 */

export type EventBody = Record<string, unknown>;

export type FleetEvent = {
  job: string;
  seq: number;
  at: string;
  type: string;
} & EventBody;

export class EventSink {
  readonly jobId: string;
  readonly daemonUrl: string;
  readonly token: string;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { jobId: string; daemonUrl: string; token: string }) {
    this.jobId = opts.jobId;
    this.daemonUrl = opts.daemonUrl.replace(/\/$/, '');
    this.token = opts.token;
  }

  /** Build a full event, claiming the next seq. */
  private build(body: EventBody): FleetEvent {
    return {
      job: this.jobId,
      seq: this.seq++,
      at: new Date().toISOString(),
      ...body,
    } as FleetEvent;
  }

  /** Emit a single event (one JSON body per request). */
  emit(body: EventBody): Promise<FleetEvent> {
    const event = this.build(body);
    return this.enqueue(() =>
      this.post(JSON.stringify(event), 'application/json'),
    ).then(() => event);
  }

  /** Emit several events as one ndjson batch request. */
  emitBatch(bodies: EventBody[]): Promise<FleetEvent[]> {
    if (bodies.length === 0) return Promise.resolve([]);
    const events = bodies.map((body) => this.build(body));
    const ndjson = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    return this.enqueue(() => this.post(ndjson, 'application/x-ndjson')).then(
      () => events,
    );
  }

  /** Serialize sends; a failed send rejects its caller but never wedges the queue. */
  private enqueue(send: () => Promise<void>): Promise<void> {
    const result = this.queue.then(send, send);
    this.queue = result.catch(() => {});
    return result;
  }

  private async post(payload: string, contentType: string): Promise<void> {
    const url = `${this.daemonUrl}/internal/jobs/${encodeURIComponent(this.jobId)}/events`;
    const request = () =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': contentType,
          'x-fleet-runner-token': this.token,
        },
        body: payload,
      });

    let response: Response;
    try {
      response = await request();
    } catch {
      // Retry exactly once on network error; a second failure propagates.
      response = await request();
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `daemon rejected event post (${response.status}): ${detail.slice(0, 500)}`,
      );
    }
    // Drain the body so the socket is released.
    await response.arrayBuffer().catch(() => {});
  }
}
