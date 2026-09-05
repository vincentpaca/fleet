// #36 acceptance: a WINDOW-CLI order, run against a PRE-WINDOW repo gate.
//
// Operator repos carry their own copy of the pickup gate. When Fleet's CLI
// updates and a repo's gate does not, the orders the new CLI writes meet a
// script that still keys on `mode` and reads a missing one as `implement`
// (strict). Nothing else in this suite covers that pairing: `test/gate.test.ts`
// runs the new gate, `test/cli-delegate.test.ts` runs the new CLI, and the whole
// compat-`mode` field exists for the seam between them.
//
// `fixtures/gate-pre-window.mjs` is `.fleet/gate.mjs` as of a253646 — the last
// commit before this change — with a fixture header prepended and nothing else
// altered; the last test here pins the rest of the file by sha256. It lives
// under fixtures/ because it is executable and `node --test` collects
// everything under test/.
//
// Orders here are built by the real CLI, not by hand: an assertion about what
// the window release writes is worthless if this file writes it itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dispatchShape } from '../src/cli/dispatch.ts';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { runCli, makeTempDir, startMockDaemon, sendJson, type MockRequest } from './cli-helpers.ts';

/** An identity dispatch says which work, never what to do about it (#240). */
const DEV_PROMPT = '/dev';

const oldGate = fileURLToPath(new URL('../fixtures/gate-pre-window.mjs', import.meta.url));
const preWindowSchemaPath = fileURLToPath(new URL('../fixtures/work-order-pre-window.schema.json', import.meta.url));

/**
 * Every work order this file's dispatches posted. Node runs the tests in one
 * file sequentially, so by the time the last test reads this the dispatches
 * above have all happened — which is what lets the pre-window-schema test
 * assert against the real thing rather than a hand-written imitation. The
 * dispatch's argv rides along: since #240 what an order may legally contain
 * depends on what the operator asked for, and the args are the only record of
 * that.
 */
const ORDERS_SEEN: { args: string[]; order: Record<string, unknown> }[] = [];

const MANIFEST = {
  version: 1,
  setup: { image: 'node:22' },
  workspace: { repo: 'git@github.com:acme/example-app.git', strategy: 'branch-per-job' },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'node .fleet/gate.mjs' },
};

/** A checkout the CLI can dispatch from. */
function scaffold(): string {
  const cwd = makeTempDir('fleet-window-compat-');
  fs.mkdirSync(path.join(cwd, '.fleet'));
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), JSON.stringify(MANIFEST));
  return cwd;
}

/**
 * A `gh` that answers a ready issue (open, labelled, with an Acceptance section)
 * and an open PR. `cat <<'EOF'` rather than `echo`: the issue body carries JSON
 * `\n` escapes, and sh's echo turns some of those into real newlines, which
 * makes the JSON unparseable — and reads as the gate failing, not the fake.
 */
const READY_GH = `#!/bin/sh
case "$1" in
  pr) cat <<'EOF'
{"number":41,"state":"OPEN","headRefName":"fleet/9-job-old","title":"Fix it","closingIssuesReferences":[{"number":9}]}
EOF
  ;;
  *) cat <<'EOF'
{"state":"OPEN","labels":[{"name":"ready"}],"body":"## Problem\\nx\\n\\n## Acceptance\\n- works\\n","title":"Ready issue"}
EOF
  ;;
esac
`;

/** A `gh` whose issue is open but carries neither the label nor an Acceptance section. */
const UNREADY_GH = `#!/bin/sh
cat <<'EOF'
{"state":"OPEN","labels":[],"body":"just prose","title":"Not ready"}
EOF
`;

/**
 * Two bin dirs from one `gh` script. Both gates shell out to the real tools, and
 * faking them is what makes these assertions about the gate's logic rather than
 * about this machine's network — but the fakes cannot be the same set: the CLI
 * needs the REAL git (identity, remote URL) while the gate's claim-guard
 * `git ls-remote origin` has no repo to run against in a staged workspace.
 */
