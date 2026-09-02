// Tests for the two-layer image model (#5): hash computation, tag derivation,
// and the rebuild/skip decision. All unit tests run without Docker.
//
// Docker tests build the real runner base image and exercise the hash-gated
// per-repo build cycle. They require a Docker daemon and the repo as the build
// context. Gate: FLEET_TEST_DOCKER=1.
//
//   FLEET_TEST_DOCKER=1 node --test test/cli-image.test.ts
//
// Full-loop test notes: the runner in the container reaches the daemon over
// TCP. ./docker-loop.ts owns that wiring and documents the Linux caveat
// (FLEET_DOCKER_HOST_ADDR).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  computeImageHash,
  runnerBaseTag,
  jobImageTag,
  twoLayerEnabled,
  imageExistsLocally,
  buildJobImage,
  jobImageDockerfile,
  type ImageManifest,
} from '../src/cli/images.ts';
import { SETUP_BAKED_BASENAME } from '../src/shared/setup-marker.ts';
import { startDockerLoop } from './docker-loop.ts';

// ---------- fixtures ----------

const BASE_MANIFEST: ImageManifest = {
  harness: { cli: 'claude-code', cli_version: '1.2.3' },
  setup: { image: 'node:22' },
};

// ---------- twoLayerEnabled ----------

describe('twoLayerEnabled', () => {
  test('true when cli_version is set', () => {
    assert.ok(twoLayerEnabled({ harness: { cli: 'claude-code', cli_version: '1.2.3' } }));
  });

  test('false when cli_version is absent', () => {
    assert.ok(!twoLayerEnabled({ harness: { cli: 'claude-code' } }));
  });

  test('false when harness is absent', () => {
    assert.ok(!twoLayerEnabled({}));
  });

  test('false when cli_version is empty string', () => {
    assert.ok(!twoLayerEnabled({ harness: { cli_version: '' } }));
  });
});

// ---------- runnerBaseTag ----------

describe('runnerBaseTag', () => {
  test('derives tag from cli + cli_version', () => {
    assert.equal(
      runnerBaseTag({ harness: { cli: 'claude-code', cli_version: '1.2.3' } }),
      'fleet-runner:claude-code-1.2.3',
    );
  });

  test('defaults cli to claude-code and version to latest when absent', () => {
    assert.equal(runnerBaseTag({}), 'fleet-runner:claude-code-latest');
  });

});

// ---------- computeImageHash ----------

