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
import { validateManifest } from '../src/validate.mjs';
import { runCli, makeTempDir, fakeCloudBin } from './cli-helpers.ts';
import { interview, renderMainTf, resolveModuleSource, repoManifest, SetupError } from '../src/cli/setup.ts';
import { unitFor } from '../src/cli/setup-units.ts';

const AWS = unitFor('aws')!;

/** A scratch project plus a PATH carrying the fake terraform and aws. */
function scratch(extraEnv: Record<string, string | undefined> = {}): {
  cwd: string;
  env: Record<string, string | undefined>;
  state: string;
  calls: () => string[];
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

  assert.deepEqual(subcommands(s.calls()), ['version', 'init', 'plan', 'apply', 'output']);
  // Every terraform step runs in the deployment directory, never the project root.
  for (const line of s.calls().slice(1)) {
    assert.equal(line.split('\t')[0], fs.realpathSync(infraDir(s.cwd)), `wrong cwd: ${line}`);
  }

  const config = JSON.parse(fs.readFileSync(path.join(infraDir(s.cwd), 'fleet-config.json'), 'utf8'));
  assert.equal(config.cluster, 'demo');
  assert.equal(config.daemon_url, 'http://127.0.0.1:19000', 'the last manual bring-up step is written in');

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
  const s = scratch();
  for (const args of [
    ['setup', 'infra', '--provider', 'gcp', '--name', 'demo', '--yes'],
    ['setup', 'infra', '--provider=gcp', '--name', 'demo', '--yes'],
  ]) {
    const res = await runCli(args, { cwd: s.cwd, env: s.env });
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /no unit for provider "gcp"/);
    // The failure that matters: falling through to the first unit would have
    // generated AWS terraform for someone who asked for another cloud.
    assert.deepEqual(s.calls(), [], 'nothing ran');
    assert.ok(!fs.existsSync(path.join(s.cwd, '.fleet', 'infra')), 'nothing generated');
  }
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
  const init = spawnSync('terraform', ['init', '-input=false', '-backend=false'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0, `terraform init failed (needs registry access for the aws provider):\n${init.stderr}`);
  const validate = spawnSync('terraform', ['validate'], { cwd: dir, encoding: 'utf8' });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
});

/** Skip reason when terraform is not installed; the live path is #9's drill. */
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

test('setup repo: the manifest a bad answer would make is refused, not written', () => {
  // repoManifest is schema-shaped by construction; the guard is that the CLI
  // validates before writing, so a shape the schema rejects never lands.
  const manifest = repoManifest({ repo: 'origin', image: '', pickup: 'gate', command_path: 'c.md', critic: '' });
  const { ok } = validateManifest({ ...manifest, setup: { image: '', script: '.fleet/setup.sh', dockerfile: 'x' } });
  assert.equal(ok, false, 'the schema is the authority on manifest shape, not the interview');
});
