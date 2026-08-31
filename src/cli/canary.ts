/**
 * `fleet canary` — prove the deployment on a live job (#220).
 *
 * #218 sat latent for three days: the bug merged, the runner image was
 * rebuilt at the broken ref, and the first real dispatch was the discovery.
 * Doctor checks what it can reach without spending — tunnel, auth, token,
 * skew — and none of that says a job can clone, run, and settle on the image
 * the deployment actually runs. This command spends one small job to find
 * out, through the same dispatch path every real job takes (same manifest,
 * env, image build, git wiring): a second path would prove the wrong thing.
 *
 * The verdict is the daemon's own terminal state plus the settle report:
 * exit 0 only when the job lands `done` with a READY report. A canary that
 * blocks on a decision or outlives its deadline is cancelled and reported as
 * a failure — a canary the operator has to babysit answers nothing. The
 * claim branch stays on origin by default (evidence is retained, never
 * deleted — the reclaim convention); --delete-branch removes it after a
 * pass, when it provably carries no work.
 */

type DelegateFn = (req: {
  target: string;
  log: (line: string) => void;
  warn: (line: string) => void;
}) => Promise<{ jobId: string; state: string }>;

type CallFn = (
  method: string,
  reqPath: string,
  body?: unknown,
) => Promise<{ status: number; body: string; json: unknown }>;

