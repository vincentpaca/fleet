// `fleet setup infra` / `fleet setup repo` (#13): the CLI owns standing Fleet
// up. terraform and aws are faked (fixtures/fake-terraform.mjs,
// fixtures/fake-aws.mjs) — what these tests are about is the CLI's own job:
// asking only what the contract cannot assume, merging flags over prompts,
// generating a root module, running the right steps in the right directory, and
// capturing the deployment description. The one live path (a real apply into a
// real account) is #9's drill, and is documented as such, not simulated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../src/validate.mjs';
import { runCli, makeTempDir, fakeCloudBin, startMockDaemon, sendJson } from './cli-helpers.ts';
import {
  interview,
  renderMainTf,
  resolveModuleSource,
  pinnedSource,
  repoManifest,
  runSetupRepo,
  terraformTooOld,
  MIN_TERRAFORM,
  SetupError,
} from '../src/cli/setup.ts';
import { SETUP_UNITS, unitFor } from '../src/cli/setup-units.ts';
import { repinnedMainTf } from '../src/cli/upgrade.ts';

const AWS = unitFor('aws')!;

/** A scratch project plus a PATH carrying the fake terraform and aws. */
function scratch(extraEnv: Record<string, string | undefined> = {}): {
  cwd: string;
  env: Record<string, string | undefined>;
  state: string;
  calls: () => string[];
  buildCalls: () => string[];
} {
  const cwd = makeTempDir('fleet-setup-');
  const state = makeTempDir('fleet-fake-tf-state-');
  const bin = fakeCloudBin(state);
  return {
    cwd,
    state,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_TF_DIR: state,
      FAKE_AWS_DIR: state,
      // The image-build wait polls the fake cloud CLI; real-cadence polling
      // would spend five wall seconds per fake phase.
      FLEET_IMAGE_POLL_MS: '5',
      // The region prompt defaults to the shell's — scrubbed so these tests
      // assert the wizard's behaviour, not the machine they run on.
      AWS_REGION: undefined,
      AWS_DEFAULT_REGION: undefined,
      // The generated module source must not depend on this checkout's remote.
      FLEET_MODULE_SOURCE: 'git::https://git.invalid/fleet.git//infra/aws?ref=v9',
      ...extraEnv,
    },
    calls: () => {
      const log = path.join(state, 'calls.log');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    },
    buildCalls: () => {
      const log = path.join(state, 'codebuild.log');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    },
  };
}

/** The terraform subcommands that ran, in order. */
function subcommands(calls: string[]): string[] {
  return calls.map((line) => line.split('\t')[1].split(' ').find((a) => !a.startsWith('-')) ?? '');
}

const infraDir = (cwd: string): string => path.join(cwd, '.fleet', 'infra', 'aws');

// ---------- the wizard ----------

test('setup infra on a terminal: prompts only, then applies on an explicit yes', async () => {
  const s = scratch();
  // name, Enter (region default), Enter (no existing VPC), y (apply).
  const res = await runCli(['setup', 'infra'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'demo\n\n\ny\n',
  });
  assert.equal(res.code, 0, res.stderr);

  const mainTf = fs.readFileSync(path.join(infraDir(s.cwd), 'main.tf'), 'utf8');
  assert.match(mainTf, /name\s*=\s*"demo"/, 'the name answer reaches var.name — it tags every resource');
  assert.match(mainTf, /region\s*=\s*"us-east-1"/, 'Enter accepted the region default');
  assert.match(mainTf, /source\s*=\s*"git::https:\/\/git\.invalid\/fleet\.git\/\/infra\/aws\?ref=v9"/);
  assert.doesNotMatch(mainTf, /vpc_id/, 'no existing VPC answered means the module creates one');
  // Source-ref threading (#189): the in-account image build clones exactly the
  // ref the module source pins — a root module missing these builds nothing.
  assert.match(mainTf, /source_repository\s*=\s*"https:\/\/git\.invalid\/fleet\.git"/);
  assert.match(mainTf, /source_ref\s*=\s*"v9"/);

  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan', 'apply', 'output']);
  // Every terraform step runs in the deployment directory, never the project root.
  for (const line of s.calls().slice(1)) {
    assert.equal(line.split('\t')[0], fs.realpathSync(infraDir(s.cwd)), `wrong cwd: ${line}`);
  }

  const config = JSON.parse(fs.readFileSync(path.join(infraDir(s.cwd), 'fleet-config.json'), 'utf8'));
  assert.equal(config.cluster, 'demo');
  assert.equal(config.daemon_url, 'http://127.0.0.1:19000', 'the last manual bring-up step is written in');

  // The wizard owns image production (#189): after the apply it starts the
  // deployment's own build and waits it out — the happy path has no clone and
  // no local docker anywhere in it.
  assert.equal(
    s.buildCalls().filter((line) => line.startsWith('codebuild start-build')).length,
    1,
    'exactly one build started after the apply',
  );
  assert.match(s.buildCalls()[0], /start-build --project-name demo-images --region us-east-1/);
  assert.match(res.stdout, /build demo-images:fake-build-1/, 'the build id is reported');
  assert.match(res.stdout, /images: PROVISIONING/, 'progress is phases, not silence');
  assert.match(res.stdout, /images built and pushed/);
  assert.doesNotMatch(res.stdout, /build\.sh/, 'the happy path no longer points at the developer script');

  // The generated terraform and its state are per-deployment, never committed.
  const gitignore = fs.readFileSync(path.join(s.cwd, '.fleet', '.gitignore'), 'utf8');
  assert.match(gitignore, /^infra\/$/m);
});

test('setup infra: declining the plan applies nothing and keeps the plan', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'infra'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'demo\n\n\nn\n',
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan'], 'no apply without a yes');
  assert.ok(!fs.existsSync(path.join(infraDir(s.cwd), 'fleet-config.json')), 'nothing captured');
  assert.match(res.stdout, /nothing applied/);
  assert.ok(fs.existsSync(path.join(infraDir(s.cwd), 'fleet.tfplan')), 'the plan the operator read is kept');
});

test('setup infra: a rejected answer is asked again, not accepted', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'infra'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    // An empty name (required), then a name AWS would reject, then a good one.
    stdin: '\nNot A Name\ndemo\n\n\ny\n',
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /required/);
  assert.match(res.stdout, /lower-case letters/);
  assert.match(fs.readFileSync(path.join(infraDir(s.cwd), 'main.tf'), 'utf8'), /name\s*=\s*"demo"/);
});

test('setup infra: reusing a VPC asks for subnets, and only then', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'infra'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'demo\neu-west-1\nvpc-0abc123\nsubnet-01, subnet-02\ny\n',
  });
  assert.equal(res.code, 0, res.stderr);
  const mainTf = fs.readFileSync(path.join(infraDir(s.cwd), 'main.tf'), 'utf8');
  assert.match(mainTf, /vpc_id\s*=\s*"vpc-0abc123"/);
  assert.match(mainTf, /subnet_ids\s*=\s*\["subnet-01", "subnet-02"\]/);
  assert.match(mainTf, /region\s*=\s*"eu-west-1"/);
});

