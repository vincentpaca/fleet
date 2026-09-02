// The whole operator journey against real cloud: stand the infrastructure up,
// delegate a job to it, tear it down (#224 follow-on).
//
// Every other end-to-end test in this suite stops at the daemon: the Docker
// ones prove a job runs in a container, and the ProcessProvider ones prove the
// lifecycle without a container at all. Nothing covers the commands an
// operator actually types first and last — and that is exactly where this
// repo's incidents have come from (#9 four applies to find a plan-invalid
// value, #131 a 2.3GB checkout, #207 a deployment silently behind its CLI,
// #216 registries blocking their own teardown, #218 an image whose containers
// died on arrival). Those all live above the daemon, so no daemon-level test
// could have caught any of them.
//
// This spends real money and takes tens of minutes, so it is not a gate — it
// is a drill with an assertion harness around it, and it is gated twice:
//
//   FLEET_E2E_CLOUD=1 \
//   FLEET_QA_REPO=https://github.com/<owner>/<repo>.git \
//   FLEET_E2E_MODULE_SOURCE='git::https://github.com/<owner>/fleet.git//infra/aws?ref=<sha>' \
//   node --test test/e2e-cloud-lifecycle.test.ts
//
// FLEET_E2E_CLOUD is deliberately separate from having AWS credentials: every
// developer running the suite has credentials, and none of them should discover
// this file by accident.
//
// TEARDOWN IS THE POINT. A failed run that leaves an ECS cluster billing is
// worse than no test, so the destroy is registered before the apply is even
// attempted, runs regardless of what failed, and — if it also fails — the
// recovery command is written to a file and printed. Read that file before
// assuming a run cleaned up after itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCredentialEnv } from '../src/runner/git.ts';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');

/** The dispatch target: a single prose token, so no issue readiness applies. */
const TARGET = 'qa-probe';
const NEXT_ACTION = 'qa probe complete';

/**
 * Deliberately generous, and each bound is the slowest real observation plus
 * headroom rather than a round number: an apply that stands up a VPC, an ECS
 * cluster and an in-account image build is tens of minutes, and a bound that
 * trips on a healthy run is worse than none — it aborts mid-apply and leaves
 * half a deployment for the teardown to reconcile.
 */
const APPLY_MS = 45 * 60_000;
const DESTROY_MS = 30 * 60_000;
const JOB_MS = 20 * 60_000;

/** Where a failed teardown leaves its recovery note. Printed, not just written. */
const RESCUE_FILE = join(tmpdir(), 'fleet-e2e-cloud-rescue.txt');