describe('computeImageHash', () => {
  test('is deterministic — same inputs produce the same hash', () => {
    const h1 = computeImageHash(BASE_MANIFEST);
    const h2 = computeImageHash(BASE_MANIFEST);
    assert.equal(h1, h2);
  });

  test('changes when cli_version changes', () => {
    const h1 = computeImageHash({ harness: { cli: 'claude-code', cli_version: '1.0.0' }, setup: { image: 'node:22' } });
    const h2 = computeImageHash({ harness: { cli: 'claude-code', cli_version: '2.0.0' }, setup: { image: 'node:22' } });
    assert.notEqual(h1, h2);
  });

  test('changes when cli changes', () => {
    const h1 = computeImageHash({ harness: { cli: 'claude-code', cli_version: '1.0.0' } });
    const h2 = computeImageHash({ harness: { cli: 'codex', cli_version: '1.0.0' } });
    assert.notEqual(h1, h2);
  });

  test('changes when setup script content changes', () => {
    const manifest: ImageManifest = { ...BASE_MANIFEST, setup: { script: '.fleet/setup.sh' } };
    const h1 = computeImageHash(manifest, () => 'npm ci\n');
    const h2 = computeImageHash(manifest, () => 'npm ci && npm run build\n');
    assert.notEqual(h1, h2);
  });

  test('stable when script content is unchanged', () => {
    const manifest: ImageManifest = { ...BASE_MANIFEST, setup: { script: '.fleet/setup.sh' } };
    const h1 = computeImageHash(manifest, () => 'npm ci\n');
    const h2 = computeImageHash(manifest, () => 'npm ci\n');
    assert.equal(h1, h2);
  });

  test('no-script manifest differs from with-script manifest', () => {
    const noScript = computeImageHash(BASE_MANIFEST, () => '');
    const withScript = computeImageHash(
      { ...BASE_MANIFEST, setup: { script: '.fleet/setup.sh' } },
      (p) => (p === '.fleet/setup.sh' ? 'apt-get install -y python3\n' : ''),
    );
    assert.notEqual(noScript, withScript);
  });

  test('setup.image does NOT affect the hash — runner base is the image in two-layer mode', () => {
    // Documented invariant: setup.image is intentionally excluded from hash inputs.
    // Changing it must not trigger a pointless rebuild.
    const base: ImageManifest = { harness: { cli: 'claude-code', cli_version: '1.2.3' } };
    const h1 = computeImageHash({ ...base, setup: { image: 'node:22' } });
    const h2 = computeImageHash({ ...base, setup: { image: 'node:24' } });
    const h3 = computeImageHash({ ...base });
    assert.equal(h1, h2, 'different setup.image values must produce the same hash');
    assert.equal(h1, h3, 'absent setup.image must produce the same hash as a present one');
  });

  test('changes when devcontainer content changes', () => {
    const manifest: ImageManifest = {
      ...BASE_MANIFEST,
      setup: { devcontainer: '.devcontainer/devcontainer.json' },
    };
    const h1 = computeImageHash(manifest, () => '{"image":"mcr.microsoft.com/devcontainers/base"}');
    const h2 = computeImageHash(manifest, () => '{"image":"mcr.microsoft.com/devcontainers/universal"}');
    assert.notEqual(h1, h2);
  });

  test('is exactly 16 hex characters', () => {
    const hash = computeImageHash(BASE_MANIFEST);
    assert.match(hash, /^[0-9a-f]{16}$/);
  });

  test('a moved base tag changes the hash even under identical tag text (#138)', () => {
    // The "latest" cache lie: fleet-runner:claude-code-latest is the same TEXT
    // before and after the tag moves to a rebuilt base. Hashing only the text
    // reuses every stale job image; the resolved image id is the identity.
    const manifest: ImageManifest = { harness: { cli: 'claude-code', cli_version: 'latest' } };
    const before = computeImageHash(manifest, undefined, () => 'sha256:aaaa');
    const after = computeImageHash(manifest, undefined, () => 'sha256:bbbb');
    assert.notEqual(before, after, 'a moved base tag must invalidate the job-image cache');
  });

  test('an unchanged base id keeps the hash stable (#138)', () => {
    const manifest: ImageManifest = { harness: { cli: 'claude-code', cli_version: 'latest' } };
    const h1 = computeImageHash(manifest, undefined, () => 'sha256:aaaa');
    const h2 = computeImageHash(manifest, undefined, () => 'sha256:aaaa');
    assert.equal(h1, h2);
  });

  test('an unresolvable base degrades to text-only hashing, deterministically (#138)', () => {
    // No docker / base not pulled: the hash must not throw and must stay
    // stable, and the missing id must not collide with an empty-string id
    // produced any other way than "unresolved".
    const manifest: ImageManifest = { harness: { cli: 'claude-code', cli_version: 'latest' } };
    const h1 = computeImageHash(manifest, undefined, () => undefined);
    const h2 = computeImageHash(manifest, undefined, () => undefined);
    assert.equal(h1, h2);
    assert.notEqual(h1, computeImageHash(manifest, undefined, () => 'sha256:aaaa'));
  });
});

// ---------- jobImageDockerfile (baked-setup marker, #49) ----------

describe('jobImageDockerfile', () => {
  test('setup.script mode runs the script and leaves the baked marker in the same layer', () => {
    const dockerfile = jobImageDockerfile('fleet-runner:claude-code-1.2.3', {
      harness: { cli: 'claude-code', cli_version: '1.2.3' },
      setup: { script: '.fleet/setup.sh' },
    });
    assert.match(dockerfile, /^FROM fleet-runner:claude-code-1\.2\.3\n/);
    assert.match(dockerfile, /COPY \.fleet\/setup\.sh \/tmp\/fleet-setup\.sh/);
    // The marker is what tells the runner NOT to run setup.script again before
    // the pickup gate (src/runner/setup.ts). Same RUN as the script: a build
    // where setup failed must not leave the marker behind.
    assert.match(
      dockerfile,
      new RegExp(`RUN sh /tmp/fleet-setup\\.sh && touch "\\$HOME/${SETUP_BAKED_BASENAME}"`),
    );
    // $HOME, never /etc: the runner resolves the marker before the privilege
    // drop (#196), so bake-time and check-time $HOME agree on every substrate —
    // including the process provider, where /etc was never writable.
    assert.ok(!dockerfile.includes('/etc/'), 'the marker must live under $HOME, not /etc');
  });

  test('no setup.script → plain base alias, and no marker', () => {
    const dockerfile = jobImageDockerfile('fleet-runner:claude-code-1.2.3', {
      harness: { cli: 'claude-code', cli_version: '1.2.3' },
      setup: { image: 'node:22' },
    });
    assert.equal(dockerfile, 'FROM fleet-runner:claude-code-1.2.3\n');
    assert.ok(!dockerfile.includes(SETUP_BAKED_BASENAME), 'an image that baked nothing must not claim it did');
  });
});