test('setup infra: the region prompt defaults to the shell AWS_REGION', async () => {
  const s = scratch({ AWS_REGION: 'ap-southeast-2' });
  const res = await runCli(['setup', 'infra'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'demo\n\n\ny\n',
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(fs.readFileSync(path.join(infraDir(s.cwd), 'main.tf'), 'utf8'), /region\s*=\s*"ap-southeast-2"/);
});

// ---------- headless ----------

test('setup infra headless: flags supply every prompt, and nothing is asked', async () => {
  const s = scratch();
  const res = await runCli(
    ['setup', 'infra', '--name', 'demo', '--region', 'us-east-1', '--yes'],
    { cwd: s.cwd, env: s.env }, // no stdin at all: a read would fail, not hang
  );
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan', 'apply', 'output']);
  assert.match(fs.readFileSync(path.join(infraDir(s.cwd), 'main.tf'), 'utf8'), /name\s*=\s*"demo"/);
  assert.ok(fs.existsSync(path.join(infraDir(s.cwd), 'fleet-config.json')));
});

test('setup infra headless: a missing value exits naming its flag, before terraform', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'infra', '--region', 'us-east-1', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--name/, 'names the flag that was missing');
  assert.deepEqual(subcommands(s.calls()), ['version'], 'preflight only — nothing was planned');
  assert.ok(!fs.existsSync(path.join(s.cwd, '.fleet', 'infra')), 'nothing generated');
});

test('setup infra headless: no --yes stops at the plan instead of applying unasked', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'infra', '--name', 'demo'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan']);
  assert.match(res.stdout, /Rerun with --yes/);
});

test('setup infra: a bad flag value is rejected at the flag, not at apply time', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'infra', '--name', 'demo', '--region', 'moon-1', '--yes'], {
    cwd: s.cwd,
    env: s.env,
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--region/);
  assert.deepEqual(subcommands(s.calls()), ['version']);
});

test('setup infra: an unknown provider is refused, in either flag spelling', async () => {
  // gcp graduated from this test's unknown-provider role to a real unit (#185).
  const s = scratch();
  for (const args of [
    ['setup', 'infra', '--provider', 'azure', '--name', 'demo', '--yes'],
    ['setup', 'infra', '--provider=azure', '--name', 'demo', '--yes'],
  ]) {
    const res = await runCli(args, { cwd: s.cwd, env: s.env });
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /no unit for provider "azure"/);
    // The failure that matters: falling through to the first unit would have
    // generated AWS terraform for someone who asked for another cloud.
    assert.deepEqual(s.calls(), [], 'nothing ran');
    assert.ok(!fs.existsSync(path.join(s.cwd, '.fleet', 'infra')), 'nothing generated');
  }
});

test('setup infra: a flag whose question never ran is refused, not ignored', async () => {
  const s = scratch();
  // Subnets without a VPC to put them in: the operator meant "deploy into my
  // network". Ignoring it would create a whole new VPC instead, and --yes means
  // nobody reads the plan that would have shown it.
  const res = await runCli(['setup', 'infra', '--name', 'demo', '--subnet-ids', 'subnet-01', '--yes'], {
    cwd: s.cwd,
    env: s.env,
  });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /--subnet-ids/);
  assert.deepEqual(subcommands(s.calls()), ['version'], 'refused before anything was planned');
  assert.ok(!fs.existsSync(path.join(s.cwd, '.fleet', 'infra')), 'nothing generated');
});

test('setup infra: a terraform too old for the generated module is refused up front', async () => {
  const s = scratch({ FAKE_TF_VERSION: '1.4.6' });
  const res = await runCli(['setup', 'infra'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'demo\n\n\ny\n',
  });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /1\.4\.6 is too old/);
  assert.match(res.stderr, new RegExp(MIN_TERRAFORM.replace('.', '\\.')));
  assert.deepEqual(subcommands(s.calls()), ['version'], 'the interview never started');
});

test('setup infra: a re-capture keeps the local port the operator chose', async () => {
  const s = scratch();
  assert.equal((await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env })).code, 0);
  const configPath = path.join(infraDir(s.cwd), 'fleet-config.json');
  const captured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(captured.daemon_url, 'http://127.0.0.1:19000');

  // The operator picks another local port — the one field of this file that is
  // theirs, and that no terraform output carries.
  fs.writeFileSync(configPath, JSON.stringify({ ...captured, daemon_url: 'http://127.0.0.1:18080' }, null, 2));
  assert.equal((await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env })).code, 0);

  const recaptured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(
    recaptured.daemon_url,
    'http://127.0.0.1:18080',
    'a rerun that reset this would point every command at a port no tunnel is on',
  );
  assert.equal(recaptured.cluster, 'demo', 'the rest of the description is still refreshed');
});

test('setup infra: a capture that cannot be read says so, and how to retake it', async () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.state, 'fail-output'), '');
  const res = await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1);
  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan', 'apply', 'output'], 'the apply did happen');
  assert.match(res.stderr, /output -json fleet_config failed/);
  assert.match(res.stderr, /fake-terraform: output failed/, "terraform's own reason is not swallowed");
  assert.match(res.stderr, /terraform -chdir=.* output -json fleet_config/, 'names the way out');
});

test('setup infra: a failing apply fails the command and captures nothing', async () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.state, 'fail-apply'), '');
  const res = await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /terraform apply failed/);
  assert.ok(!fs.existsSync(path.join(infraDir(s.cwd), 'fleet-config.json')), 'nothing to describe');
});

test('setup infra: a fleet_config that is not an object is refused, not written', async () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.state, 'fleet-config'), '[]');
  const res = await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /did not return an object/);
  assert.ok(!fs.existsSync(path.join(infraDir(s.cwd), 'fleet-config.json')));
});

test('setup infra: stdin that ends mid-interview exits rather than hanging', async () => {
  const s = scratch();
  // One answer for three questions. "Never hang waiting for input" has to hold
  // for input that runs out, not only for input that was never there.
  const res = await runCli(['setup', 'infra'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'demo\n',
  });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /stdin ended/);
  assert.deepEqual(subcommands(s.calls()), ['version'], 'nothing was planned on half an interview');
});

// ---------- preflight ----------

test('setup infra: no terraform exits 1 before touching anything', async () => {
  const cwd = makeTempDir('fleet-setup-notf-');
  const emptyBin = makeTempDir('fleet-empty-bin-');
  const res = await runCli(['setup', 'infra', '--name', 'demo', '--yes'], {
    cwd,
    env: { PATH: emptyBin },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /terraform is not on PATH/);
  assert.equal(res.stderr.trim().split('\n').length, 1, 'one actionable line, not a stack trace');
  assert.ok(!fs.existsSync(path.join(cwd, '.fleet')), 'nothing written');
});

test('setup infra: no cloud credentials exits 1 before the first prompt', async () => {
  const s = scratch({ FAKE_AWS_DENY_STS: '1' });
  const res = await runCli(['setup', 'infra'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'demo\n\n\ny\n',
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /credentials/);
  assert.deepEqual(subcommands(s.calls()), ['version'], 'the interview never started');
  assert.ok(!fs.existsSync(path.join(s.cwd, '.fleet')), 'nothing written');
});

// ---------- destroy ----------

test('setup infra --destroy: plans the teardown, then destroys on an explicit yes', async () => {
  const s = scratch();
  assert.equal((await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env })).code, 0);
  fs.writeFileSync(path.join(s.state, 'calls.log'), '');

  const res = await runCli(['setup', 'infra', '--destroy'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'y\n',
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan', 'destroy']);
  assert.ok(s.calls()[2].includes('-destroy'), 'the confirmation is preceded by a destroy plan');
  assert.match(res.stdout, /destroyed "demo"/);
  assert.ok(
    !fs.existsSync(path.join(infraDir(s.cwd), 'fleet-config.json')),
    'the capture is removed: it described a deployment that is gone',
  );
});

test('setup infra --destroy: answering no destroys nothing', async () => {
  const s = scratch();
  assert.equal((await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env })).code, 0);
  fs.writeFileSync(path.join(s.state, 'calls.log'), '');

  const res = await runCli(['setup', 'infra', '--destroy'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'n\n',
  });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!subcommands(s.calls()).includes('destroy'));
  assert.ok(fs.existsSync(path.join(infraDir(s.cwd), 'fleet-config.json')), 'the capture survives');
});

