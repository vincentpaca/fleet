#!/usr/bin/env node
// Stand-in for the `gcloud` CLI, for `fleet setup infra --provider gcp` tests
// (#185). The counterpart of fixtures/fake-aws.mjs: what those tests are about
// is the CLI's own job — proving credentials before the first prompt, starting
// the deployment's own in-account build after the apply, and polling it to an
// ending — so this records every call and answers plausibly.
//
// State lives in FAKE_GCLOUD_DIR:
//   cloudbuild.log   — one line per `gcloud builds …` invocation (its args)
//   build-polls      — how many `builds describe` calls have been answered
//   fail-start-build — present: `builds submit` exits non-zero (no permission)
//   fail-image-build — present: the build ends FAILURE instead of SUCCESS
//
// FAKE_GCLOUD_DENY_AUTH is how a test says "this shell has no usable Google
// credentials"; it needs no state directory, because the credential preflight
// runs before anything has been created.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

// The build id `builds submit --format=value(id)` prints: a UUID, which is the
// shape the CLI picks out of gcloud's narration.
const BUILD_ID = '11111111-2222-3333-4444-555555555555';

if (args[0] === 'auth' && args[1] === 'print-access-token') {
  if (process.env.FAKE_GCLOUD_DENY_AUTH) {
    process.stderr.write(
      'ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected.\n',
    );
    process.exit(1);
  }
  process.stdout.write('ya29.fake-access-token\n');
  process.exit(0);
}

const dir = process.env.FAKE_GCLOUD_DIR;
if (!dir) {
  process.stderr.write('fake-gcloud: FAKE_GCLOUD_DIR is not set\n');
  process.exit(2);
}

if (args[0] === 'builds') {
  appendFileSync(join(dir, 'cloudbuild.log'), `${args.join(' ')}\n`);
  if (args[1] === 'submit') {
    if (existsSync(join(dir, 'fail-start-build'))) {
      process.stderr.write(
        'ERROR: (gcloud.builds.submit) PERMISSION_DENIED: caller does not have permission to create builds\n',
      );
      process.exit(1);
    }
    // The real CLI narrates on stdout around the formatted value; the id is
    // picked out by shape, and this reproduces that so a reader that just takes
    // the last line fails here.
    process.stdout.write(`Created [https://cloudbuild.googleapis.com/v1/projects/p/builds/${BUILD_ID}].\n`);
    process.stdout.write(`${BUILD_ID}\n`);
    process.stdout.write('Logs are available at [https://console.cloud.google.com/cloud-build/builds].\n');
    process.exit(0);
  }
  if (args[1] === 'describe') {
    const pollFile = join(dir, 'build-polls');
    const polls = (existsSync(pollFile) ? Number(readFileSync(pollFile, 'utf8')) : 0) + 1;
    writeFileSync(pollFile, String(polls));
    // Two non-terminal statuses, then an ending: enough shape for the wizard's
    // phase reporting to be observable without a real build.
    const status =
      polls === 1 ? 'QUEUED'
      : polls === 2 ? 'WORKING'
      : existsSync(join(dir, 'fail-image-build')) ? 'FAILURE'
      : 'SUCCESS';
    process.stdout.write(`${JSON.stringify({ id: BUILD_ID, status })}\n`);
    process.exit(0);
  }
  process.stderr.write(`fake-gcloud: unexpected builds call: ${args.join(' ')}\n`);
  process.exit(2);
}

process.stderr.write(`fake-gcloud: unexpected call: ${args.join(' ')}\n`);
process.exit(2);
