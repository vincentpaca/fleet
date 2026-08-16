#!/usr/bin/env node
// Pickup gate for this repo: is GitHub issue <n> actually ready to implement?
// Runs before any model spend. Exit 0 = ready, 1 = not ready, 2 = cannot
// evaluate (missing target, no gh, no network) — the runner treats any
// nonzero exit as an abort, with this script's output as the evidence.
//
// Target resolution order: argv[1], $FLEET_TARGET, .fleet/order.json target.
// Checks: issue exists and is open; has the "ready" label; body carries an
// "## Acceptance" section; no branch fleet/<n>-* already exists on origin.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Pure readiness decision — fixture-testable, no network.
 * The job's OWN branch never counts as a claim: the runner pushes
 * fleet/<issue>-<jobId> at creation BEFORE the gate runs, and a parked job
 * re-enters onto its existing branch — neither may trip the collision guard.
 * @param {{ state?: string, labels: string[], body: string, branches: string[], issue: string, jobId?: string }} facts
 * @returns {{ ready: boolean, findings: string[] }}
 */
export function evaluate({ state, labels, body, branches, issue, jobId }) {
  const findings = [];
  if (state !== undefined && state.toUpperCase() !== 'OPEN') {
    findings.push(`issue ${issue} is ${state}, not open`);
  }
  if (!labels.includes('ready')) {
    findings.push(`issue ${issue} lacks the "ready" label`);
  }
  if (!/^##\s+Acceptance\b/m.test(body)) {
    findings.push(`issue ${issue} body has no "## Acceptance" section`);
  }
  const prefix = `fleet/${issue}-`;
  const own = jobId ? `${prefix}${jobId}` : undefined;
  const taken = branches.filter((b) => b.startsWith(prefix) && b !== own);
  if (taken.length > 0) {
    findings.push(`branch already claims this issue: ${taken.join(', ')}`);
  }
  return { ready: findings.length === 0, findings };
}

function resolveTarget() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.FLEET_TARGET) return process.env.FLEET_TARGET;
  if (existsSync('.fleet/order.json')) {
    const order = JSON.parse(readFileSync('.fleet/order.json', 'utf8'));
    if (typeof order.target === 'string') return order.target;
  }
  return undefined;
}

function main() {
  const target = resolveTarget();
  if (!target) {
    console.error('gate: no target (argv, $FLEET_TARGET, or .fleet/order.json)');
    process.exit(2);
  }
  const issue = target.replace(/^#/, '');
  if (!/^\d+$/.test(issue)) {
    console.error(`gate: target "${target}" is not an issue number`);
    process.exit(2);
  }

  let facts;
  try {
    const view = JSON.parse(
      execFileSync('gh', ['issue', 'view', issue, '--json', 'state,labels,body'], { encoding: 'utf8' }),
    );
    // Query the remote directly rather than trusting local refs — the gate
    // owns its own freshness (evaluate against live state, never a stale copy).
    const lsRemote = execFileSync('git', ['ls-remote', '--heads', 'origin', `fleet/${issue}-*`], {
      encoding: 'utf8',
    });
    facts = {
      issue,
      jobId: process.env.FLEET_JOB_ID,
      state: view.state,
      labels: view.labels.map((l) => l.name),
      body: view.body ?? '',
      branches: lsRemote
        .split('\n')
        .map((line) => line.split('\t')[1] ?? '')
        .filter(Boolean)
        .map((ref) => ref.replace('refs/heads/', '')),
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