test('setup infra --destroy: a name that is not this deployment refuses to destroy', async () => {
  const s = scratch();
  assert.equal((await runCli(['setup', 'infra', '--name', 'prod', '--yes'], { cwd: s.cwd, env: s.env })).code, 0);
  fs.writeFileSync(path.join(s.state, 'calls.log'), '');

  // Two deployments, two checkouts, one tired operator. Destroy takes its
  // target from the state in this directory, so a disagreeing --name means the
  // operator is standing in the wrong one — and --yes means no prompt would
  // ever have shown them whose infrastructure was about to go.
  const res = await runCli(['setup', 'infra', '--destroy', '--yes', '--name', 'staging'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /"prod"/, 'names what this directory actually owns');
  assert.deepEqual(subcommands(s.calls()), ['version'], 'refused at the preflight, before any plan or destroy');

  // Naming it correctly is a statement of intent, not a contradiction.
  const agreeing = await runCli(['setup', 'infra', '--destroy', '--yes', '--name', 'prod'], { cwd: s.cwd, env: s.env });
  assert.equal(agreeing.code, 0, agreeing.stderr);
  assert.ok(subcommands(s.calls()).includes('destroy'));
});

test('setup infra --destroy: nothing generated here means nothing to destroy', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'infra', '--destroy', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no deployment to destroy/);
  assert.deepEqual(subcommands(s.calls()), ['version']);
});

test('setup infra --destroy: no terminal and no --yes refuses rather than proceeding', async () => {
  const s = scratch();
  assert.equal((await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env })).code, 0);
  const res = await runCli(['setup', 'infra', '--destroy'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--yes/);
  assert.ok(fs.existsSync(path.join(infraDir(s.cwd), 'fleet-config.json')));
});

// ---------- backends ----------

test('setup infra: --backend writes the block and --backend-config reaches init', async () => {
  const s = scratch();
  const res = await runCli(
    [
      'setup', 'infra', '--name', 'demo', '--yes',
      '--backend', 's3',
      '--backend-config', 'bucket=tf-state',
      '--backend-config', 'key=fleet/demo.tfstate',
    ],
    { cwd: s.cwd, env: s.env },
  );
  assert.equal(res.code, 0, res.stderr);
  assert.match(fs.readFileSync(path.join(infraDir(s.cwd), 'main.tf'), 'utf8'), /backend "s3" \{\}/);
  const init = s.calls().find((line) => line.includes('\tinit'))!;
  assert.ok(init.includes('-backend-config=bucket=tf-state'), init);
  assert.ok(init.includes('-backend-config=key=fleet/demo.tfstate'), init);
});

// ---------- the in-account image build (#189) ----------

test('setup infra: a failed image build fails the command and names its log', async () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.state, 'fail-image-build'), '');
  const res = await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /image build failed \(FAILED\)/, 'the terminal status is the headline');
  assert.match(res.stderr, /batch-get-builds --ids demo-images:fake-build-1/, 'names the exact command that reads the log');
  // The apply itself succeeded and the capture must survive: the deployment is
  // real, only its images are missing, and a rerun of --rebuild-images fixes it.
  assert.ok(fs.existsSync(path.join(infraDir(s.cwd), 'fleet-config.json')), 'the capture is kept');
});

test('setup infra: a build that cannot even start surfaces the cloud CLI error', async () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.state, 'fail-start-build'), '');
  const res = await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /starting the image build failed/);
  assert.match(res.stderr, /AccessDeniedException/, "the cloud CLI's own reason is not swallowed");
});

test('setup infra --rebuild-images: re-runs the build alone, without terraform', async () => {
  const s = scratch();
  assert.equal((await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env })).code, 0);
  fs.writeFileSync(path.join(s.state, 'calls.log'), '');
  fs.writeFileSync(path.join(s.state, 'codebuild.log'), '');

  const res = await runCli(['setup', 'infra', '--rebuild-images'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(subcommands(s.calls()), ['version'], 'preflight only — no plan, no apply, nothing regenerated');
  assert.equal(s.buildCalls().filter((line) => line.startsWith('codebuild start-build')).length, 1, 'one fresh build');
  assert.match(res.stdout, /images built and pushed/);
  // A rebuild's images do not roll the daemon by themselves; guidance is
  // printed, never run — and never as a pasteable deploy command, because no
  // shipped code path may carry one (docs/decisions.md#d5, pinned by
  // test/images-build.test.ts). Deploying is the operator's act.
  assert.match(res.stdout, /service demo-daemon on cluster demo \(region us-east-1\)/);
  assert.match(res.stdout, /infra\/aws\/README\.md/);
});

test('setup infra --rebuild-images: nothing captured here means nothing to rebuild', async () => {
  const s = scratch();
  const res = await runCli(['setup', 'infra', '--rebuild-images'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /no deployment to rebuild images for/);
  assert.match(res.stderr, /fleet setup infra/, 'names the command that creates one');
  assert.deepEqual(s.buildCalls(), [], 'no build was started');
});

test('setup infra --rebuild-images: a prompt flag is refused, not ignored', async () => {
  const s = scratch();
  assert.equal((await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env })).code, 0);
  const res = await runCli(['setup', 'infra', '--rebuild-images', '--name', 'staging'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /--name/);
});

test('setup infra: a deployment applied from an unpinned source falls back honestly', async () => {
  const s = scratch({ FLEET_MODULE_SOURCE: '/opt/fleet-checkout/infra/aws' });
  // What the real unit outputs when source_ref is empty: no build project.
  fs.writeFileSync(
    path.join(s.state, 'fleet-config'),
    JSON.stringify({ provider: 'ecs', cluster: 'demo', region: 'us-east-1', daemon_port: 9000 }),
  );
  const applied = await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(applied.code, 0, applied.stderr);
  const mainTf = fs.readFileSync(path.join(infraDir(s.cwd), 'main.tf'), 'utf8');
  assert.doesNotMatch(mainTf, /source_ref/, 'a local path pins no ref, so none is invented');
  assert.deepEqual(s.buildCalls(), [], 'no build exists to start');
  assert.match(applied.stdout, /no in-account image build/, 'said plainly, not skipped silently');
  assert.match(applied.stdout, /build\.sh/, 'the developer path is named as the fallback');

  // The upgrade path refuses for the same reason, loudly: --rebuild-images on
  // a deployment with no build project must not invent a ref to build from.
  const rebuild = await runCli(['setup', 'infra', '--rebuild-images'], { cwd: s.cwd, env: s.env });
  assert.equal(rebuild.code, 1, rebuild.stdout);
  assert.match(rebuild.stderr, /unpinned module source/);
});

// ---------- fleet upgrade (#207) ----------
// The converge command re-enters the setup-infra machinery against the same
// fakes: what these tests are about is the re-pin, the explicit-yes contract,
// the revert on refusal, and the image rebuild (or its honest fallback).

// The suite runs from a checkout, so HEAD is the CLI's own identity — the
// commit upgrade converges to, read the way doctor's skew section reads it.
const HEAD_SHA = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: path.join(import.meta.dirname, '..'),
  encoding: 'utf8',
}).stdout.trim();
// A well-formed sha no repository resolves: the "deployment one release behind".
const STALE_SHA = 'deadbeef'.repeat(5);