function fakeBins(gh: string): { cli: string; gate: string } {
  const cli = makeTempDir('fleet-compat-cli-bin-');
  fs.writeFileSync(path.join(cli, 'gh'), gh, { mode: 0o755 });
  const gate = makeTempDir('fleet-compat-gate-bin-');
  fs.writeFileSync(path.join(gate, 'gh'), gh, { mode: 0o755 });
  // No rival fleet/<n>-* branches on origin: empty stdout, exit 0.
  fs.writeFileSync(path.join(gate, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { cli, gate };
}

/**
 * Dispatch through the real CLI and hand the resulting order to the pre-window
 * gate, in a workspace of its own. Returns the gate's exit status and output.
 */
async function windowOrderAgainstOldGate(
  args: string[],
  bins: { cli: string; gate: string },
): Promise<{ order: Record<string, unknown>; status: number | null; out: string }> {
  const cwd = scaffold();
  const daemon = await startMockDaemon({
    'POST /jobs': (_req: MockRequest, res: ServerResponse) => sendJson(res, 201, { job: { id: 'job-1', state: 'queued' } }),
  });
  let order: Record<string, unknown>;
  try {
    const res = await runCli(['delegate', ...args], {
      cwd,
      env: { FLEET_DAEMON_URL: daemon.url, PATH: `${bins.cli}:${process.env.PATH}` },
    });
    assert.equal(res.code, 0, res.stderr);
    order = JSON.parse(daemon.requests[0].body).workOrder;
    ORDERS_SEEN.push({ args, order });
  } finally {
    await daemon.close();
  }

  // Stage the order the way the runner does, then run the OLD gate over it.
  const gateCwd = makeTempDir('fleet-old-gate-');
  fs.mkdirSync(path.join(gateCwd, '.fleet'));
  fs.writeFileSync(path.join(gateCwd, '.fleet', 'order.json'), JSON.stringify(order));
  // Strip inherited FLEET_* — this test process may itself be a fleet job, and
  // an inherited target or mode would decide the assertion instead of the order.
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bins.gate}:${process.env.PATH}` };
  for (const key of Object.keys(env)) if (key.startsWith('FLEET_')) delete env[key];
  const run = spawnSync(process.execPath, [oldGate], { cwd: gateCwd, encoding: 'utf8', env });
  return { order, status: run.status, out: `${run.stdout}${run.stderr}` };
}

test('window CLI → old gate: an issue dispatch gates exactly as it did', async () => {
  const { order, status, out } = await windowOrderAgainstOldGate(['42', '--prompt', DEV_PROMPT], fakeBins(READY_GH));
  assert.equal(order.mode, 'implement', 'the compat mode is what the old gate keys on');
  assert.equal(status, 0, out);
  assert.match(out, /issue 42 is ready/);
});

test('window CLI → old gate: an unready issue still dies', async () => {
  // Same fake gh, minus the label. The compat field must not have bought a
  // relaxation: an issue dispatch pays the full check on both gates.
  const { status, out } = await windowOrderAgainstOldGate(['42', '--prompt', DEV_PROMPT], fakeBins(UNREADY_GH));
  assert.equal(status, 1, out);
  assert.match(out, /lacks the "ready" label/);
});

test('window CLI → old gate: an adoption gates exactly as it did', async () => {
  const { order, status, out } = await windowOrderAgainstOldGate(['pr/41', '--prompt', DEV_PROMPT], fakeBins(READY_GH));
  assert.equal(order.mode, 'followthrough', 'the old gate only checks a PR when the mode says followthrough');
  assert.deepEqual(order.continues, { pr: 41, branch: 'fleet/9-job-old' });
  assert.equal(order.target, '9', 'target rewritten to the linked issue, as before');
  assert.equal(status, 0, out);
  assert.match(out, /PR #41 is open on fleet\/9-job-old/);
});

test('window CLI → old gate: a bare prose dispatch now passes report-only', async () => {
  // The intended behavior change, riding the compat field. Before #36 this
  // order carried mode=implement and the old gate killed it for not naming an
  // issue — which is exactly what made prose un-dispatchable.
  const { order, status, out } = await windowOrderAgainstOldGate(['why do queued jobs sit behind the cap'], fakeBins(READY_GH));
  assert.equal(order.mode, 'investigate');
  assert.equal(status, 0, out);
  assert.match(out, /investigate mode is report-only/);
});

test('window CLI → old gate: --mode assess on an issue still gates strict (D17)', async () => {
  // The recorded inversion, verified on the gate an operator actually has: the
  // mapped flag moves the dispatch's own defaults and nothing else, so the
  // compat mode stays `implement` and the readiness check is still paid. An
  // unready issue must die here whatever the operator asked for.
  const { order, status, out } = await windowOrderAgainstOldGate(['--mode', 'assess', '42', '--prompt', DEV_PROMPT], fakeBins(UNREADY_GH));
  assert.equal(order.mode, 'implement', 'a read-only --mode must not soften the compat mode');
  assert.equal((order.authority as { publish: boolean }).publish, false, 'it does move the dispatch defaults');
  assert.equal(status, 1, out);
  assert.match(out, /lacks the "ready" label/);
});

test('window CLI → old gate: an operator prompt on an issue still gates strict (#240)', async () => {
  // The invariant #240 could most easily have broken, checked on the gate an
  // operator actually has rather than on this repo's regenerated one: the
  // prompt says what the agent does, never what the dispatch is, so "/dev-work
  // #42" against an unready issue must still die at pickup. A CLI that read the
  // prompt as the job — or
  // that let a prompt-carrying order fall through to the prose row — would pass
  // this issue through with no readiness check and no `Closes #n`.
  const { order, status, out } = await windowOrderAgainstOldGate(
    ['42', '--prompt', '/dev-work #42'],
    fakeBins(UNREADY_GH),
  );
  assert.equal(order.prompt, '/dev-work #42', 'carried verbatim');
  assert.equal(order.mode, 'implement', 'the old gate keys on this, and the prompt must not have moved it');
  assert.equal(status, 1, out);
  assert.match(out, /lacks the "ready" label/);
});