export type CanaryOptions = {
  delegate: DelegateFn;
  call: CallFn;
  /** `git push origin --delete <branch>` in the operator's checkout; true on success. */
  deleteRemoteBranch: (branch: string) => boolean;
  /** --delete-branch: remove the claim branch after a pass. */
  deleteBranch: boolean;
  log: (line: string) => void;
  warn: (line: string) => void;
  pollMs?: number;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** The whole prompt is the target (#36): prose shape — read-only, inspected, no publish. */
const CANARY_TARGET =
  'Canary: prove this deployment can run a job. Change no files and ask no decisions. '
  + 'Write .fleet/out/report.json with status READY, verification listing what you observed, '
  + 'not_done [], and next_action "canary complete".';

const POLL_MS = 2_000;
/** Generous because a first canary pays for a job-image build; it bounds a hang, not a healthy run. */
const DEADLINE_MS = 20 * 60_000;
/** Polls granted after a cancel to let the daemon land the terminal state — never forever. */
const CANCEL_GRACE_POLLS = 30;

type JobView = {
  state: string;
  settle?: { rung?: string; report?: { status?: string; next_action?: string } };
};

async function fetchJob(opts: CanaryOptions, jobId: string): Promise<JobView | undefined> {
  const res = await opts.call('GET', `/jobs/${encodeURIComponent(jobId)}`);
  if (res.status !== 200) return undefined;
  return (res.json as { job: JobView }).job;
}

async function cancelJob(opts: CanaryOptions, jobId: string, why: string): Promise<void> {
  opts.warn(`canary: cancelling ${jobId}: ${why}`);
  const res = await opts.call('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`);
  if (res.status !== 200) {
    opts.warn(`canary: cancel refused (HTTP ${res.status}) — the job may still be running`);
  }
}

/** The three knobs with their defaults resolved, so the watch loop stays legible. */
function pacing(opts: CanaryOptions): { pollMs: number; deadlineMs: number; sleep: (ms: number) => Promise<void> } {
  return {
    pollMs: opts.pollMs ?? POLL_MS,
    deadlineMs: opts.deadlineMs ?? DEADLINE_MS,
    sleep: opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
}

/** Why this still-running canary should be cancelled now — or undefined to keep waiting. */
function stallReason(job: JobView, deadline: number, deadlineMs: number): string | undefined {
  if (job.state === 'blocked') return 'the job asked for a decision — a canary must not';
  if (Date.now() > deadline) return `no terminal state within ${Math.round(deadlineMs / 60_000)}m`;
  return undefined;
}

/**
 * Poll to a terminal state. Two situations end the wait early, and both
 * cancel rather than walk away: a blocked canary (it was told not to ask)
 * and an overdue one. `failure` carries the reason into the verdict; the
 * grace bound keeps a cancel the daemon never lands from polling forever.
 */
async function watchToTerminal(
  opts: CanaryOptions,
  jobId: string,
): Promise<{ job: JobView | undefined; failure?: string }> {
  const { pollMs, deadlineMs, sleep } = pacing(opts);
  const deadline = Date.now() + deadlineMs;
  let failure: string | undefined;
  let grace = Infinity;
  for (;;) {
    const job = await fetchJob(opts, jobId);
    if (job === undefined) return { job: undefined, failure: failure ?? 'the daemon stopped answering for this job' };
    if (job.state === 'done' || job.state === 'cancelled') return { job, failure };
    if (failure === undefined) {
      failure = stallReason(job, deadline, deadlineMs);
      if (failure !== undefined) {
        await cancelJob(opts, jobId, failure);
        grace = CANCEL_GRACE_POLLS;
      }
    }
    if (grace-- <= 0) return { job, failure };
    await sleep(pollMs);
  }
}

/**
 * The two log lines that identify what actually ran: the image build stamp
 * (#207) and the claim-branch push (#2). Read from the job's own event log —
 * the record a stale image cannot fake and a broken clone never writes.
 */
async function jobEvidence(opts: CanaryOptions, jobId: string): Promise<{ stamp?: string; branch?: string }> {
  const res = await opts.call('GET', `/jobs/${encodeURIComponent(jobId)}/events`);
  if (res.status !== 200) return {};
  const found: { stamp?: string; branch?: string } = {};
  for (const line of res.body.split('\n')) {
    if (line === '') continue;
    let event: { type?: string; text?: string };
    try {
      event = JSON.parse(line) as { type?: string; text?: string };
    } catch {
      continue;
    }
    if (event.type !== 'log' || typeof event.text !== 'string') continue;
    const stamp = /^runner image built at ([0-9a-f]{7,40})$/.exec(event.text);
    if (stamp !== null) found.stamp = stamp[1];
    const branch = /^workspace on branch (\S+) \(pushed\)$/.exec(event.text);
    if (branch !== null) found.branch = branch[1];
  }
  return found;
}

/** Delete only what is provably this canary's (the job id is in the name), and only when asked. */
function handleBranch(opts: CanaryOptions, jobId: string, branch: string): void {
  if (!opts.deleteBranch) {
    opts.log(`canary: claim branch left on origin (evidence convention): ${branch}`);
    opts.log(`  remove it with: git push origin --delete ${branch}`);
    return;
  }
  if (!branch.includes(jobId)) {
    opts.warn(`canary: not deleting ${branch} — it does not carry job id ${jobId}`);
    return;
  }
  if (opts.deleteRemoteBranch(branch)) {
    opts.log(`canary: deleted claim branch ${branch}`);
  } else {
    opts.warn(`canary: could not delete ${branch} — remove it by hand: git push origin --delete ${branch}`);
  }
}

/** The pass bar: the daemon's own terminal state AND the settle report's word for it. */
function passed(job: JobView | undefined): job is JobView {
  return job !== undefined && job.state === 'done' && job.settle?.report?.status === 'READY';
}

function rungNote(job: JobView): string {
  const rung = job.settle?.rung;
  return rung === undefined ? '' : ` (rung ${rung})`;
}

function logEvidence(opts: CanaryOptions, evidence: { stamp?: string; branch?: string }): void {
  if (evidence.stamp !== undefined) opts.log(`canary: runner image built at ${evidence.stamp}`);
  if (evidence.branch === undefined) {
    opts.warn('canary: no claim branch was pushed — without workspace.repo the git path goes unproven');
  }
}

function failVerdict(
  opts: CanaryOptions,
  outcome: { job: JobView | undefined; failure?: string },
  evidence: { branch?: string },
): void {
  const report = outcome.job?.settle?.report;
  const fallback = outcome.job?.state === 'done' ? `report status ${report?.status ?? 'missing'}` : 'no settle report';
  const detail = outcome.failure ?? report?.next_action ?? fallback;
  opts.warn(`canary: FAIL — job ${outcome.job?.state ?? 'unreachable'}: ${detail}`);
  if (evidence.branch !== undefined) {
    opts.warn(`canary: claim branch kept for the post-mortem: ${evidence.branch}`);
  }
}

/** One canary run: dispatch, follow, verdict. 0 = the deployment ran a job; 1 = it did not. */
export async function runCanary(opts: CanaryOptions): Promise<number> {
  const { jobId } = await opts.delegate({ target: CANARY_TARGET, log: opts.log, warn: opts.warn });
  opts.log(`canary: dispatched ${jobId} — following to a terminal state`);

  const outcome = await watchToTerminal(opts, jobId);
  const evidence = await jobEvidence(opts, jobId);
  logEvidence(opts, evidence);

  if (passed(outcome.job)) {
    opts.log(`canary: PASS — job settled done, report READY${rungNote(outcome.job)}`);
    if (evidence.branch !== undefined) handleBranch(opts, jobId, evidence.branch);
    return 0;
  }
  failVerdict(opts, outcome, evidence);
  return 1;
}
