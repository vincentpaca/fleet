// images/build.sh owns platform, tags, push, and the daemon roll (#47).
//
// The script is exercised for real — no dry-run flag, no reimplementation of
// its logic here. `docker` and `aws` are replaced by recording stubs on PATH,
// so every assertion is about the argv the script would hand the real tools:
// the platform it targets, the exact :runner / :daemon tags it pushes, and the
// service it rolls. A bug that mangles a tag or drops --platform on one of the
// two images shows up as a wrong line in the recording.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './cli-helpers.ts';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'images', 'build.sh');

// A deployment's fleet_config as captured locally (terraform output -json
// fleet_config > .fleet/infra/<provider>/fleet-config.json).
const REPOSITORY = '123456789012.dkr.ecr.us-west-2.amazonaws.com/fleet-runner';
const ECR_HOST = REPOSITORY.split('/')[0];
const FLEET_CONFIG = {
  provider: 'ecs',
  cluster: 'fleet',
  daemon_service: 'fleet-daemon',
  runner_repository_url: REPOSITORY,
  runner_task_definition: 'fleet-runner',
  runner_container_name: 'fleet-runner',
};

type Run = { code: number; stdout: string; stderr: string; log: string[] };

/**
 * Recording stubs for docker and aws, prepended to PATH. `docker login` drains
 * stdin: the script pipes the ECR password into it under `set -o pipefail`, so
 * a stub that ignores stdin would fail the run for the wrong reason.
 */
function stubBin(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'docker'),
    '#!/bin/sh\nprintf \'docker %s\\n\' "$*" >> "$FLEET_FAKE_LOG"\ncase "$1" in login) cat > /dev/null ;; esac\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, 'aws'),
    '#!/bin/sh\nprintf \'aws %s\\n\' "$*" >> "$FLEET_FAKE_LOG"\ncase "$2" in get-login-password) echo fake-ecr-password ;; esac\nexit 0\n',
    { mode: 0o755 },
  );
}

/**
 * Run build.sh from `cwd` (default: a fresh temp dir, so the checkout's own
 * .fleet/infra/ — which on an operator's machine points at a live deployment —
 * is never the discovery source under test).
 */
function runBuild(args: string[], opts: { cwd?: string; config?: unknown; env?: Record<string, string> } = {}): Run {
  const cwd = opts.cwd ?? makeTempDir('fleet-build-cwd-');
  if (opts.config !== undefined) {
    const infraDir = path.join(cwd, '.fleet', 'infra', 'aws');
    fs.mkdirSync(infraDir, { recursive: true });
    fs.writeFileSync(path.join(infraDir, 'fleet-config.json'), JSON.stringify(opts.config));
  }
  const binDir = makeTempDir('fleet-build-bin-');
  stubBin(binDir);
  const logPath = path.join(makeTempDir('fleet-build-log-'), 'calls.log');
  fs.writeFileSync(logPath, '');

  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FLEET_FAKE_LOG: logPath,
    // A region the deployment is not in: the repository URL must win, or the
    // login token is minted for the wrong region.
    AWS_REGION: 'eu-central-1',
    // The shell must not decide what the runner base contains.
    HARNESS_CLI: undefined,
    HARNESS_VERSION: undefined,
    ...opts.env,
  };
  const res = spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8', env });
  const log = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', log };
}

const find = (log: string[], needle: string): string[] => log.filter((line) => line.includes(needle));
const only = (log: string[], needle: string): string => {
  const hits = find(log, needle);
  assert.equal(hits.length, 1, `expected exactly one ${needle} call, got:\n${log.join('\n')}`);
  return hits[0];
};

// ---------- build ----------

