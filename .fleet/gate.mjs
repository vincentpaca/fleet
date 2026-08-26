#!/usr/bin/env node
// Pickup gate for this repo: is this dispatch actually ready to pick up?
// Runs before any model spend. Exit 0 = ready, 1 = not ready, 2 = cannot
// evaluate (missing target, no gh, no network) — the runner treats any nonzero
// exit as an abort, with this script's output as the evidence.
//
// Strictness keys on the shape of the dispatch, not on a requested mode (#36,
// docs/decisions.md#d17). Three shapes, read off the order's own fields:
//
//   `continues` present  → adoption. Verify the adopted PR (exists, open, head
//                          matches the named branch) plus the claim guard. The
//                          deliverable is that PR, and the issue behind a
//                          delivered PR is routinely closed (#80).
//   numeric target       → issue. Pay the full GitHub-issue readiness check
//                          (D11): open, "ready" label, an "## Acceptance"
//                          section, no rival fleet/<n>-* branch on origin. A
//                          vague issue dispatch dies here rather than burning a
//                          container.
//   anything else        → prose. Pass with a note: there is no issue that
//                          could be "ready", and the deliverable is the report
//                          artifact (#18).
//
// A missing target fails in every shape: nothing can be gated blind. Note the
// consequence recorded in D17 — strictness follows shape, not authority, so a
// numeric target always pays the readiness check even when the dispatch is a
// read-only assessment. Assessing an unready issue is phrased as prose.
//
// Target resolution order: first argument, $FLEET_TARGET, .fleet/order.json
// target. Env outranks the staged order deliberately: nothing in Fleet sets
// that var, it exists so an operator can run this gate by hand against a
// checkout whose order.json belongs to some earlier dispatch.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Strip a leading "#" from a target like "#42" → "42". */
const STRIP_HASH = /^#/;
/** Issue number: only digits. */
const IS_ISSUE_NUM = /^\d+$/;
/** Required "## Acceptance" heading in strict-mode issue bodies. */
const ACCEPTANCE_HEADING = /^##\s+Acceptance\b/m;
/** Extract the name field from a GitHub label object; used with Array.map(). */
function labelName(l) { return l.name; }
/** Normalise a caught error to a message string. */
function errMsg(err) { return err instanceof Error ? err.message : String(err); }

/** Verify the PR facts for an adoption dispatch. */
function evaluateAdoption({ issue, jobId, continues, prState, prHead, branches }) {
  const findings = [];
  if (prState === undefined || prState.toUpperCase() !== 'OPEN') {
    findings.push(`PR #${continues.pr} is ${prState ?? 'unknown'}, not open`);
  }
  if (prHead !== continues.branch) {
    findings.push(`PR #${continues.pr} head is ${prHead ?? 'unknown'}, not the adopted branch ${continues.branch}`);
  }
  findings.push(...claimFindings({ issue, jobId, branches, adopted: continues.branch }));
  return { ready: findings.length === 0, findings };
}

/**
 * The dispatch's shape, from its own fields — the one place this gate decides
 * how strict to be (#36). Exported so the CLI-side classification has something
 * to be pinned against: the two implementations are deliberately independent
 * (the gate is repo-owned and must stand alone) and `test/gate.test.ts` asserts
 * they agree. `#42` and `42` are the same issue dispatch.
 * @param {{ continues?: unknown, target?: unknown }} order
 * @returns {'adoption' | 'issue' | 'prose'}
 */
export function dispatchShape(order) {
  if (order.continues) return 'adoption';
  const target = typeof order.target === 'string' ? order.target.replace(STRIP_HASH, '') : '';
  return IS_ISSUE_NUM.test(target) ? 'issue' : 'prose';
}

/**
 * Pure readiness decision — fixture-testable, no network. `issue` is the
 * target with any leading `#` already stripped.
 *
 * Prose dispatches short-circuit: they need a target and nothing else, so the
 * issue facts may be absent. Absent facts on an issue dispatch fail closed (not
 * ready) rather than throwing — a spend gate that crashes reports nothing
 * useful. The job's OWN branch never counts as a claim: the runner pushes
 * fleet/<issue>-<jobId> at creation BEFORE the gate runs, and a parked job
 * re-enters onto its existing branch — neither may trip the collision guard.
 *
 * Adoption (#80, re-keyed by #36): an order carrying `continues` checks the PR
 * it adopts — exists, open, head matches the adopted branch — INSTEAD of issue
 * readiness: the issue behind a delivered PR is often closed and never
 * re-labelled, and the deliverable is the PR itself. The adopted branch is
 * excluded from the claim guard exactly like a job's own branch; every other
 * claimant still blocks, and a dispatch without `continues` still trips on the
 * adopted branch — adoption is declared, never inferred.
 * @param {{ state?: string, labels?: string[], body?: string, branches?: string[], issue: string, jobId?: string, continues?: { pr: number, branch: string }, prState?: string, prHead?: string }} facts
 * @returns {{ ready: boolean, findings: string[], note?: string }}
 */
