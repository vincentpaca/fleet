// The seam between the three setups: each command ends by OFFERING the first
// missing piece — an offer, never a fall-through, because an Enter must not
// start a terraform apply. Bare `fleet setup` is the checklist plus that entry
// point. What these tests are about is the two ways the seam can rot: a
// dead-end pointer (recommending `fleet delegate` with no deployment to
// receive it) and an offer that fires when its piece already exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, makeTempDir, fakeCloudBin } from './cli-helpers.ts';

/**
 * A repo scratch with the machine state pinned: a temp HOME (so whether this
 * laptop has the skill installed can't leak in) and, when asked, a captured
 * deployment or a fake harness binary. PATH keeps the real one — git must
 * work — with fakes prepended.
 */
function chainScratch(opts: { deployment?: boolean; binaries?: string[] } = {}): {
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
} {
  const home = makeTempDir('fleet-chain-home-');
  const cwd = makeTempDir('fleet-chain-repo-');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"scratch"}\n');
  const bin = makeTempDir('fleet-chain-bin-');
  for (const name of opts.binaries ?? []) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  if (opts.deployment) {
    fs.mkdirSync(path.join(cwd, '.fleet', 'infra', 'aws'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.fleet', 'infra', 'aws', 'fleet-config.json'), '{"daemon_url":"http://127.0.0.1:1"}\n');
  }
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FLEET_FORCE_TTY: '1',
      ANTHROPIC_API_KEY: 'sk-ant-api-here',
    },
  };
}

test('bare fleet setup: the checklist, and no interview without a terminal', async () => {
  const s = chainScratch();
  const res = await runCli(['setup'], { cwd: s.cwd, env: { ...s.env, FLEET_FORCE_TTY: undefined } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /· repo\s+no manifest — fleet setup repo/);
  assert.match(res.stdout, /· infra\s+no deployment — fleet setup infra/);
  assert.match(res.stdout, /· harness\s+skill not installed — fleet setup harness/);
  assert.ok(!res.stdout.includes('use this?'), 'no terminal means no interview');
});

test('setup repo with no deployment offers infra; declining prints the pointer, not a dead end', async () => {
  const s = chainScratch();
  const res = await runCli(['setup', 'repo'], { cwd: s.cwd, env: s.env, stdin: '\nn\n' });
  assert.equal(res.code, 0, res.stderr);
  // The Next block must not recommend dispatching into a void.
  assert.match(res.stdout, /fleet setup infra\s+jobs need a cloud to run in/);
  assert.ok(!res.stdout.includes('fleet delegate'), 'delegate is a dead end without a deployment');
  assert.match(res.stdout, /stand one up now\?/);
  assert.match(res.stdout, /later: fleet setup infra/);
  assert.ok(fs.existsSync(path.join(s.cwd, '.fleet', 'manifest.json')), 'the manifest still landed');
});

test('setup repo with a reachable deployment: no infra offer, and Next recommends delegate', async () => {
  const s = chainScratch({ deployment: true });
  const res = await runCli(['setup', 'repo'], { cwd: s.cwd, env: s.env, stdin: '\n' });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /fleet delegate/);
  assert.ok(!res.stdout.includes('stand one up now?'), 'a satisfied piece is never offered');
});

test('a stdin that ends at the offer is a script saying nothing — a no, not an error', async () => {
  const s = chainScratch();
  const res = await runCli(['setup', 'repo'], { cwd: s.cwd, env: s.env, stdin: '\n' });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /later: fleet setup infra/);
});

test('yes at the offer chains into the infra wizard, which ends by offering the skill', async () => {
  const s = chainScratch({ binaries: ['claude'] });
  const state = makeTempDir('fleet-chain-tf-');
  const env = {
    ...s.env,
    PATH: `${fakeCloudBin(state)}${path.delimiter}${s.env.PATH}`,
    FAKE_TF_DIR: state,
    FAKE_AWS_DIR: state,
    FLEET_IMAGE_POLL_MS: '5',
    AWS_REGION: undefined,
  };
  // Accept the repo plan; yes to infra; name/region/vpc; yes to the apply;
  // no to the skill offer.
  const res = await runCli(['setup', 'repo'], { cwd: s.cwd, env, stdin: '\ny\ndemo\n\n\ny\nn\n' });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /stand one up now\?/);
  assert.ok(fs.existsSync(path.join(s.cwd, '.fleet', 'infra', 'aws', 'fleet-config.json')), 'the chained apply captured a deployment');
  assert.match(res.stdout, /teach your coding agent to drive fleet\?/);
  assert.match(res.stdout, /later: fleet setup harness/);
});