describe('build', () => {
  test('with no flags builds both images for the deployment architecture', () => {
    const res = runBuild([]);
    assert.equal(res.code, 0, res.stderr);

    const builds = find(res.log, 'docker build');
    assert.equal(builds.length, 2, `expected a runner and a daemon build, got:\n${res.log.join('\n')}`);

    const runner = only(res.log, 'images/runner/Dockerfile');
    assert.match(runner, /--platform linux\/amd64/);
    assert.match(runner, /--build-arg HARNESS_CLI=claude-code/);
    assert.match(runner, /--build-arg HARNESS_VERSION=latest/);
    assert.match(runner, /-t fleet-runner:claude-code-latest/);

    const daemon = only(res.log, 'images/daemon/Dockerfile');
    assert.match(daemon, /--platform linux\/amd64/);
    assert.match(daemon, /-t fleet-daemon:local/);

    // Building is not publishing.
    assert.deepEqual(find(res.log, 'docker push'), []);
    assert.deepEqual(find(res.log, 'docker tag'), []);
    assert.deepEqual(find(res.log, 'aws '), []);
  });

  test('--platform applies to both images, not just the runner', () => {
    const res = runBuild(['--platform', 'linux/arm64']);
    assert.equal(res.code, 0, res.stderr);
    const builds = find(res.log, 'docker build');
    assert.equal(builds.length, 2);
    for (const line of builds) assert.match(line, /--platform linux\/arm64/);
  });

  test('--runner builds only the runner base', () => {
    const res = runBuild(['--runner']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(find(res.log, 'docker build').length, 1);
    assert.deepEqual(find(res.log, 'images/daemon/Dockerfile'), []);
  });

  test("the build context is the Fleet checkout, not the caller's repo", () => {
    // The operator runs this from their own project, which is its own git repo:
    // resolving the context with `git rev-parse` would hand docker that tree.
    const cwd = makeTempDir('fleet-build-otherrepo-');
    execFileSync('git', ['init', '-q'], { cwd });
    const res = runBuild(['--runner'], { cwd });
    assert.equal(res.code, 0, res.stderr);
    const runner = only(res.log, 'docker build');
    assert.ok(
      runner.includes(`-f ${REPO_ROOT}/images/runner/Dockerfile`),
      `Dockerfile must resolve inside the checkout, got: ${runner}`,
    );
    assert.ok(runner.endsWith(REPO_ROOT), `build context must be the checkout, got: ${runner}`);
    assert.ok(!runner.includes(cwd), `caller's repo leaked into the build: ${runner}`);
  });
});

// ---------- push ----------

describe('push', () => {
  test('--push tags and pushes :runner and :daemon into the discovered repository', () => {
    const res = runBuild(['--push'], { config: FLEET_CONFIG });
    assert.equal(res.code, 0, res.stderr);

    // Region comes from the repository URL — AWS_REGION in the environment is a
    // different region and must not win, or the login token is for the wrong one.
    assert.equal(only(res.log, 'get-login-password'), 'aws ecr get-login-password --region us-west-2');
    assert.equal(
      only(res.log, 'docker login'),
      `docker login --username AWS --password-stdin ${ECR_HOST}`,
    );

    // The tags the infra unit pins, exactly — a mangled tag lands in a
    // repository nothing reads.
    assert.deepEqual(find(res.log, 'docker push'), [
      `docker push ${REPOSITORY}:runner`,
      `docker push ${REPOSITORY}:daemon`,
    ]);
    assert.deepEqual(find(res.log, 'docker tag'), [
      `docker tag fleet-runner:claude-code-latest ${REPOSITORY}:runner`,
      `docker tag fleet-daemon:local ${REPOSITORY}:daemon`,
    ]);

    // Pushing is not rolling.
    assert.deepEqual(find(res.log, 'update-service'), []);
  });

  test('--runner --push publishes only the :runner tag', () => {
    const res = runBuild(['--runner', '--push'], { config: FLEET_CONFIG });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(only(res.log, 'docker push'), `docker push ${REPOSITORY}:runner`);
  });

  test('--repository overrides discovery and its region wins over AWS_REGION', () => {
    const res = runBuild(
      ['--runner', '--push', '--repository', '210987654321.dkr.ecr.ap-southeast-2.amazonaws.com/fleet-runner'],
      // No config file at all: every value came from the flag.
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(only(res.log, 'get-login-password'), 'aws ecr get-login-password --region ap-southeast-2');
    assert.equal(
      only(res.log, 'docker push'),
      'docker push 210987654321.dkr.ecr.ap-southeast-2.amazonaws.com/fleet-runner:runner',
    );
  });

  test('--region overrides the region derived from the repository URL', () => {
    const res = runBuild(['--runner', '--push', '--region', 'us-east-2'], { config: FLEET_CONFIG });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(only(res.log, 'get-login-password'), 'aws ecr get-login-password --region us-east-2');
  });

  test('--push with no repository anywhere fails before any build', () => {
    const res = runBuild(['--push']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /no ECR repository/);
    assert.match(res.stderr, /fleet_config/);
    assert.deepEqual(res.log, [], 'must not spend a build it cannot publish');
  });

  test('a registry host passed as --repository is rejected, not pushed to', () => {
    // <host> alone would make the push target <host>:runner — a tag on a
    // repository that does not exist, which is how the hand-run push failed.
    const res = runBuild(['--runner', '--push', '--repository', ECR_HOST]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /full ECR repository URL/);
    assert.deepEqual(res.log, []);
  });

  test('--registry names its replacement instead of pushing to a registry host', () => {
    const res = runBuild(['--registry', ECR_HOST, '--push']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--repository/);
    assert.deepEqual(res.log, []);
  });
});

// ---------- roll the daemon ----------

describe('--redeploy-daemon', () => {
  test('pushes both tags, then forces a new deployment of the daemon service', () => {
    const res = runBuild(['--redeploy-daemon'], { config: FLEET_CONFIG });
    assert.equal(res.code, 0, res.stderr);

    assert.equal(
      only(res.log, 'update-service'),
      'aws ecs update-service --cluster fleet --service fleet-daemon --force-new-deployment --region us-west-2',
    );

    // The roll must come last: rolling before the push starts the old image.
    const rollAt = res.log.findIndex((l) => l.includes('update-service'));
    const lastPushAt = res.log.reduce((acc, l, i) => (l.includes('docker push') ? i : acc), -1);
    assert.ok(lastPushAt >= 0, 'the daemon image must be pushed');
    assert.ok(rollAt > lastPushAt, `roll at ${rollAt} must follow the last push at ${lastPushAt}`);
    assert.equal(find(res.log, 'docker push').length, 2);
  });

  test('fails before any build when the config does not name the daemon service', () => {
    const { daemon_service: _omitted, ...withoutService } = FLEET_CONFIG;
    const res = runBuild(['--redeploy-daemon'], { config: withoutService });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /daemon_service/);
    // The escape hatch it names must be a flag that exists.
    assert.match(res.stderr, /--service <name>/);
    assert.deepEqual(res.log, [], 'must not build or push a roll it cannot finish');
  });

  test('fails when the config does not name the cluster', () => {
    const { cluster: _omitted, ...withoutCluster } = FLEET_CONFIG;
    const res = runBuild(['--redeploy-daemon'], { config: withoutCluster });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--cluster <name>/);
    assert.deepEqual(res.log, []);
  });

  test('rejects --runner, which would roll the service onto an unchanged image', () => {
    const res = runBuild(['--runner', '--redeploy-daemon'], { config: FLEET_CONFIG });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--redeploy-daemon/);
    assert.deepEqual(res.log, []);
  });
});

// The other half of the contract — that every infra unit's fleet_config names
// the repository, cluster, and daemon service this script discovers — is
// enforced for all units in test/cloud-agnostic.test.ts.
