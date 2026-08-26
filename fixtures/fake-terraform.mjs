#!/usr/bin/env node
// Stand-in for the `terraform` binary, for `fleet setup infra` tests (#13).
//
// Terraform itself is not what those tests are about: the CLI's job is to ask
// the right questions, generate the right root module, run the right steps in
// the right directory, and capture the result. So this records every call and
// answers plausibly, and one live path stays documented for the #9 drill.
//
// State lives in FAKE_TF_DIR:
//   calls.log       — one line per invocation: "<cwd>\t<args...>"
//   fleet-config    — JSON returned by `output -json fleet_config` (optional)
//   fail-<command>  — present: that subcommand exits 1
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = process.env.FAKE_TF_DIR;
if (!dir) {
  process.stderr.write('fake-terraform: FAKE_TF_DIR is not set\n');
  process.exit(2);
}
appendFileSync(join(dir, 'calls.log'), `${process.cwd()}\t${args.join(' ')}\n`);

// `-chdir` is terraform's own global flag; the CLI does not use it (it runs
// terraform in the deployment directory), but a test asserting that is only
// meaningful if the fake would have honoured it.
const command = args.find((a) => !a.startsWith('-'));
if (existsSync(join(dir, `fail-${command}`))) {
  process.stderr.write(`fake-terraform: ${command} failed\n`);
  process.exit(1);
}

if (command === 'version') {
  // FAKE_TF_VERSION is how a test says "this machine has an old terraform";
  // the CLI reads the version, because the module it generates requires one.
  process.stdout.write(`Terraform v${process.env.FAKE_TF_VERSION ?? '1.9.8'}\n`);
} else if (command === 'init') {
  process.stdout.write('Terraform has been successfully initialized!\n');
} else if (command === 'plan') {
  const out = args.find((a) => a.startsWith('-out='));
  if (out) writeFileSync(join(process.cwd(), out.slice('-out='.length)), 'fake plan\n');
  process.stdout.write(
    args.includes('-destroy')
      ? 'Plan: 0 to add, 0 to change, 42 to destroy.\n'
      : 'Plan: 42 to add, 0 to change, 0 to destroy.\n',
  );
} else if (command === 'apply' || command === 'destroy') {
  process.stdout.write(`Apply complete! (${command})\n`);
} else if (command === 'output') {
  const configFile = join(dir, 'fleet-config');
  const config = existsSync(configFile)
    ? readFileSync(configFile, 'utf8')
    : JSON.stringify({
        provider: 'ecs',
        cluster: 'demo',
        // region + image_build_project: what the wizard's post-apply image
        // build (#189) reads. Present by default because the setup tests pin
        // a *pinned* module source, which is the shape that provisions one.
        region: 'us-east-1',
        image_build_project: 'demo-images',
        daemon_service: 'demo-daemon',
        daemon_container_name: 'demo-daemon',
        daemon_port: 9000,
        runner_repository_url: '111122223333.dkr.ecr.us-east-1.amazonaws.com/demo-runner',
      });
  process.stdout.write(config);
} else {
  process.stderr.write(`fake-terraform: unexpected call: ${args.join(' ')}\n`);
  process.exit(2);
}