// ---------- imageExistsLocally ----------

test('imageExistsLocally returns false for a non-existent tag', () => {
  assert.equal(imageExistsLocally('fleet-job:does-not-exist-for-fleet-tests'), false);
});

// ---------- Docker integration (FLEET_TEST_DOCKER=1) ----------

const WITH_DOCKER = process.env.FLEET_TEST_DOCKER === '1';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Sentinel version string — does not collide with any real npm version tag.
const TEST_CLI = 'claude-code';
const TEST_CLI_VER = 'fleet-test-sentinel';
const BASE_TAG = `fleet-runner:${TEST_CLI}-${TEST_CLI_VER}`;
const DAEMON_TAG = 'fleet-daemon:fleet-test-sentinel';

// Fake harness delivered as a synced file into the workspace.
// Uses the decision-file convention (writes decision.json, reads answer-d1.json);
// the runner handles all daemon communication on the harness's behalf.
// Written as ESM (.mjs) so top-level await and import statements work.
const FAKE_HARNESS_CONTENT = `
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

// One stream-json line so the translate layer has something to process.
process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'docker fake harness running' }] },
}) + '\\n');

// Decision file: the runner's DecisionWatcher picks it up and posts the event.
writeFileSync(join(out, 'decision.json'), JSON.stringify({
  question: 'which path for the docker test?',
  options: [
    { id: 'alpha', label: 'Alpha path', recommended: true },
    { id: 'beta', label: 'Beta path' },
  ],
  who: 'engineer',
}));

// Wait for the answer file the runner writes after the decision is answered.
const answerPath = join(out, 'answer-d1.json');
const deadline = Date.now() + 60_000;
while (!existsSync(answerPath)) {
  if (Date.now() > deadline) {
    process.stderr.write('timed out waiting for answer\\n');
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 100));
}
const answer = JSON.parse(readFileSync(answerPath, 'utf8'));
process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'decided: ' + answer.option }] },
}) + '\\n');

// Report: the runner's settle step reads this.
writeFileSync(join(out, 'report.json'), JSON.stringify({
  status: 'READY',
  next_action: 'reviewed and complete',
  verification: ['docker-loop-test'],
  not_done: [],
}));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
`.trim();

// The manifest used inside the Docker container:
// - Pickup gate: always exits 0 (nothing to check in the empty workspace).
// - No git (FLEET_GIT_URL is not set).
// - FLEET_HARNESS_CMD overrides the harness (points at the synced fake harness).
const DOCKER_TEST_MANIFEST = {
  version: 1,
  setup: { image: 'node:22' },
  workspace: { repo: 'git@github.com:fleet-test/webapp.git', strategy: 'branch-per-job' },
  harness: {
    cli: 'claude-code',
    commands: [{ path: '.claude/commands/dev.md', critic: 'code-reviewer' }],
  },
  gates: { pickup: 'node -e "process.exit(0)"' },
};

const DOCKER_WORK_ORDER = {
  mode: 'implement',
  target: 'docker-loop-test',
  finish: 'implemented',
  authority: { publish: false },
  report: 'status-first',
};