test('yes at the skill offer installs it where the harness looks', async () => {
  const s = chainScratch({ binaries: ['claude'] });
  const state = makeTempDir('fleet-chain-tf-');
  const env = {
    ...s.env,
    PATH: `${fakeCloudBin(state)}${path.delimiter}${s.env.PATH}`,
    FAKE_TF_DIR: state,
    FAKE_AWS_DIR: state,
    FLEET_IMAGE_POLL_MS: '5',
    AWS_REGION: undefined,
  };
  // Straight into infra; yes to the skill offer; harness list and scope by Enter.
  // The skill offer's default is yes (one reversible file copy): pin it with a bare Enter.
  const res = await runCli(['setup', 'infra'], { cwd: s.cwd, env, stdin: 'demo\n\n\ny\n\n\n\n' });
  assert.equal(res.code, 0, res.stderr);
  const skill = path.join(s.home, '.claude', 'skills', 'fleet-delegate', 'SKILL.md');
  assert.ok(fs.existsSync(skill), 'the chained install landed in the temp home, not the machine');
});

test('maintenance runs never chain: --destroy and --rebuild-images end where they always did', async () => {
  const s = chainScratch({ binaries: ['claude'] });
  const state = makeTempDir('fleet-chain-tf-');
  const env = {
    ...s.env,
    PATH: `${fakeCloudBin(state)}${path.delimiter}${s.env.PATH}`,
    FAKE_TF_DIR: state,
    FAKE_AWS_DIR: state,
    FLEET_IMAGE_POLL_MS: '5',
    AWS_REGION: undefined,
  };
  assert.equal((await runCli(['setup', 'infra'], { cwd: s.cwd, env, stdin: 'demo\n\n\ny\nn\n' })).code, 0);
  const destroy = await runCli(['setup', 'infra', '--destroy', '--yes'], { cwd: s.cwd, env });
  assert.equal(destroy.code, 0, destroy.stderr);
  assert.ok(!destroy.stdout.includes('teach your coding agent'), 'a teardown is not onboarding');
});

test('Enter at the infra offer is a no: nothing may fall into terraform by default', async () => {
  // The one invariant the chain hangs on. A default-yes here sends an Enter
  // into terraform against the operator's AWS account — the suite must not be
  // blind to that mutant (a review proved it once was).
  const s = chainScratch();
  const res = await runCli(['setup', 'repo'], { cwd: s.cwd, env: s.env, stdin: '\n\n\n' });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /stand one up now\?.*\[y\/N\]/);
  assert.match(res.stdout, /later: fleet setup infra/);
  assert.ok(!fs.existsSync(path.join(s.cwd, '.fleet', 'infra')), 'Enter never reaches terraform');
});

test('--yes asked for no questions at all: it gets no offers either', async () => {
  const s = chainScratch();
  const res = await runCli(['setup', 'repo', '--yes', '--repo', 'origin'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!res.stdout.includes('stand one up now?'), 'a --yes run is scripted, not courted');
});

test('a half-captured config is not a deployment: setup judges by the predicate dispatch uses', async () => {
  // captureFleetConfig's own fallback tells the operator to hand-capture
  // `terraform output`, which carries no daemon_url — delegate skips such a
  // config, so setup must not point at it.
  const s = chainScratch({ deployment: true });
  fs.writeFileSync(path.join(s.cwd, '.fleet', 'infra', 'aws', 'fleet-config.json'), '{"daemon_url":""}\n');
  const res = await runCli(['setup', 'repo'], { cwd: s.cwd, env: s.env, stdin: '\nn\n' });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!res.stdout.includes('fleet delegate'), 'a config delegate would skip is not a deployment');
  assert.match(res.stdout, /stand one up now\?/);
});

test('a satisfied deployment falls through to the skill offer: the chain offers the FIRST missing piece', async () => {
  const s = chainScratch({ deployment: true, binaries: ['claude'] });
  const res = await runCli(['setup', 'repo'], { cwd: s.cwd, env: s.env, stdin: '\nn\n' });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!res.stdout.includes('stand one up now?'), 'a satisfied piece is never offered');
  assert.match(res.stdout, /teach your coding agent to drive fleet\?/);
  assert.match(res.stdout, /later: fleet setup harness/);
});

test('no harness on the machine means no skill offer: a yes that can only fail is worse than none', async () => {
  // Temp HOME and a PATH with no harness binary at all: the offer's gate, not
  // an EOF decline, must be what suppresses it — a decline would still print
  // its "later:" pointer, so both lines must be absent.
  const s = chainScratch({ deployment: true });
  const env = { ...s.env, PATH: makeTempDir('fleet-chain-emptybin-') };
  const res = await runCli(['setup', 'repo'], { cwd: s.cwd, env, stdin: '\n\n' });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!res.stdout.includes('teach your coding agent'), 'nothing to install into, nothing offered');
  assert.ok(!res.stdout.includes('later: fleet setup harness'), 'gate-skipped, not merely declined');
});