/** A deployment applied at STALE_SHA, its logs cleared, ready to upgrade. */
async function staleDeployment(
  s: ReturnType<typeof scratch>,
): Promise<{ mainTf: string; configPath: string }> {
  const applied = await runCli(['setup', 'infra', '--name', 'demo', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(applied.code, 0, applied.stderr);
  const configPath = path.join(infraDir(s.cwd), 'fleet-config.json');
  // Point the capture's daemon_url at a port nothing answers on: the finish
  // report probes /health there, and the default 19000 could be a real tunnel
  // on the machine running this suite.
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, daemon_url: 'http://127.0.0.1:1', cluster: 'stale-value' }, null, 2));
  fs.writeFileSync(path.join(s.state, 'calls.log'), '');
  fs.writeFileSync(path.join(s.state, 'codebuild.log'), '');
  return { mainTf: path.join(infraDir(s.cwd), 'main.tf'), configPath };
}

test('upgrade: converges the deployment to the CLI commit on an explicit yes', async () => {
  const s = scratch({ FLEET_MODULE_SOURCE: `git::https://git.invalid/fleet.git//infra/aws?ref=${STALE_SHA}` });
  const { mainTf, configPath } = await staleDeployment(s);

  const res = await runCli(['upgrade'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'y\n',
  });
  assert.equal(res.code, 0, res.stderr);

  // The re-pin: the one-line ?ref= edit, applied — never left describing a
  // ref that was not.
  const text = fs.readFileSync(mainTf, 'utf8');
  assert.match(text, new RegExp(`\\?ref=${HEAD_SHA}"`), 'the root module is re-pinned to the CLI commit');
  assert.ok(!text.includes(STALE_SHA), 'the stale ref is gone — from the source AND the source_ref module arg');
  assert.match(
    text,
    new RegExp(`source_ref\\s+= "${HEAD_SHA}"`),
    '#189: the in-account build clones the re-pinned ref, never the one the apply left behind',
  );
  assert.match(res.stdout, /re-pinned .*main\.tf/);

  // The setup-infra drive, plus -upgrade so init cannot serve the cached old ref.
  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan', 'apply', 'output']);
  const init = s.calls().find((line) => line.includes('\tinit'))!;
  assert.ok(init.includes('-upgrade'), `init must carry -upgrade: ${init}`);

  // The capture is retaken (cluster refreshed) and the operator's port is kept.
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.cluster, 'demo', 'fleet-config.json is re-captured from the new apply');
  assert.equal(config.daemon_url, 'http://127.0.0.1:1', 'the operator-chosen local port survives, as on setup reruns');

  // The rebuild at the same ref: one in-account build, then the roll guidance
  // (never the roll itself — docs/decisions.md#d5).
  assert.equal(s.buildCalls().filter((line) => line.startsWith('codebuild start-build')).length, 1);
  assert.match(res.stdout, /images built and pushed/);
  assert.match(res.stdout, /service demo-daemon on cluster demo/);

  // The finish is the doctor skew section: the end state is reported, not assumed.
  assert.match(res.stdout, new RegExp(`skew: deployment matches this CLI at ${HEAD_SHA.slice(0, 12)}`));
});

test('upgrade: nothing to do says so and changes nothing', async () => {
  const s = scratch({ FLEET_MODULE_SOURCE: `git::https://git.invalid/fleet.git//infra/aws?ref=${HEAD_SHA}` });
  const { mainTf } = await staleDeployment(s); // "stale" only in name: pinned at HEAD already
  const before = fs.readFileSync(mainTf, 'utf8');

  const res = await runCli(['upgrade'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`nothing to do: .*\\(${HEAD_SHA.slice(0, 12)}\\)`));
  assert.deepEqual(s.calls(), [], 'no terraform ran — not even a preflight');
  assert.deepEqual(s.buildCalls(), [], 'no build was started');
  assert.equal(fs.readFileSync(mainTf, 'utf8'), before, 'the root module is untouched');
});