describe('Docker integration', { skip: !WITH_DOCKER ? 'set FLEET_TEST_DOCKER=1 to run' : false }, () => {
  const cleanup: string[] = [];
  const removeImage = (tag: string) => {
    try { execFileSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' }); } catch { /* best effort */ }
  };

  // AC1: runner base image builds
  test('runner Dockerfile builds with HARNESS_CLI=claude-code', () => {
    execFileSync(
      'docker',
      [
        'build',
        '--build-arg', `HARNESS_CLI=${TEST_CLI}`,
        '--build-arg', 'HARNESS_VERSION=latest',
        '-t', BASE_TAG,
        '-f', join('images', 'runner', 'Dockerfile'),
        '.',
      ],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    cleanup.push(BASE_TAG);
  });

  // Privilege contract (#196): the container starts as root so the
  // operator-authored setup.script can install system packages, and the runner
  // drops to uid 1000 before the gate/harness/settle. The agent-never-root
  // guarantee therefore no longer lives in the image USER — it is pinned on
  // live jobs below ('one-layer setup.script runs as root …' asserts `id -u`
  // from inside the harness). What the image itself must guarantee: the boot
  // user is root (or one-layer setup cannot install anything), root can do git
  // work in the workspace it boots with (#218), and the dropped identity can
  // still do the job after the drop's chown.
  test('the runner image boots as root for setup, and uid 1000 can still do the job', () => {
    const sh = (script: string, opts: { user?: string; env?: Record<string, string> } = {}): string =>
      execFileSync(
        'docker',
        [
          'run', '--rm',
          ...(opts.user !== undefined ? ['--user', opts.user] : []),
          ...Object.entries(opts.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
          '--entrypoint', 'sh', BASE_TAG, '-c', script,
        ],
        { encoding: 'utf8' },
      ).trim();

    assert.equal(sh('id -u'), '0', 'the boot user must be root: one-layer setup.script installs system packages before the drop');

    // Root phase (#218): with a setup.script declared the runner is still root
    // through the clone, and git refuses a repository inside a directory
    // another uid owns (CVE-2022-24765 "dubious ownership"). The pre-#218
    // image chowned /workspace to node and every git-wired dispatch died at
    // `git config user.name` — this probe is that dispatch's first two moves.
    assert.equal(
      sh('cd /workspace && git init -q . && git config user.name probe && echo ok'),
      'ok',
      'root-phase git must work in FLEET_WORKSPACE: the clone precedes the drop when setup.script is declared',
    );

    // Post-drop phase: dropPrivileges chowns -R the workspace to the job user
    // before uid 1000 runs anything — mirrored here with setpriv, since each
    // probe is its own container. These are the four things the job does after
    // the drop: write the workspace, clone into it, find the runner's
    // entrypoint, and write the harness home.
    const dropped = (probe: string): string =>
      sh('chown -R 1000:1000 /workspace && exec setpriv --reuid=1000 --regid=1000 --clear-groups sh -c "$FLEET_TEST_PROBE"', {
        env: { FLEET_TEST_PROBE: probe },
      });
    assert.equal(
      dropped('node -e "const f=require(\'node:fs\');f.mkdirSync(\'/workspace/.fleet/out\',{recursive:true});f.writeFileSync(\'/workspace/.fleet/out/probe\',\'ok\');console.log(\'ok\')"'),
      'ok',
      'the dropped user must be able to write FLEET_WORKSPACE after the drop chowns it',
    );
    assert.equal(dropped('git init -q /workspace/repo && echo ok'), 'ok');
    assert.equal(sh('[ -w /home/node ] && echo ok', { user: '1000' }), 'ok', 'the harness writes config under the dropped user home');
    assert.equal(
      sh('node -e "console.log(require(\'node:fs\').existsSync(\'/opt/fleet/src/runner/main.ts\')?\'ok\':\'missing\')"', { user: '1000' }),
      'ok',
    );
  });

  // The daemon image dropped root in #156, after the runner did in #155. Same
  // discipline: asserted on the built image, not by grepping the Dockerfile —
  // a later `USER root`, a base-image change, or an entrypoint that
  // re-escalates would all pass a grep and fail here.
  test('the daemon image runs as a non-root user that can still do the job', () => {
    execFileSync(
      'docker',
      ['build', '-t', DAEMON_TAG, '-f', join('images', 'daemon', 'Dockerfile'), '.'],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    cleanup.push(DAEMON_TAG);

    const sh = (script: string): string =>
      execFileSync('docker', ['run', '--rm', '--entrypoint', 'sh', DAEMON_TAG, '-c', script], {
        encoding: 'utf8',
      }).trim();

    assert.equal(sh('id -u'), '1000', 'the daemon must not run as root');

    // Non-root is worthless if it cannot work. The daemon's job before it
    // answers a request: write $FLEET_HOME (jobs, journals, daemon.lock — in a
    // deployment the EFS access point makes the mount writable at uid 1000;
    // this image-level stand-in proves the process side of that pact), find
    // its own entrypoint, and run the AWS CLI the EcsProvider shells out to.
    assert.equal(
      sh('node -e "const f=require(\'node:fs\');f.mkdirSync(process.env.HOME+\'/fleet-home/jobs\',{recursive:true});f.writeFileSync(process.env.HOME+\'/fleet-home/daemon.lock\',\'probe\');console.log(\'ok\')"'),
      'ok',
      'the daemon must be able to write a FLEET_HOME it owns',
    );
    assert.equal(
      sh('node -e "console.log(require(\'node:fs\').existsSync(\'/opt/fleet/src/daemon/main.ts\')?\'ok\':\'missing\')"'),
      'ok',
    );
    assert.match(sh('aws --version 2>&1'), /aws-cli/, 'EcsProvider shells out to aws as uid 1000');
  });

  // Build stamp (#207): the Dockerfiles must persist FLEET_BUILD_SHA into the
  // image environment, where the daemon's /health and the runner's job-start
  // log read it. Asserted on built images, not by grepping the Dockerfiles —
  // an ARG that is declared but never ENV'd would pass a grep and fail here.
  // Cheap: every layer below the stamp is already cached by the builds above.
  test('both images persist the build stamp where the process can read it (#207)', () => {
    const probe = 'feedfacefeedfacefeedfacefeedfacefeedface';
    for (const [tag, dockerfile] of [
      [`${BASE_TAG}-stamped`, join('images', 'runner', 'Dockerfile')],
      [`${DAEMON_TAG}-stamped`, join('images', 'daemon', 'Dockerfile')],
    ] as const) {
      execFileSync(
        'docker',
        [
          'build',
          '--build-arg', `FLEET_BUILD_SHA=${probe}`,
          ...(tag.startsWith('fleet-runner') ? ['--build-arg', `HARNESS_CLI=${TEST_CLI}`, '--build-arg', 'HARNESS_VERSION=latest'] : []),
          '-t', tag, '-f', dockerfile, '.',
        ],
        { cwd: repoRoot, stdio: 'inherit' },
      );
      cleanup.push(tag);
      const seen = execFileSync(
        'docker',
        ['run', '--rm', '--entrypoint', 'sh', tag, '-c', 'printf %s "$FLEET_BUILD_SHA"'],
        { encoding: 'utf8' },
      );
      assert.equal(seen, probe, `${tag} does not carry the stamp`);
    }
  });

  // AC3: no secrets baked into any image layer
  test('docker history contains no baked-in secret values', () => {
    const history = execFileSync(
      'docker',
      ['history', '--no-trunc', '--format', '{{.CreatedBy}}', BASE_TAG],
      { encoding: 'utf8' },
    );
    // A baked-in secret appears as an assignment with a non-variable value.
    const SECRET_PATTERNS = [
      /ANTHROPIC_API_KEY\s*=\s*[^$\s]/,
      /AWS_SECRET_ACCESS_KEY\s*=\s*[^$\s]/,
      /GITHUB_TOKEN\s*=\s*[^$\s]/i,
    ];
    for (const pattern of SECRET_PATTERNS) {
      assert.ok(!pattern.test(history), `layer matches secret pattern: ${pattern}`);
    }
  });

  test('buildJobImage creates an inspectable local image; imageExistsLocally detects it', async () => {
    const manifest: ImageManifest = {
      harness: { cli: TEST_CLI, cli_version: TEST_CLI_VER },
      setup: { image: 'node:22' },
    };
    const hash = computeImageHash(manifest);
    const tag = jobImageTag(hash);

    await buildJobImage({ tag, baseTag: BASE_TAG, manifest, contextDir: repoRoot });
    cleanup.push(tag);

    assert.ok(imageExistsLocally(tag), `image not found after build: ${tag}`);
    assert.ok(imageExistsLocally(tag)); // idempotent
  });

  // AC1: runner entrypoint is functional inside the container
  test('runner entrypoint starts and emits output inside the job image (smoke)', () => {
    const manifest: ImageManifest = {
      harness: { cli: TEST_CLI, cli_version: TEST_CLI_VER },
      setup: { image: 'node:22' },
    };
    const hash = computeImageHash(manifest);
    const tag = jobImageTag(hash);

    // Unreachable daemon — runner exits non-zero but must emit something first,
    // proving node, source files, and node_modules are all in the image.
    const result = spawnSync('docker', [
      'run', '--rm',
      '-e', 'FLEET_JOB_ID=smoke-001',
      '-e', 'FLEET_DAEMON_URL=http://127.0.0.1:1',
      '-e', 'FLEET_RUNNER_TOKEN=tok-smoke',
      '-e', 'FLEET_WORKSPACE=/workspace',
      tag,
    ], { encoding: 'utf8' });

    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    assert.ok(
      combined.length > 0,
      `runner produced no output — entrypoint or node_modules may be broken\nstdout:${result.stdout}\nstderr:${result.stderr}`,
    );
  });

  // The docker-loop scaffolding (daemon on a TCP port + a DockerProvider
  // wrapped for container-to-host reachability) lives in ./docker-loop.ts —
  // the foreign-repo end-to-end (#224) runs on the same substrate.

  // AC1: docker-provider job runs gate → fake harness → decision → answer → settle
  //
  // The fake harness is delivered as a synced file (.fleet/fake-harness.mjs)
  // so no shell-quoting of JSON is needed. FLEET_HARNESS_CMD points at it.
  // FLEET_SYNC_JSON carries the file to the container; materializeWorkspace()
  // in the runner writes it to /workspace before anything else runs.
  test('docker-provider job runs gate → fake harness → decision → answer → settle', async (t) => {
    const manifest: ImageManifest = {
      harness: { cli: TEST_CLI, cli_version: TEST_CLI_VER },
      setup: { image: 'node:22' },
    };
    const hash = computeImageHash(manifest);
    const tag = jobImageTag(hash);

    const loop = await startDockerLoop(t, tag);

    // The fake harness is injected as a synced file; FLEET_HARNESS_CMD points
    // at it. The runner's materializeWorkspace writes it to the workspace before
    // running the pickup gate.
    const jobId = await loop.postJob({
      workOrder: DOCKER_WORK_ORDER,
      manifest: DOCKER_TEST_MANIFEST,
      env: { FLEET_HARNESS_CMD: 'node /workspace/.fleet/fake-harness.mjs' },
      sync: { '.fleet/fake-harness.mjs': Buffer.from(FAKE_HARNESS_CONTENT).toString('base64') },
      image: tag,
    });

    // The fake harness writes a decision file → runner posts decision event →
    // daemon transitions to blocked. Fails here if container cannot reach daemon
    // (wrong dockerHostAddr); the error message names the missing env var.
    await loop.waitFor(jobId, (s) => s === 'blocked', `blocked (container→${loop.dockerHostAddr}:${loop.port})`);

    // Operator answers.
    const ans = await fetch(`http://127.0.0.1:${loop.port}/jobs/${jobId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ option: 'alpha' }),
    });
    assert.equal(ans.status, 200);

    // Runner delivers the answer file; harness continues; runner settles.
    await loop.waitFor(jobId, (s) => s === 'done', 'done');

    const final = await fetch(`http://127.0.0.1:${loop.port}/jobs/${jobId}`);
    const { job: finalJob } = (await final.json()) as { job: { settle: { rung: string } } };
    assert.equal(finalJob.settle?.rung, 'implemented');
  });

  // ---------- privilege drop (#196) ----------
  //
  // Trust follows authorship: the container starts as root, the
  // operator-authored setup.script runs with it, and the runner drops to uid
  // 1000 before the gate/harness/settle. These run one-layer jobs against the
  // pinned runner base (no baked marker), which is exactly the substrate the
  // issue names: prerequisites that need apt cannot install as uid 1000.

  // #196 (a)+(b): a setup.script that apt-installs python3 succeeds, python3
  // works from the harness afterward, setup observed uid 0, and the harness
  // observes uid 1000. Pre-fix failure: apt-get exits non-zero as uid 1000 →
  // the job cancels with reason setup-script and never reaches done.
  test('one-layer setup.script runs as root (apt-get works); the harness runs as uid 1000', async (t) => {
    const loop = await startDockerLoop(t, BASE_TAG);

    const setupScript = [
      'id -u > setup-uid.txt',
      'apt-get update -qq',
      'apt-get install -y -qq python3',
    ].join('\n') + '\n';

    // The harness carries the assertions: it exits 3 (job never reaches done)
    // unless setup ran as root, python3 is installed, and its own uid is 1000.
    const uidHarness = `
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });
const setupUid = readFileSync('setup-uid.txt', 'utf8').trim();
const jobUid = execSync('id -u', { encoding: 'utf8' }).trim();
const python = execSync('python3 --version', { encoding: 'utf8' }).trim();
process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'setup-uid=' + setupUid + ' job-uid=' + jobUid + ' python=' + python }] },
}) + '\\n');
if (setupUid !== '0' || jobUid !== '1000' || !/^Python 3/.test(python)) process.exit(3);
writeFileSync(join(out, 'report.json'), JSON.stringify({
  status: 'READY',
  next_action: 'reviewed and complete',
  verification: ['setup-uid=' + setupUid, 'job-uid=' + jobUid, python],
  not_done: [],
}));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
`.trim();

    const jobId = await loop.postJob({
      workOrder: DOCKER_WORK_ORDER,
      manifest: {
        ...DOCKER_TEST_MANIFEST,
        setup: { image: 'node:22', script: '.fleet/setup.sh' },
        // The gate runs post-drop: uid 1000 or the job never starts.
        gates: { pickup: 'test "$(id -u)" = "1000"' },
      },
      env: { FLEET_HARNESS_CMD: 'node /workspace/.fleet/uid-harness.mjs' },
      sync: {
        '.fleet/setup.sh': Buffer.from(setupScript).toString('base64'),
        '.fleet/uid-harness.mjs': Buffer.from(uidHarness).toString('base64'),
      },
      image: BASE_TAG,
    });

    // apt-get update+install needs a real budget; a failing harness exits 3
    // and lands on cancelled, so wait for either terminal state.
    const finalState = await loop.waitFor(
      jobId,
      (s) => s === 'done' || s === 'cancelled',
      'a terminal state (setup installs python3, harness asserts uids)',
      300_000,
    );
    const texts = (await loop.events(jobId))
      .filter((e) => typeof e.text === 'string')
      .map((e) => String(e.text));
    assert.equal(finalState, 'done', `job did not settle clean; events: ${texts.join(' | ')}`);

    // Ordering: setup (root) → drop → gate. Root must end where setup ends.
    const setupAt = texts.findIndex((x) => /^setup script \.fleet\/setup\.sh ok \(\d+s\)$/.test(x));
    const dropAt = texts.findIndex((x) => x === 'privileges dropped: job continues as uid 1000');
    const gateAt = texts.findIndex((x) => x.startsWith('pickup gate:'));
    assert.ok(setupAt >= 0, `no setup outcome in: ${texts.join(' | ')}`);
    assert.ok(dropAt > setupAt, 'the drop must come after setup — root belongs to setup');
    assert.ok(gateAt > dropAt, 'the gate must run only after the drop');
  });

  // #196 (c): a manifest with no setup.script never runs anything as root
  // beyond the immediate drop. The gate (the first observable job-side code)
  // asserts both the uid and that root handed over everything it materialised;
  // the event log pins the drop as the runner's first act.
  test('no setup.script → the drop is immediate and nothing else runs as root', async (t) => {
    const loop = await startDockerLoop(t, BASE_TAG);

    const doneHarness = `
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'report.json'), JSON.stringify({
  status: 'READY',
  next_action: 'reviewed and complete',
  verification: ['no-setup-drop-test'],
  not_done: [],
}));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
`.trim();

    const jobId = await loop.postJob({
      workOrder: DOCKER_WORK_ORDER,
      manifest: {
        ...DOCKER_TEST_MANIFEST,
        // setup.image only — no script, so no root work is coming at all.
        // The gate proves the drop already happened AND that the files root
        // materialised (manifest.json) were handed to the job user.
        gates: { pickup: 'test "$(id -u)" = "1000" && test "$(stat -c %u .fleet/manifest.json)" = "1000"' },
      },
      env: { FLEET_HARNESS_CMD: 'node /workspace/.fleet/done-harness.mjs' },
      sync: { '.fleet/done-harness.mjs': Buffer.from(doneHarness).toString('base64') },
      image: BASE_TAG,
    });

    const finalState = await loop.waitFor(jobId, (s) => s === 'done' || s === 'cancelled', 'a terminal state', 180_000);
    const texts = (await loop.events(jobId))
      .filter((e) => typeof e.text === 'string')
      .map((e) => String(e.text));
    assert.equal(finalState, 'done', `job did not settle clean; events: ${texts.join(' | ')}`);

    const logs = (await loop.events(jobId))
      .filter((e) => e.type === 'log')
      .map((e) => String(e.text));
    assert.equal(
      logs[0],
      'privileges dropped: job continues as uid 1000',
      `the drop must be the runner's first act when no setup is declared; logs: ${logs.join(' | ')}`,
    );
    assert.ok(!logs.some((x) => x.startsWith('setup script:')), 'no setup announce for a script-less manifest');
  });

  // #218: the whole git lifecycle on a live one-layer job. Every earlier live
  // job ran with FLEET_GIT_URL unset, which is exactly how the pre-#218 image
  // shipped broken: no test ever cloned on the real image, and the ownership
  // bug lived in the clone. This one covers the full sequence the privilege
  // contract promises: root clones and pushes the claim branch (setup.script
  // declared), the operator script runs git as root in the clone, the drop
  // hands the checkout to uid 1000, and the settle commits and pushes as the
  // job user. The remote is a bare repo on the host, bind-mounted in;
  // --shared=0666 because two container uids (0, then 1000) write objects
  // into it, and safe.directory covers only the mount — /workspace itself
  // stays under test.
  test('git-wired one-layer job: root clones and pushes, uid 1000 settles and delivers', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-git-loop-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bare = join(dir, 'remote.git');
    const seed = join(dir, 'seed');
    execFileSync('git', ['init', '-q', '--bare', '--shared=0666', '-b', 'main', bare]);
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, 'README.md'), 'seed\n');
    const g = (args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args], { cwd: seed, encoding: 'utf8' });
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'seed']);
    g(['push', '-q', bare, 'main']);
    // The container reads and writes this tree as uids the host never heard
    // of; the mount does not remap them.
    execFileSync('chmod', ['-R', 'a+rwX', dir]);

    const loop = await startDockerLoop(t, BASE_TAG, ['-v', `${bare}:/remote.git`]);

    // The operator-authored script does its own git work as root — real setup
    // scripts do — so root-phase git is pinned beyond the runner's own calls.
    const setupScript = 'git log -1 --format=%s > setup-git-head.txt\n';

    // The harness carries the in-container assertions: it exits 3 (job never
    // reaches done) unless the root-phase script saw the seeded history and
    // the checkout is on the job branch. Then it leaves work for the settle
    // push to deliver.
    const gitHarness = `
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });
const head = readFileSync('setup-git-head.txt', 'utf8').trim();
const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
writeFileSync('work.txt', 'delivered by uid ' + execSync('id -u', { encoding: 'utf8' }).trim() + '\\n');
process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'head=' + head + ' branch=' + branch }] },
}) + '\\n');
if (head !== 'seed' || !branch.startsWith('fleet/')) process.exit(3);
writeFileSync(join(out, 'report.json'), JSON.stringify({
  status: 'READY',
  next_action: 'reviewed and complete',
  verification: ['branch=' + branch],
  not_done: [],
}));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
`.trim();

    const jobId = await loop.postJob({
      workOrder: { ...DOCKER_WORK_ORDER, target: 'git-loop' },
      manifest: {
        ...DOCKER_TEST_MANIFEST,
        setup: { image: 'node:22', script: '.fleet/setup.sh' },
        gates: { pickup: 'test "$(id -u)" = "1000"' },
      },
      env: {
        FLEET_HARNESS_CMD: 'node /workspace/.fleet/git-harness.mjs',
        FLEET_GIT_URL: 'file:///remote.git',
        // A name with a space: the #218 dispatches died at exactly
        // `git config user.name` with one.
        FLEET_GIT_NAME: 'Operator One',
        FLEET_GIT_EMAIL: 'op@example.com',
        // The mount is owned by a uid the container never heard of, and git
        // honors safe.directory only from protected (system/global) config —
        // GIT_CONFIG_* env and -c are deliberately ignored for it, which CI
        // proved. GIT_CONFIG_GLOBAL promotes the synced file below to global
        // scope. It names only the mounted remote: /workspace ownership is
        // the thing under test and must never be whitelisted here.
        GIT_CONFIG_GLOBAL: '/workspace/.fleet/test-gitconfig',
      },
      sync: {
        '.fleet/setup.sh': Buffer.from(setupScript).toString('base64'),
        '.fleet/git-harness.mjs': Buffer.from(gitHarness).toString('base64'),
        '.fleet/test-gitconfig': Buffer.from('[safe]\n\tdirectory = /remote.git\n').toString('base64'),
      },
      image: BASE_TAG,
    });

    const finalState = await loop.waitFor(jobId, (s) => s === 'done' || s === 'cancelled', 'a terminal state (clone → setup → drop → settle push)', 180_000);
    const texts = (await loop.events(jobId))
      .filter((e) => typeof e.text === 'string')
      .map((e) => String(e.text));
    // The settle report (not the text events) is where a workspace-git failure
    // names itself — an unstamped local build logs nothing before the clone.
    const record = await (await fetch(`http://127.0.0.1:${loop.port}/jobs/${jobId}`)).text();
    assert.equal(finalState, 'done', `job did not settle clean; job: ${record}; events: ${texts.join(' | ')}`);

    const branch = `fleet/git-loop-${jobId}`;
    assert.ok(
      texts.includes(`workspace on branch ${branch} (pushed)`),
      `claim branch was not pushed at setup; events: ${texts.join(' | ')}`,
    );

    // The delivery is judged on the host-side remote, not on job events: the
    // settle push (uid 1000) must have landed the work commit, authored as
    // the identity the dispatch carried.
    const remoteGit = (args: string[]) => execFileSync('git', ['-C', bare, ...args], { encoding: 'utf8' }).trim();
    assert.equal(remoteGit(['show', `${branch}:work.txt`]), 'delivered by uid 1000');
    assert.equal(remoteGit(['show', `${branch}:setup-git-head.txt`]), 'seed', 'the root-phase setup script output must be part of the delivered work');
    assert.equal(remoteGit(['log', '-1', '--format=%an', branch]), 'Operator One');
  });

  test('clean up test images after suite', () => {
    for (const tag of cleanup) removeImage(tag);
  });
});
