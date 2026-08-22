#!/usr/bin/env node
// Pickup gate for this repo: is this dispatch actually ready to pick up?
// Runs before any model spend. Exit 0 = ready, 1 = not ready, 2 = cannot
// evaluate (missing target, a target that is not an issue number in a strict
// mode, no gh, no network) — the runner treats any nonzero exit as an abort,
// with this script's output as the evidence.
//
// A gate should gate model spend proportionally to the authority the mode
// grants. implement/followthrough may write code and open PRs, so they pay the
// full GitHub-issue readiness check (D11): a vague implement dispatch dies here
// rather than burning a container (docs/architecture.md, "vagueness changes the
// mode, not the mechanism"). assess/investigate/review/compare carry no repo
// authority and deliver a report artifact (#18), so a prose target is a
// legitimate dispatch, not a defect — they pass with a note. An unrecognized
// mode is treated as strict; the gate never relaxes on a guess. A missing
// target fails in every mode: nothing can be gated blind.
// Exception (#80): a followthrough order carrying `continues` adopts an
// existing PR's branch, so it verifies that PR (exists, open, head matches)
// instead of issue readiness — the deliverable is the PR, and its issue is
// often already closed.
//
// Target resolution order: first argument, $FLEET_TARGET, .fleet/order.json
// target. Mode resolution order: $FLEET_MODE, .fleet/order.json mode, else
// implement. Env outranks the staged order for both, deliberately and by the
// same rule: nothing in Fleet sets either var, they exist so an operator can
// run this gate by hand against a checkout whose order.json belongs to some
// earlier dispatch. Two resolution orders for two neighbouring inputs would be
// the worse trade.
// Strict-mode checks: issue exists and is open; has the "ready" label; body
// carries an "## Acceptance" section; no branch fleet/<n>-* already on origin.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Modes whose authority is read-only: the deliverable is the report artifact,
 * so there is no issue that could be "ready". Exported because it restates a
 * fact owned by `presets/modes.json` (the presets granting neither edit nor
 * publish) — `test/gate.test.ts` derives the same set from that file, so a
 * preset that later gains edit authority fails here instead of silently
 * keeping its exemption.
 */
export const REPORT_ONLY_MODES = new Set(['assess', 'investigate', 'review', 'compare']);

/**
 * Pure readiness decision — fixture-testable, no network.
 * Report-only modes short-circuit: they need a target and nothing else, so the
 * issue facts may be absent. Absent facts in a strict mode fail closed (not
 * ready) rather than throwing — a spend gate that crashes reports nothing
 * useful. The job's OWN branch never counts as a claim: the
 * runner pushes fleet/<issue>-<jobId> at creation BEFORE the gate runs, and a
 * parked job re-enters onto its existing branch — neither may trip the
 * collision guard.
 *
 * Followthrough continuation (#80): a followthrough order carrying `continues`
 * checks the PR it adopts — exists, open, head matches the adopted branch —
 * INSTEAD of issue readiness: the issue behind a delivered PR is often closed
 * and never re-labelled, and the deliverable is the PR itself. The adopted
 * branch is excluded from the claim guard exactly like a job's own branch;
 * every other claimant still blocks, and an implement dispatch (no continues)
 * still trips on the adopted branch — adoption is deliberate.
 * @param {{ mode?: string, state?: string, labels?: string[], body?: string, branches?: string[], issue: string, jobId?: string, continues?: { pr: number, branch: string }, prState?: string, prHead?: string }} facts
 * @returns {{ ready: boolean, findings: string[], note?: string }}
 */
export function evaluate({ mode, state, labels = [], body = '', branches = [], issue, jobId, continues, prState, prHead }) {
  if (REPORT_ONLY_MODES.has(mode)) {
    return {
      ready: true,
      findings: [],
      note: `${mode} mode is report-only — issue readiness not required for target "${issue}"`,
    };
  }
  const findings = [];
  if (mode === 'followthrough' && continues) {
    // Absent PR facts fail closed, same rule as absent issue facts below.
    if (prState === undefined || prState.toUpperCase() !== 'OPEN') {
      findings.push(`PR #${continues.pr} is ${prState ?? 'unknown'}, not open`);
    }
    if (prHead !== continues.branch) {
      findings.push(`PR #${continues.pr} head is ${prHead ?? 'unknown'}, not the adopted branch ${continues.branch}`);
    }
    findings.push(...claimFindings({ issue, jobId, branches, adopted: continues.branch }));
    return { ready: findings.length === 0, findings };
  }
  if (state !== undefined && state.toUpperCase() !== 'OPEN') {
    findings.push(`issue ${issue} is ${state}, not open`);
  }
  if (!labels.includes('ready')) {
    findings.push(`issue ${issue} lacks the "ready" label`);
  }
  if (!/^##\s+Acceptance\b/m.test(body)) {
    findings.push(`issue ${issue} body has no "## Acceptance" section`);
  }
  findings.push(...claimFindings({ issue, jobId, branches }));
  return { ready: findings.length === 0, findings };
}