test('upgrade: a refused plan restores the ref and mutates nothing', async () => {
  const s = scratch({ FLEET_MODULE_SOURCE: `git::https://git.invalid/fleet.git//infra/aws?ref=${STALE_SHA}` });
  const { mainTf, configPath } = await staleDeployment(s);
  const tfBefore = fs.readFileSync(mainTf, 'utf8');
  const configBefore = fs.readFileSync(configPath, 'utf8');

  const res = await runCli(['upgrade'], {
    cwd: s.cwd,
    env: { ...s.env, FLEET_FORCE_TTY: '1' },
    stdin: 'n\n',
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan'], 'no apply, no capture');
  assert.match(res.stdout, /nothing applied/);
  assert.match(res.stdout, /restored to ref/);
  assert.equal(fs.readFileSync(mainTf, 'utf8'), tfBefore, 'the ref edit is reverted byte-for-byte');
  assert.equal(fs.readFileSync(configPath, 'utf8'), configBefore, 'the capture is untouched');
  assert.deepEqual(s.buildCalls(), [], 'no build was started');
  assert.ok(
    !fs.existsSync(path.join(infraDir(s.cwd), 'fleet.tfplan')),
    'no plan survives for a ref the operator declined',
  );
});

test('upgrade headless: no --yes stops at the plan and restores the ref', async () => {
  const s = scratch({ FLEET_MODULE_SOURCE: `git::https://git.invalid/fleet.git//infra/aws?ref=${STALE_SHA}` });
  const { mainTf } = await staleDeployment(s);
  const before = fs.readFileSync(mainTf, 'utf8');

  const res = await runCli(['upgrade'], { cwd: s.cwd, env: s.env }); // no stdin: a read would fail, not hang
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan']);
  assert.match(res.stdout, /Rerun with --yes/);
  assert.equal(fs.readFileSync(mainTf, 'utf8'), before, 'planned only — the file keeps describing what is deployed');
});

test('upgrade: a git::file dogfood pin re-applies, and names the image fallback honestly', async () => {
  const s = scratch({ FLEET_MODULE_SOURCE: `git::file:///somewhere/fleet//infra/aws?ref=${STALE_SHA}` });
  // What the real unit outputs for a source CodeBuild cannot clone: no build project.
  fs.writeFileSync(
    path.join(s.state, 'fleet-config'),
    JSON.stringify({ provider: 'ecs', cluster: 'demo', region: 'us-east-1', daemon_port: 9000 }),
  );
  const { mainTf } = await staleDeployment(s);

  const res = await runCli(['upgrade', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan', 'apply', 'output'], 'the converge itself still runs');
  assert.match(fs.readFileSync(mainTf, 'utf8'), new RegExp(`\\?ref=${HEAD_SHA}"`));
  assert.deepEqual(s.buildCalls(), [], 'no in-account build exists to start');
  assert.match(res.stdout, /no in-account image build/, 'said plainly, not skipped silently');
  assert.match(res.stdout, /images\/build\.sh --redeploy-daemon/, 'the developer path is named as the fallback');
});

test('upgrade --rebuild-images: step 4 alone, through the setup machinery', async () => {
  const s = scratch({ FLEET_MODULE_SOURCE: `git::https://git.invalid/fleet.git//infra/aws?ref=${HEAD_SHA}` });
  await staleDeployment(s);

  const res = await runCli(['upgrade', '--rebuild-images'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(subcommands(s.calls()), ['version'], 'preflight only — no plan, no apply, nothing re-pinned');
  assert.equal(s.buildCalls().filter((line) => line.startsWith('codebuild start-build')).length, 1, 'one fresh build');
  assert.match(res.stdout, /images built and pushed/);
  assert.match(res.stdout, /infra\/aws\/README\.md/, 'the roll stays guidance, never a command we run');
});

test('upgrade: no deployment here is an actionable refusal', async () => {
  const s = scratch();
  const res = await runCli(['upgrade', '--yes'], { cwd: s.cwd, env: s.env });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /no deployment to upgrade/);
  assert.match(res.stderr, /fleet setup infra/, 'names the command that creates one');
  assert.deepEqual(s.calls(), [], 'nothing ran');
});

test('repinnedMainTf edits exactly the ref, and refuses a file that moved under it', () => {
  const pin = { provider: 'aws', source: `git::https://git.invalid/fleet.git//infra/aws?ref=${STALE_SHA}&depth=1` };
  const text = [
    '# operator comment that must survive',
    'terraform {',
    '  backend "s3" {}',
    '}',
    'module "fleet" {',
    `  source = "${pin.source}"`,
    '  name   = "demo"',
    '}',
    '',
  ].join('\n');
  const repinned = repinnedMainTf(text, pin, HEAD_SHA);
  assert.ok(repinned.includes(`?ref=${HEAD_SHA}&depth=1`), 'only the ref value changes; trailing params stay');
  assert.equal(
    repinned.replace(HEAD_SHA, STALE_SHA),
    text,
    'not one other byte moves — comments, backend block and answers all survive',
  );
  assert.throws(
    () => repinnedMainTf('module "fleet" { source = "somewhere-else" }', pin, HEAD_SHA),
    /no longer contains the module source/,
  );
});

// ---------- prompt/flag merging ----------

/** An asker with a script of answers, recording what it was asked. */
function scriptedAsker(answers: string[]): { asker: { question: (p: string) => Promise<string>; close: () => void }; asked: string[] } {
  const asked: string[] = [];
  let next = 0;
  return {
    asked,
    asker: {
      question: async (prompt: string) => {
        asked.push(prompt);
        if (next >= answers.length) throw new Error(`unscripted question: ${prompt}`);
        return answers[next++];
      },
      close: () => {},
    },
  };
}

const quiet = (): void => {};

test('merge: a flag wins over its prompt, and the prompt is not asked', async () => {
  const { asker, asked } = scriptedAsker(['']); // only the VPC prompt has no flag here
  const merged = await interview(AWS.prompts, {
    flags: { name: 'demo', region: 'eu-west-2' },
    env: {},
    ask: asker,
    log: quiet,
  });
  assert.deepEqual(merged.answers, { name: 'demo', region: 'eu-west-2', vpc_id: '' });
  assert.equal(asked.length, 1, `asked for values a flag already supplied: ${asked.join(' | ')}`);
});

test('merge: Enter takes the fallback, and an unanswerable prompt keeps asking', async () => {
  const { asker } = scriptedAsker(['', 'demo', '', '']);
  const merged = await interview(AWS.prompts, { flags: {}, env: { AWS_REGION: 'us-west-2' }, ask: asker, log: quiet });
  assert.deepEqual(merged.answers, { name: 'demo', region: 'us-west-2', vpc_id: '' });
  assert.deepEqual(merged.missing, []);
});

test('merge: headless collects every missing flag rather than failing on the first', async () => {
  const merged = await interview(AWS.prompts, { flags: {}, env: {}, log: quiet });
  assert.deepEqual(merged.missing, ['--name'], 'region and vpc-id have defaults; name cannot');
  assert.equal(merged.answers.region, 'us-east-1');
});

test('merge: a prompt its predecessor made irrelevant is skipped, both ways', async () => {
  const headless = await interview(AWS.prompts, { flags: { name: 'demo' }, env: {}, log: quiet });
  assert.equal(headless.answers.subnet_ids, undefined, 'no VPC to reuse means no subnet question');

  const reusing = await interview(AWS.prompts, { flags: { name: 'demo', vpc_id: 'vpc-0abc' }, env: {}, log: quiet });
  assert.deepEqual(reusing.missing, ['--subnet-ids'], 'reusing a VPC makes subnets required');
});

test('merge: an invalid flag value is rejected by the same validator a typed one meets', async () => {
  await assert.rejects(
    () => interview(AWS.prompts, { flags: { name: 'Demo Deployment' }, env: {}, log: quiet }),
    (err: unknown) => err instanceof SetupError && /--name/.test((err as Error).message),
  );
});

// ---------- module source ----------

test('module source: the flag wins, then the environment', () => {
  const root = makeTempDir('fleet-fake-root-');
  assert.equal(
    resolveModuleSource({ provider: 'aws', flag: 'from-flag', env: { FLEET_MODULE_SOURCE: 'from-env' }, root }),
    'from-flag',
  );
  assert.equal(resolveModuleSource({ provider: 'aws', env: { FLEET_MODULE_SOURCE: 'from-env' }, root }), 'from-env');
});

test('module source: derived from this checkout, pinned — tag when there is one', () => {
  const root = path.join(import.meta.dirname, '..');
  const git = (args: string[]): string | undefined => {
    if (args[0] === 'remote') return 'git@github.com:example-org/fleet.git';
    if (args[0] === 'describe') return 'v1.2.3';
    return 'ffffffffffffffffffffffffffffffffffffffff';
  };
  assert.equal(
    resolveModuleSource({ provider: 'aws', env: {}, root, git }),
    'git::https://github.com/example-org/fleet.git//infra/aws?ref=v1.2.3',
    'an ssh remote is normalised, and the ref is the tag',
  );

  const untagged = (args: string[]): string | undefined =>
    args[0] === 'describe' ? undefined : git(args);
  assert.match(
    resolveModuleSource({ provider: 'aws', env: {}, root, git: untagged }),
    /\?ref=f{40}$/,
    'no tag at HEAD pins the commit — never a floating branch',
  );
});

test('pinned source: a git source with a ref yields the repository and ref, nothing else does', () => {
  // The pair feeds the unit's source_repository/source_ref (#189): the
  // in-account image build must clone exactly what the module pins. Tag or
  // commit, .git or not — but a local path or a floating (ref-less) git source
  // pins nothing, and inventing a ref there is the bug this function refuses.
  assert.deepEqual(pinnedSource('git::https://github.com/example-org/fleet.git//infra/aws?ref=v1.2.3'), {
    repository: 'https://github.com/example-org/fleet.git',
    ref: 'v1.2.3',
  });
  assert.deepEqual(pinnedSource(`git::https://git.invalid/fleet//infra/aws?ref=${'f'.repeat(40)}`), {
    repository: 'https://git.invalid/fleet.git',
    ref: 'f'.repeat(40),
  });
  assert.equal(pinnedSource('/opt/fleet-checkout/infra/aws'), undefined, 'a local path pins nothing');
  assert.equal(pinnedSource('git::https://git.invalid/fleet.git//infra/aws'), undefined, 'no ?ref= is a floating source');
  assert.equal(pinnedSource('git::ssh://git@git.invalid/fleet.git//infra/aws?ref=v9'), undefined, 'a build host clones anonymously — ssh is not a source it can fetch');
});

test('module source: no unit beside the install and no override is an actionable refusal', () => {
  const root = makeTempDir('fleet-fake-root-');
  assert.throws(
    () => resolveModuleSource({ provider: 'aws', env: {}, root }),
    (err: unknown) => err instanceof SetupError && /--module-source/.test((err as Error).message),
  );
});

// ---------- the generated root module ----------

test('the generated root module is a complete terraform root', () => {
  const rendered = renderMainTf({
    unit: AWS,
    answers: { name: 'demo', region: 'us-east-1', vpc_id: 'vpc-0abc', subnet_ids: 'subnet-1,subnet-2' },
    moduleSource: 'git::https://git.invalid/fleet.git//infra/aws?ref=v9',
    version: '0.0.0-test',
  });
  assert.match(rendered, /required_version = ">= 1\.5\.0"/);
  assert.match(rendered, /source {2}= "hashicorp\/aws"/);
  assert.match(rendered, /provider "aws" \{\n {2}region = "us-east-1"\n\}/);
  assert.match(rendered, /subnet_ids = \["subnet-1", "subnet-2"\]/);
  // Module outputs are not addressable from a root module: without these
  // passthroughs the capture every other fleet command reads cannot be taken.
  assert.match(rendered, /output "fleet_config" \{\n {2}value = module\.fleet\.fleet_config\n\}/);
  assert.match(rendered, /output "connect_hint"/);
  assert.doesNotMatch(rendered, /backend/, 'local state needs no backend block');
});

test('terraform validate accepts the generated root module', { skip: terraformSkip() }, () => {
  const dir = makeTempDir('fleet-tf-validate-');
  fs.writeFileSync(
    path.join(dir, 'main.tf'),
    renderMainTf({
      unit: AWS,
      answers: { name: 'demo', region: 'us-east-1', vpc_id: '' },
      // The unit in this checkout: validate has to resolve the module, and a
      // git source would make this test a network test.
      moduleSource: path.join(import.meta.dirname, '..', 'infra', 'aws'),
      version: '0.0.0-test',
    }),
  );
  // This CLI is now a terraform *producer*, and AGENTS.md requires this repo's
  // terraform to be fmt-clean — including the terraform it writes into an
  // operator's project, which they will read and edit.
  const fmt = spawnSync('terraform', ['fmt', '-check', '-diff', 'main.tf'], { cwd: dir, encoding: 'utf8' });
  assert.equal(fmt.status, 0, `the generated root module is not fmt-clean:\n${fmt.stdout}${fmt.stderr}`);

  const init = spawnSync('terraform', ['init', '-input=false', '-backend=false'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0, `terraform init failed (needs registry access for the aws provider):\n${init.stderr}`);
  const validate = spawnSync('terraform', ['validate'], { cwd: dir, encoding: 'utf8' });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
});

/**
 * Skip reason when terraform is not installed; the live path is #9's drill.
 *
 * NOT WIRED IN CI YET, and a check that always skips proves nothing: neither
 * the `test` job nor a typical developer machine has terraform, so today this
 * runs only where somebody installed it. It belongs in `.github/workflows/`'s
 * `terraform` job, which has the binary — that step could not be pushed from
 * the job that wrote this file (its token has no `workflow` scope), so the
 * patch travels in the PR body instead. Until it lands, read a pass here as
 * "not checked" unless the run reports this test as passing rather than skipped.
 */
function terraformSkip(): string | false {
  const res = spawnSync('terraform', ['version'], { encoding: 'utf8' });
  return res.error === undefined && res.status === 0 ? false : 'terraform is not installed here';
}

// ---------- setup repo ----------

/** A scratch project that looks like a real repo: an ecosystem, a gate, a command. */
function scratchRepo(): string {
  const cwd = makeTempDir('fleet-setup-repo-');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"scratch"}\n');
  fs.writeFileSync(path.join(cwd, '.env.example'), '# template\nAPI_TOKEN=\nDB_URL=\n');
  fs.mkdirSync(path.join(cwd, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'dev.md'), '# dev\n');
  fs.mkdirSync(path.join(cwd, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.fleet', 'gate.mjs'), '// gate\n');
  return cwd;
}

test('setup repo: an all-Enter interview extracts a valid manifest from the checkout', async () => {
  const cwd = scratchRepo();
  // repo, image, setup command, sync, env vars, pickup, command, critic.
  const res = await runCli(['setup', 'repo'], { cwd, env: { FLEET_FORCE_TTY: '1' }, stdin: '\n'.repeat(8) });
  assert.equal(res.code, 0, res.stderr);

  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'));
  const { ok, errors } = validateManifest(manifest);
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(manifest.workspace.repo, 'origin', 'the portable sentinel is the default');
  assert.equal(manifest.setup.image, 'node:22', 'a package.json names the ecosystem');
  assert.equal(manifest.gates.pickup, 'node .fleet/gate.mjs', 'the gate that exists is the default');
  assert.equal(manifest.harness.commands[0].path, '.claude/commands/dev.md');
  assert.equal(manifest.harness.commands[0].critic, 'code-reviewer');
  assert.deepEqual(manifest.env.vars, ['API_TOKEN', 'DB_URL'], 'env var names come from .env.example');
  assert.equal(manifest.workspace.sync, undefined, 'an empty answer omits the section, never an empty array');
  assert.deepEqual(
    manifest.limits,
    { idle: '20m', block_hot: '30m', decision_timeout: '24h' },
    '#134: the interview writes the documented limit defaults explicitly',
  );

  assert.match(fs.readFileSync(path.join(cwd, '.fleet', 'setup.sh'), 'utf8'), /npm ci/);
  assert.equal((await runCli(['lint'], { cwd })).code, 0, 'the interview cannot produce a manifest lint rejects');
});

test('setup repo: a rejected answer is asked again rather than written', async () => {
  const cwd = scratchRepo();
  const res = await runCli(['setup', 'repo'], {
    cwd,
    env: { FLEET_FORCE_TTY: '1' },
    // repo, image, setup, sync, env vars (bad, then good), pickup, command, critic
    stdin: '\n\n\n\nnot-a-var-name\nAPI_TOKEN\n\n\n\n',
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /not env var names/);
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.env.vars, ['API_TOKEN']);
});

test('setup repo headless: flags supply the answers, and a missing one names its flag', async () => {
  const cwd = scratchRepo();
  const extracted = await runCli(['setup', 'repo', '--repo', 'origin'], { cwd });
  assert.equal(extracted.code, 0, 'every repo prompt has an extractable default here');

  const bare = makeTempDir('fleet-setup-repo-bare-');
  const res = await runCli(['setup', 'repo'], { cwd: bare });
  assert.equal(res.code, 1, 'nothing to extract a harness command from');
  assert.match(res.stderr, /--command-path/);
  assert.ok(!fs.existsSync(path.join(bare, '.fleet', 'manifest.json')), 'nothing written');
});

test('setup repo: an existing manifest becomes the defaults, and overwriting takes a yes', async () => {
  const cwd = scratchRepo();
  assert.equal((await runCli(['setup', 'repo'], { cwd, env: { FLEET_FORCE_TTY: '1' }, stdin: '\n'.repeat(8) })).code, 0);
  const first = fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8');

  const declined = await runCli(['setup', 'repo'], {
    cwd,
    env: { FLEET_FORCE_TTY: '1' },
    stdin: `${'\n'.repeat(8)}n\n`,
  });
  assert.equal(declined.code, 0, declined.stderr);
  assert.match(declined.stdout, /nothing written/);
  assert.equal(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'), first, 'untouched');

  const accepted = await runCli(['setup', 'repo'], {
    cwd,
    env: { FLEET_FORCE_TTY: '1' },
    // Change one answer (the critic); everything else is the existing manifest.
    stdin: `${'\n'.repeat(7)}sceptic\ny\n`,
  });
  assert.equal(accepted.code, 0, accepted.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'));
  assert.equal(manifest.harness.commands[0].critic, 'sceptic');
  assert.equal(manifest.gates.pickup, 'node .fleet/gate.mjs', 'unchanged answers came from the existing manifest');
});

test('setup repo: no terminal and an existing manifest refuses instead of overwriting', async () => {
  const cwd = scratchRepo();
  assert.equal((await runCli(['setup', 'repo'], { cwd, env: { FLEET_FORCE_TTY: '1' }, stdin: '\n'.repeat(8) })).code, 0);
  const res = await runCli(['setup', 'repo'], { cwd });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--yes/);
});

test('setup repo: a manifest the schema rejects is refused, not written', async () => {
  const cwd = scratchRepo();
  // The schema is the authority on manifest shape, and the CLI consults it
  // before writing: whatever the interview assembled, a rejected manifest must
  // not reach disk — `fleet lint` failing on a file setup just wrote is worse
  // than setup refusing to write it.
  const code = await runSetupRepo({
    cwd,
    env: {},
    flags: { repo: 'origin', image: 'node:22', pickup: 'gate', command_path: '.claude/commands/dev.md', critic: 'c' },
    yes: true,
    interactive: false,
    log: () => {},
    validate: () => ({ ok: false, errors: [{ instancePath: '/setup/image', message: 'must be a real image' }] }),
  }).then(
    () => 'resolved',
    (err: unknown) => err,
  );
  assert.ok(code instanceof SetupError, `expected a SetupError, got ${String(code)}`);
  assert.match((code as SetupError).message, /must be a real image/);
  assert.ok(!fs.existsSync(path.join(cwd, '.fleet', 'manifest.json')), 'nothing written');
});

test('setup repo: a manifest that parses but is not one becomes no defaults, and still takes a yes', async () => {
  const cwd = scratchRepo();
  // The file this command exists to repair: valid JSON, not a manifest. Reading
  // defaults off it used to crash on `existing.workspace.repo`, and — because
  // "unusable" was conflated with "absent" — a file too broken to read was also
  // one overwritten without asking.
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), '{"version":1}\n');

  const declined = await runCli(['setup', 'repo'], {
    cwd,
    env: { FLEET_FORCE_TTY: '1' },
    stdin: `${'\n'.repeat(8)}n\n`,
  });
  assert.equal(declined.code, 0, declined.stderr);
  assert.match(declined.stdout, /is not a valid manifest/);
  assert.match(declined.stdout, /nothing written/);
  assert.equal(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'), '{"version":1}\n', 'untouched');

  const accepted = await runCli(['setup', 'repo'], {
    cwd,
    env: { FLEET_FORCE_TTY: '1' },
    stdin: `${'\n'.repeat(8)}y\n`,
  });
  assert.equal(accepted.code, 0, accepted.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'));
  assert.equal(validateManifest(manifest).ok, true, 'the defaults came from the checkout, not the broken file');
  assert.equal(manifest.gates.pickup, 'node .fleet/gate.mjs');
});

test('setup repo: a manifest that is not JSON at all is not silently replaced either', async () => {
  const cwd = scratchRepo();
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), '{ "version": 1, }\n');
  const res = await runCli(['setup', 'repo'], {
    cwd,
    env: { FLEET_FORCE_TTY: '1' },
    stdin: `${'\n'.repeat(8)}n\n`,
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /is not valid JSON/);
  assert.equal(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'), '{ "version": 1, }\n');
});

// ---------- setup repo: subscription-seat auth (#205) ----------

/** A scratch repo with no .env.example: the manifest's env.vars start empty. */
function seatScratch(): string {
  const cwd = makeTempDir('fleet-seat-repo-');
  fs.mkdirSync(path.join(cwd, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'dev.md'), '# dev\n');
  return cwd;
}

test('setup repo: a seat login and no credential walks the acquisition — one paste writes .fleet/.env and the manifest', async () => {
  const cwd = scratchRepo();
  const claudeDir = makeTempDir('fleet-claude-login-'); // the probe is presence of the CLI's config surface
  const res = await runCli(['setup', 'repo'], {
    cwd,
    env: {
      FLEET_FORCE_TTY: '1',
      CLAUDE_CONFIG_DIR: claudeDir,
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    },
    // The eight repo prompts, then the one paste.
    stdin: `${'\n'.repeat(8)}sk-ant-oat01-pasted\n`,
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /claude setup-token/, 'the walk teaches the vendor command');

  const envPath = path.join(cwd, '.fleet', '.env');
  assert.match(fs.readFileSync(envPath, 'utf8'), /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-pasted$/m);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600, 'the credential file is 0600');
  const gitignore = fs.readFileSync(path.join(cwd, '.fleet', '.gitignore'), 'utf8');
  assert.ok(gitignore.split('\n').includes('.env'), '.fleet/.gitignore covers .env');

  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'));
  assert.deepEqual(
    manifest.env.vars,
    ['API_TOKEN', 'DB_URL', 'CLAUDE_CODE_OAUTH_TOKEN'],
    'the interview declares the var itself — the user never learns a variable name',
  );
});

test('setup repo headless: --claude-oauth-token writes the credential, and a subsequent delegate dispatches with it', async (t) => {
  const cwd = seatScratch();
  const setup = await runCli(
    ['setup', 'repo', '--repo', 'git@github.com:acme/example-app.git', '--claude-oauth-token', 'sk-ant-oat01-headless'],
    { cwd, env: { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined } },
  );
  assert.equal(setup.code, 0, setup.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.env.vars, ['CLAUDE_CODE_OAUTH_TOKEN']);

  // The whole point: the very next dispatch works, with the token riding in
  // from .fleet/.env rather than the shell.
  const daemon = await startMockDaemon({
    'POST /jobs': (_req, res) => sendJson(res, 201, { job: { id: 'job-seat', state: 'queued' } }),
  });
  t.after(daemon.close);
  const dispatched = await runCli(['delegate', 'assess the release notes'], {
    cwd,
    env: { FLEET_DAEMON_URL: daemon.url, CLAUDE_CODE_OAUTH_TOKEN: undefined },
  });
  assert.equal(dispatched.code, 0, dispatched.stderr);
  const body = JSON.parse(daemon.requests[0].body);
  assert.equal(body.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-headless', 'the pasted token ships with the job');
});

test('setup repo: the token flag replaces a stale value in .fleet/.env and leaves the rest alone', async () => {
  const cwd = seatScratch();
  fs.mkdirSync(path.join(cwd, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.fleet', '.env'), 'OTHER_SETTING=kept\nCLAUDE_CODE_OAUTH_TOKEN=stale\n');
  const res = await runCli(
    ['setup', 'repo', '--repo', 'origin', '--claude-oauth-token', 'sk-ant-oat01-fresh', '--yes'],
    { cwd, env: { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined } },
  );
  assert.equal(res.code, 0, res.stderr);
  const dotEnv = fs.readFileSync(path.join(cwd, '.fleet', '.env'), 'utf8');
  assert.equal(dotEnv, 'OTHER_SETTING=kept\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fresh\n');
  assert.equal(fs.statSync(path.join(cwd, '.fleet', '.env')).mode & 0o777, 0o600, 'an existing .env is tightened');
});

test('setup repo: a credential already in the environment means no walk — the interview stays eight questions', async () => {
  const cwd = scratchRepo();
  const claudeDir = makeTempDir('fleet-claude-login-');
  // Exactly eight Enters: a ninth prompt would fail on ended stdin.
  const res = await runCli(['setup', 'repo'], {
    cwd,
    env: { FLEET_FORCE_TTY: '1', CLAUDE_CONFIG_DIR: claudeDir, ANTHROPIC_API_KEY: 'sk-ant-api-here' },
    stdin: '\n'.repeat(8),
  });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!fs.existsSync(path.join(cwd, '.fleet', '.env')), 'nothing to acquire, nothing written');
});

test('setup repo: a Codex login is offered into sync, copied 0600 and gitignored on yes', async () => {
  const cwd = seatScratch();
  const codexHome = makeTempDir('fleet-codex-home-');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"tokens":"codex-login"}\n');
  const res = await runCli(['setup', 'repo'], {
    cwd,
    env: { FLEET_FORCE_TTY: '1', CODEX_HOME: codexHome, ANTHROPIC_API_KEY: 'sk-ant-api-here' },
    stdin: `${'\n'.repeat(8)}yes\n`,
  });
  assert.equal(res.code, 0, res.stderr);

  const copy = path.join(cwd, '.fleet', 'codex-auth.json');
  assert.equal(fs.readFileSync(copy, 'utf8'), '{"tokens":"codex-login"}\n');
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.workspace.sync, ['.fleet/codex-auth.json'], 'the copy rides workspace.sync');
  const gitignore = fs.readFileSync(path.join(cwd, '.fleet', '.gitignore'), 'utf8');
  assert.ok(gitignore.split('\n').includes('codex-auth.json'), 'the copy never enters the repo');
});

test('setup repo: declining the Codex offer copies nothing and syncs nothing', async () => {
  const cwd = seatScratch();
  const codexHome = makeTempDir('fleet-codex-home-');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"tokens":"codex-login"}\n');
  const res = await runCli(['setup', 'repo'], {
    cwd,
    env: { FLEET_FORCE_TTY: '1', CODEX_HOME: codexHome, ANTHROPIC_API_KEY: 'sk-ant-api-here' },
    // Enter on the offer takes the default, which is no — protecting the account.
    stdin: '\n'.repeat(9),
  });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!fs.existsSync(path.join(cwd, '.fleet', 'codex-auth.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.fleet', 'manifest.json'), 'utf8'));
  assert.equal(manifest.workspace.sync, undefined);
});

test('setup repo: --codex-auth yes with no Codex login here is a refusal, not a broken manifest', async () => {
  const cwd = seatScratch();
  const res = await runCli(['setup', 'repo', '--repo', 'origin', '--codex-auth', 'yes'], {
    cwd,
    env: { ANTHROPIC_API_KEY: 'sk-ant-api-here' },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no Codex login/);
  assert.ok(!fs.existsSync(path.join(cwd, '.fleet', 'manifest.json')), 'nothing written');
});

// ---------- the unit contract ----------

test('every setup unit asks for the name the rest of setup depends on', () => {
  // `answers.name` is read by the apply confirmation, the destroy guard and
  // `generatedName`; a unit without that prompt would print `as "undefined"`
  // and fall back to the provider string on teardown. The map is the place a
  // second cloud is added, so this is the place that catches it.
  for (const unit of SETUP_UNITS) {
    const name = unit.prompts.find((p) => p.key === 'name');
    assert.ok(name, `unit ${unit.provider} has no "name" prompt`);
    assert.equal(name.required, true, `unit ${unit.provider}: name must be required — it names the deployment`);
    assert.deepEqual(
      unit.moduleArgs({ name: 'demo', region: 'us-east-1' }).find(([key]) => key === 'name'),
      ['name', '"demo"'],
      `unit ${unit.provider}: the name answer must reach the module`,
    );
  }
});

test('the gcp unit exists with its own region spelling — neither cloud validates the other (#185)', () => {
  const gcp = unitFor('gcp');
  assert.ok(gcp, 'the gcp unit must be registered in SETUP_UNITS');
  const gcpRegion = gcp.prompts.find((p) => p.key === 'region');
  assert.ok(gcpRegion?.validate, 'gcp must validate its region prompt');
  // The two clouds spell regions inversely (us-central1 vs us-east-1); a
  // shared validator was the standing invitation to reuse the AWS regex, and
  // each accepting the other's spelling is exactly the bug.
  assert.equal(gcpRegion.validate('us-central1'), undefined);
  assert.equal(gcpRegion.validate('asia-southeast1'), undefined);
  assert.match(gcpRegion.validate('us-east-1') ?? '', /not a GCP region/);
  assert.match(gcpRegion.validate('moon-1') ?? '', /not a GCP region/);

  const awsRegion = unitFor('aws')!.prompts.find((p) => p.key === 'region');
  assert.equal(awsRegion!.validate!('us-east-1'), undefined);
  assert.match(awsRegion!.validate!('us-central1') ?? '', /not an AWS region/);
});

test('the gcp unit caps the name at what service-account ids can carry (#185)', () => {
  const name = unitFor('gcp')!.prompts.find((p) => p.key === 'name')!;
  assert.equal(name.validate!('fleet'), undefined);
  assert.equal(name.validate!('a'.repeat(22)), undefined);
  assert.match(name.validate!('a'.repeat(23)) ?? '', /22 characters/);
});

test('the gcp unit pins the daemon version, defaulting to this CLI (#185)', () => {
  const gcp = unitFor('gcp')!;
  const version = gcp.prompts.find((p) => p.key === 'fleet_version');
  assert.ok(version, 'the daemon version must be asked — an unpinned npm install skews silently');
  assert.equal(version.required, true);
  const pkg = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string };
  assert.equal(version.fallback!({}), pkg.version, "the default is the CLI's own version — the AWS source_ref pin's npm twin");
  assert.equal(version.validate!('0.2.0'), undefined);
  assert.match(version.validate!('latest') ?? '', /not a version/);

  // The answer reaches the module; network/subnetwork travel together like
  // the AWS vpc_id/subnet_ids pair and stay absent when unanswered.
  const bare = gcp.moduleArgs({ name: 'demo', project: 'demo-project', region: 'us-central1', fleet_version: '0.2.0' });
  assert.deepEqual(bare, [['name', '"demo"'], ['fleet_version', '"0.2.0"']]);
  const networked = gcp.moduleArgs({
    name: 'demo', project: 'demo-project', region: 'us-central1',
    network: 'shared-vpc', subnetwork: 'shared-subnet', fleet_version: '0.2.0',
  });
  assert.deepEqual(networked, [
    ['name', '"demo"'],
    ['network', '"shared-vpc"'],
    ['subnetwork', '"shared-subnet"'],
    ['fleet_version', '"0.2.0"'],
  ]);
  // The provider block carries project and region — where every google
  // resource resolves them from.
  assert.deepEqual(gcp.providerArgs({ project: 'demo-project', region: 'us-central1' } as Record<string, string>), [
    ['project', '"demo-project"'],
    ['region', '"us-central1"'],
  ]);
});

test('the gcp unit offers no in-account image build and says so honestly (#185)', () => {
  // The Cloud Build block is the #185 follow-up; until then start() offering
  // nothing routes the wizard to the unavailable message, which must name the
  // by-hand path rather than pretend a build exists.
  const gcp = unitFor('gcp')!;
  assert.equal(gcp.images.start({ provider: 'gcp', runner_repository_url: 'r' }), undefined);
  assert.match(gcp.images.unavailable, /docker push/);
  assert.match(gcp.images.rollHint({ runner_repository_url: 'us-central1-docker.pkg.dev/p/fleet-runner/runner' }), /fleet upgrade/);
});

test('terraformTooOld reads a version rather than trusting the binary exists', () => {
  assert.match(terraformTooOld('Terraform v1.4.6\n') ?? '', /too old/);
  assert.equal(terraformTooOld('Terraform v1.5.0\n'), undefined, 'the floor itself passes');
  assert.equal(terraformTooOld('Terraform v2.0.1\n'), undefined);
  assert.equal(terraformTooOld('OpenTofu v1.6.0\n'), undefined, 'an unreadable version is not a refusal');
});