test('window CLI → old gate: publish-true prose passes report-only and then publishes (D17 risk 1)', async () => {
  // The compat mapping's other asymmetry, pinned so it is deliberate rather
  // than discovered: shape decides the compat mode, so a publish-true prose
  // dispatch ships as `investigate` and an un-regenerated gate waves it
  // through as report-only — then the job pushes and opens a draft PR, because
  // authority.publish is what the runner reads. Pre-#36 no order could be in
  // this state: publish implied implement/followthrough, which demanded an
  // issue number. There is no better mapping (labelling it `implement` would
  // have the old gate kill it for having no issue number), so D17 records it as
  // an accepted risk and this is the checkpoint. Since #208 removed --publish,
  // the deprecated `--mode implement` is the one prose route left into this
  // state, and the risk dies with that flag in the follow-up release.
  const { order, status, out } = await windowOrderAgainstOldGate(
    ['--mode', 'implement', 'draft the retry-policy note and open a PR'],
    fakeBins(READY_GH),
  );
  assert.equal(order.mode, 'investigate');
  assert.equal((order.authority as { publish: boolean }).publish, true, 'the authority the runner reads');
  assert.equal(status, 0, out);
  assert.match(out, /investigate mode is report-only/);
});

test('both pre-window fixtures are byte-identical to the originals', () => {
  // If someone "modernizes" a fixture, every assertion here quietly starts
  // proving that the new gate works with the new CLI — which is true and
  // worthless, because no operator's repo is running the new gate yet. A
  // keyword grep would not catch that: the mode plumbing can survive intact
  // while the readiness check, the claim guard or an exit code drifts. So the
  // pin is the whole file, and it covers the schema too — the conclusions drawn
  // from that one (which legacy fields the window CLI may stop writing) are
  // worth nothing if it was transcribed rather than copied.
  //
  // Both constants are reproducible by hand:
  //   git show a253646:.fleet/gate.mjs                | sha256sum
  //   git show a253646:schemas/work-order.schema.json | sha256sum
  const GATE_SHA256 = '13948ece9310eb303cf6ba89766613d9cc629e6f21a4418fd390af227b17ce42';
  const SCHEMA_SHA256 = 'db7dfded9940b6363dca3652c3d899a2058a6600daa55d6fc28827be3d112587';

  // The gate fixture carries a header block after the shebang; everything from
  // the original's first comment line on must hash to the original.
  const text = fs.readFileSync(oldGate, 'utf8');
  const start = text.indexOf('// Pickup gate for this repo:');
  assert.notEqual(start, -1, 'the fixture must keep the original gate header line as its anchor');
  assert.equal(
    createHash('sha256').update(`#!/usr/bin/env node\n${text.slice(start)}`).digest('hex'),
    GATE_SHA256,
    'the frozen gate has been edited — revert it, or land the new hash with a reason',
  );
  // The schema fixture carries no header (JSON has no comments), so it is an
  // unmodified byte copy.
  assert.equal(
    createHash('sha256').update(fs.readFileSync(preWindowSchemaPath)).digest('hex'),
    SCHEMA_SHA256,
    'the frozen pre-window schema has been edited — revert it, or land the new hash with a reason',
  );
});

test('no order the CLI writes crosses a pre-window daemon any more (#240)', () => {
  // This used to assert the opposite, and the inversion is the honest cost of
  // #240. Every dispatch now carries `prompt` — an identity dispatch because
  // the operator must say what to run, a prose one because the target IS the
  // instruction — and the frozen pre-window work order is
  // additionalProperties:false. A daemon validates with the schema baked into
  // its own image, so a deployment older than #240 refuses every job this CLI
  // sends. `fleet upgrade` is not optional across this release.
  //
  // Kept as a test rather than deleted because the refusal must stay a 422 on
  // an unknown FIELD. If it ever became a refusal on a value, or the schema
  // stopped being closed, orders would be silently accepted and half-honoured
  // by a daemon that cannot run them.
  const raw = JSON.parse(fs.readFileSync(preWindowSchemaPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw.required, ['mode', 'target', 'finish'], 'the licence for not writing the other legacy fields');
  delete raw.$id;
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const validate = ajv.compile(raw);

  assert.ok(ORDERS_SEEN.length > 0, 'no dispatch was recorded — the pin has nothing to compare');
  for (const seen of ORDERS_SEEN) {
    const { title: _title, ...rest } = seen.order;
    assert.ok('prompt' in rest, `an order went out with no instruction in it: ${seen.args.join(' ')}`);
    assert.equal(validate(rest), false, `a prompted order passed the pre-window schema: ${seen.args.join(' ')}`);
    assert.ok(
      validate.errors?.some((e) => e.params?.additionalProperty === 'prompt'),
      `the refusal must be about prompt, not something else: ${JSON.stringify(validate.errors)}`,
    );
    // Strip the one new field and the rest must still be exactly what the
    // previous release posted — the blast radius is one field, not a rewrite.
    const { prompt: _p, ...legacy } = rest;
    assert.ok(validate(legacy), `beyond prompt, the order drifted: ${JSON.stringify(validate.errors)}`);
  }
});