/** The claim-collision guard: fleet/<issue>-* branches other than the job's own (and, on adoption, the adopted branch). */
function claimFindings({ issue, jobId, branches, adopted }) {
  const prefix = `fleet/${issue}-`;
  const own = jobId ? `${prefix}${jobId}` : undefined;
  const taken = branches.filter((b) => b.startsWith(prefix) && b !== own && b !== adopted);
  if (taken.length > 0) {
    return [`branch already claims this issue: ${taken.join(', ')}`];
  }
  return [];
}

/**
 * The staged work order, read once. Absent or unparseable yields {} — which
 * leaves the mode at its strict default, never at a relaxed guess.
 */
function readOrder() {
  if (!existsSync('.fleet/order.json')) return {};
  try {
    return JSON.parse(readFileSync('.fleet/order.json', 'utf8'));
  } catch (err) {
    console.error(`gate: unreadable .fleet/order.json: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

function resolveTarget(order) {
  if (process.argv[2]) return process.argv[2];
  if (process.env.FLEET_TARGET) return process.env.FLEET_TARGET;
  if (typeof order.target === 'string') return order.target;
  return undefined;
}

function resolveMode(order) {
  if (process.env.FLEET_MODE) return process.env.FLEET_MODE;
  if (typeof order.mode === 'string') return order.mode;
  return 'implement';
}

/** The staged order's continuation, when well-formed; anything else is undefined (strict path). */
function resolveContinues(order) {
  const c = order.continues;
  if (c && typeof c.pr === 'number' && typeof c.branch === 'string' && c.branch !== '') {
    return { pr: c.pr, branch: c.branch };
  }
  return undefined;
}

/** origin's fleet/<issue>-* branches, for the claim guard. */
function claimBranches(issue) {
  const lsRemote = execFileSync('git', ['ls-remote', '--heads', 'origin', `fleet/${issue}-*`], {
    encoding: 'utf8',
  });
  return lsRemote
    .split('\n')
    .map((line) => line.split('\t')[1] ?? '')
    .filter(Boolean)
    .map((ref) => ref.replace('refs/heads/', ''));
}

function main() {
  const order = readOrder();
  const target = resolveTarget(order);
  const mode = resolveMode(order);
  if (!target) {
    console.error('gate: no target (argv, $FLEET_TARGET, or .fleet/order.json)');
    process.exit(2);
  }
  // Report-only modes stop here: no issue to look up, so no gh/git round trip.
  if (REPORT_ONLY_MODES.has(mode)) {
    console.log(`gate: ${evaluate({ mode, issue: target }).note}`);
    process.exit(0);
  }
  // Followthrough continuation (#80): the dispatch adopts an existing PR's
  // branch, so the gate checks that PR instead of issue readiness. The claim
  // guard still runs when the target is an issue number — a rival job branch
  // other than the adopted one still blocks.
  const continues = mode === 'followthrough' ? resolveContinues(order) : undefined;
  if (continues) {
    const issue = target.replace(/^#/, '');
    let facts;
    try {
      const pr = JSON.parse(
        execFileSync('gh', ['pr', 'view', String(continues.pr), '--json', 'state,headRefName'], { encoding: 'utf8' }),
      );
      facts = {
        mode,
        issue,
        jobId: process.env.FLEET_JOB_ID,
        continues,
        prState: pr.state,
        prHead: pr.headRefName,
        branches: /^\d+$/.test(issue) ? claimBranches(issue) : [],
      };
    } catch (err) {
      console.error(`gate: cannot evaluate PR #${continues.pr}: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
    const { ready, findings } = evaluate(facts);
    if (ready) {
      console.log(`gate: PR #${continues.pr} is open on ${continues.branch} — continuation ready`);
      process.exit(0);
    }
    for (const finding of findings) console.error(`gate: ${finding}`);
    process.exit(1);
  }
  const issue = target.replace(/^#/, '');
  if (!/^\d+$/.test(issue)) {
    console.error(`gate: ${mode} mode requires a ready GitHub issue; target "${target}" is not an issue number`);
    process.exit(2);
  }

  let facts;
  try {
    const view = JSON.parse(
      execFileSync('gh', ['issue', 'view', issue, '--json', 'state,labels,body'], { encoding: 'utf8' }),
    );
    // Query the remote directly rather than trusting local refs — the gate
    // owns its own freshness (evaluate against live state, never a stale copy).
    facts = {
      issue,
      mode,
      jobId: process.env.FLEET_JOB_ID,
      state: view.state,
      labels: view.labels.map((l) => l.name),
      body: view.body ?? '',
      branches: claimBranches(issue),
    };
  } catch (err) {
    console.error(`gate: cannot evaluate issue ${issue}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  const { ready, findings } = evaluate(facts);
  if (ready) {
    console.log(`gate: issue ${issue} is ready`);
    process.exit(0);
  }
  for (const finding of findings) console.error(`gate: ${finding}`);
  process.exit(1);
}

// Run only as a script; importing for tests must not execute the gate.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main();
}