export function evaluate(facts) {
  const { state, labels = [], body = '', branches = [], issue, jobId, continues, prState, prHead } = facts;
  const shape = dispatchShape({ continues, target: issue });
  if (shape === 'adoption') {
    // Absent PR facts fail closed, same rule as absent issue facts below.
    return evaluateAdoption({ issue, jobId, continues, prState, prHead, branches });
  }
  if (shape === 'prose') {
    return {
      ready: true,
      findings: [],
      note: `prose dispatch — no issue readiness to check for target "${issue}"`,
    };
  }
  const findings = [];
  if (state !== undefined && state.toUpperCase() !== 'OPEN') {
    findings.push(`issue ${issue} is ${state}, not open`);
  }
  if (!labels.includes('ready')) {
    findings.push(`issue ${issue} lacks the "ready" label`);
  }
  if (!ACCEPTANCE_HEADING.test(body)) {
    findings.push(`issue ${issue} body has no "## Acceptance" section`);
  }
  findings.push(...claimFindings({ issue, jobId, branches }));
  return { ready: findings.length === 0, findings };
}

/**
 * Released claims (#30): a `-attempt<n>` suffix marks a branch a retry or
 * `fleet reclaim` renamed out of the way — evidence retained, claim released.
 * It starts with the same `fleet/<issue>-` prefix, so without this exemption
 * every re-dispatch after a failed attempt would trip on its own history.
 */
const RELEASED_CLAIM = /-attempt\d+$/;

/** The claim-collision guard: fleet/<issue>-* branches other than the job's own (and, on adoption, the adopted branch). Renamed `-attempt<n>` branches are released claims, not rivals. */
function claimFindings({ issue, jobId, branches, adopted }) {
  const prefix = `fleet/${issue}-`;
  const own = jobId ? `${prefix}${jobId}` : undefined;
  const taken = branches.filter(
    (b) => b.startsWith(prefix) && !RELEASED_CLAIM.test(b) && b !== own && b !== adopted,
  );
  if (taken.length > 0) {
    return [`branch already claims this issue: ${taken.join(', ')}`];
  }
  return [];
}

/**
 * The staged work order, read once. Absent or unparseable yields {} — which
 * leaves the shape to be read off the resolved target alone, never guessed
 * into adoption: no order means no `continues`, so no PR is ever taken on
 * trust.
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

/** The staged order's continuation, when well-formed; anything else is undefined (not an adoption). */
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

/** Fetch and assemble issue facts for the readiness check. Throws on gh failure. */
function buildIssueFacts(issue) {
  const view = JSON.parse(
    execFileSync('gh', ['issue', 'view', issue, '--json', 'state,labels,body'], { encoding: 'utf8' }),
  );
  // Query the remote directly rather than trusting local refs — the gate
  // owns its own freshness (evaluate against live state, never a stale copy).
  return {
    issue, jobId: process.env.FLEET_JOB_ID,
    state: view.state,
    labels: view.labels.map(labelName),
    body: view.body ?? '',
    branches: claimBranches(issue),
  };
}

/** Print findings and exit with the verdict's code. */
function reportVerdict({ ready, findings }, readyLine) {
  if (ready) {
    console.log(`gate: ${readyLine}`);
    process.exit(0);
  }
  for (const finding of findings) console.error(`gate: ${finding}`);
  process.exit(1);
}

/**
 * Adoption (#80): check the adopted PR instead of issue readiness.
 * Always calls process.exit(); extracting this keeps main() under the CCN threshold.
 */
function handleAdoption(issue, continues) {
  try {
    const pr = JSON.parse(
      execFileSync('gh', ['pr', 'view', String(continues.pr), '--json', 'state,headRefName'], { encoding: 'utf8' }),
    );
    const facts = {
      issue, jobId: process.env.FLEET_JOB_ID, continues,
      prState: pr.state, prHead: pr.headRefName,
      branches: IS_ISSUE_NUM.test(issue) ? claimBranches(issue) : [],
    };
    reportVerdict(evaluate(facts), `PR #${continues.pr} is open on ${continues.branch} — continuation ready`);
  } catch (err) {
    console.error(`gate: cannot evaluate PR #${continues.pr}: ${errMsg(err)}`);
    process.exit(2);
  }
}

/** Issue dispatch: the full readiness check, over live gh/git facts. */
function handleIssue(issue) {
  let facts;
  try {
    facts = buildIssueFacts(issue);
  } catch (err) {
    console.error(`gate: cannot evaluate issue ${issue}: ${errMsg(err)}`);
    process.exit(2);
  }
  reportVerdict(evaluate(facts), `issue ${issue} is ready`);
}

function main() {
  const order = readOrder();
  const target = resolveTarget(order);
  if (!target) {
    console.error('gate: no target (argv, $FLEET_TARGET, or .fleet/order.json)');
    process.exit(2);
  }
  const continues = resolveContinues(order);
  const shape = dispatchShape({ continues, target });
  // Adoption: the dispatch declared a PR to continue, so the gate checks that
  // PR instead of issue readiness. The claim guard still runs when the target
  // is an issue number — a rival job branch other than the adopted one blocks.
  if (shape === 'adoption') {
    handleAdoption(target.replace(STRIP_HASH, ''), continues);
    return; // handleAdoption always exits; return satisfies control-flow analysis
  }
  // Prose stops here: no issue to look up, so no gh/git round trip. The target
  // is echoed as typed — a `#` the operator wrote is part of what they asked.
  if (shape === 'prose') {
    console.log(`gate: ${evaluate({ issue: target }).note}`);
    process.exit(0);
  }
  handleIssue(target.replace(STRIP_HASH, ''));
}

// Run only as a script; importing for tests must not execute the gate.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main();
}