function requireEnv(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} must be set for the cloud lifecycle drill`);
  return value;
}

/**
 * A deployment name no other run and no operator deployment can collide with.
 * Time-based rather than random so a leaked deployment can be dated from its
 * name alone when someone finds it in the console next week.
 */
function deploymentName(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(2, 12);
  return `fleet-e2e-${stamp}`;
}

function fleet(project: string, args: string[], timeoutMs: number): { code: number; out: string } {
  const res = spawnSync('node', [cli, ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...gitCredentialEnv(process.env) },
  });
  return { code: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * Tear the deployment down, and make a failure impossible to miss. `--destroy`
 * only removes what the terraform state in this directory owns
 * (src/cli/setup.ts:884), so it can never reach an operator's real deployment
 * even when the name matches.
 */
function destroy(project: string, name: string): void {
  const { code, out } = fleet(project, ['setup', 'infra', '--destroy', '--yes', '--provider', 'aws'], DESTROY_MS);
  if (code === 0) return;
  const rescue = [
    `fleet e2e cloud drill: TEARDOWN FAILED for deployment ${name}`,
    `state directory: ${project}`,
    'this deployment is still billing. Recover with:',
    `  cd ${project} && node ${cli} setup infra --destroy --yes --provider aws`,
    'if that directory is gone, destroy from the AWS console by the deployment name above.',
    '',
    out.slice(-4000),
  ].join('\n');
  writeFileSync(RESCUE_FILE, rescue);
  console.error(rescue);
}

/** The event log for a job, straight off the daemon the tunnel is fronting. */
async function jobEvents(jobId: string): Promise<Array<Record<string, unknown>>> {
  const { out } = fleet(process.cwd(), ['logs', jobId, '--full'], 60_000);
  return out
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('a deployment stands up, runs a real job for a foreign repo, and tears down', { timeout: APPLY_MS + JOB_MS + DESTROY_MS }, async (t) => {
  // Two gates, deliberately. Credentials alone must never be enough.
  if (process.env.FLEET_E2E_CLOUD !== '1') return t.skip('FLEET_E2E_CLOUD=1 not set (this drill applies real infrastructure and costs money)');
  if (!process.env.FLEET_QA_REPO) return t.skip('FLEET_QA_REPO not set');
  const moduleSource = process.env.FLEET_E2E_MODULE_SOURCE;
  if (!moduleSource) {
    // A local module path provisions no in-account build (src/cli/setup.ts
    // pinnedSource), so the deployment would come up with an empty ECR and
    // every job would fail pulling its image. The drill needs a clonable,
    // pinned source — which also means the commit under test must be pushed.
    return t.skip('FLEET_E2E_MODULE_SOURCE not set (needs a clonable git:: source so the in-account image build exists)');
  }
  const qaRepo = requireEnv('FLEET_QA_REPO');
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-southeast-1';
  const name = deploymentName();

  // One directory holds both halves: the QA repo's manifest (what to run) and
  // the generated .fleet/infra (where to run it). The CLI resolves both from
  // its cwd, so they have to be the same cwd.
  const project = mkdtempSync(join(tmpdir(), 'fleet-e2e-cloud-'));
  execFileSync('git', ['clone', '--quiet', qaRepo, project], {
    env: { ...process.env, ...gitCredentialEnv(process.env) },
  });

  // Registered BEFORE the apply: a run that dies during apply still has
  // whatever terraform managed to create, and that is exactly the run whose
  // teardown matters most.
  t.after(() => destroy(project, name));

  const applied = fleet(project, [
    'setup', 'infra', '--yes',
    '--provider', 'aws',
    '--name', name,
    '--region', region,
    '--module-source', moduleSource,
  ], APPLY_MS);
  assert.equal(applied.code, 0, `setup infra failed:\n${applied.out.slice(-3000)}`);

  const captured = join(project, '.fleet', 'infra', 'aws', 'fleet-config.json');
  assert.ok(existsSync(captured), 'apply succeeded but captured no fleet-config.json');
  const config = JSON.parse(readFileSync(captured, 'utf8')) as Record<string, unknown>;
  assert.equal(config.provider, 'ecs');
  assert.ok(config.runner_repository_url, 'no runner repository in the captured config');

  // The daemon lives in the VPC with no inbound from outside it (D1), so the
  // CLI reaches it through a port-forward. Detached: the supervision loop
  // outlives this call and holds the port for the dispatch below.
  const connected = fleet(project, ['connect', '--detach'], 5 * 60_000);
  assert.equal(connected.code, 0, `fleet connect --detach failed:\n${connected.out.slice(-2000)}`);
  t.after(() => { spawnSync('pkill', ['-f', 'fleet connect'], { encoding: 'utf8' }); });

  const doctored = fleet(project, ['doctor'], 5 * 60_000);
  assert.equal(doctored.code, 0, `doctor is unhappy with the fresh deployment:\n${doctored.out}`);

  const delegated = fleet(project, ['delegate', TARGET], 10 * 60_000);
  assert.equal(delegated.code, 0, `delegate failed:\n${delegated.out}`);
  const jobId = delegated.out.trim().split(/\s+/).find((word) => word.startsWith('job-'));
  assert.ok(jobId, `no job id in delegate output: ${delegated.out}`);

  const deadline = Date.now() + JOB_MS;
  let state = 'queued';
  while (Date.now() < deadline) {
    const status = fleet(project, ['status', jobId], 60_000);
    const found = /\b(queued|running|blocked|done|cancelled)\b/.exec(status.out);
    state = found?.[1] ?? state;
    if (state === 'done' || state === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  const events = await jobEvents(jobId);
  const settle = events.find((e) => e.type === 'settle');
  assert.equal(state, 'done', `job did not settle clean (state ${state}); settle: ${JSON.stringify(settle)}`);

  const report = (settle?.report ?? {}) as { next_action?: string };
  assert.equal(report.next_action, NEXT_ACTION, `settle did not carry the repo's own report: ${JSON.stringify(settle)}`);

  // The teardown is not just cleanup here — it is the last third of the
  // journey under test, and #216 exists because it used to fail. Running it
  // inside the test (as well as in t.after, which is then a no-op) is what
  // makes a broken destroy a red test rather than a silent leak.
  const torn = fleet(project, ['setup', 'infra', '--destroy', '--yes', '--provider', 'aws'], DESTROY_MS);
  assert.equal(torn.code, 0, `teardown failed — the deployment is still billing:\n${torn.out.slice(-3000)}`);
});
