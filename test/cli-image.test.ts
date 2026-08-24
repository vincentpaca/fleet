// Tests for the two-layer image model (#5): hash computation, tag derivation,
// and the rebuild/skip decision. All unit tests run without Docker.
//
// Docker tests build the real runner base image and exercise the hash-gated
// per-repo build cycle. They require a Docker daemon and the repo as the build
// context. Gate: FLEET_TEST_DOCKER=1.
//
//   FLEET_TEST_DOCKER=1 node --test test/cli-image.test.ts
//
// Full-loop test notes:
//   The runner in the container reaches the daemon over TCP. Docker Desktop
//   (macOS/Windows) provides host.docker.internal automatically; on Linux set:
//     FLEET_DOCKER_HOST_ADDR=172.17.0.1  (docker0 bridge default)
//   or ensure Docker 20.10+ (--add-host host.docker.internal:host-gateway).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  type ImageManifest,
} from '../src/cli/images.ts';

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

  // The harness is the least trusted code Fleet runs, so the container it runs
  // in must not be root. Asserted on the built image rather than by reading the
  // Dockerfile: a later `USER root`, a base-image change, or an ENTRYPOINT that
  // re-escalates would all pass a grep and fail here.
  test('the runner image runs as a non-root user that can still do the job', () => {
    const sh = (script: string): string =>
      execFileSync('docker', ['run', '--rm', '--entrypoint', 'sh', BASE_TAG, '-c', script], {
        encoding: 'utf8',
      }).trim();

    assert.equal(sh('id -u'), '1000', 'the runner must not run as root');

    // Non-root is worthless if it cannot work. These are the four things the
    // runner does before the harness produces a line: create the workspace,
    // clone into it, find its own entrypoint, and write its own home.
    assert.equal(
      sh('node -e "const f=require(\'node:fs\');f.mkdirSync(\'/workspace/.fleet/out\',{recursive:true});f.writeFileSync(\'/workspace/.fleet/out/probe\',\'ok\');console.log(\'ok\')"'),
      'ok',
      'the runner must be able to materialise FLEET_WORKSPACE',
    );
    assert.equal(sh('git init -q /workspace/repo && echo ok'), 'ok');
    assert.equal(sh('[ -w "$HOME" ] && echo ok'), 'ok', 'the harness writes config under $HOME');
    assert.equal(
      sh('node -e "console.log(require(\'node:fs\').existsSync(\'/opt/fleet/src/runner/main.ts\')?\'ok\':\'missing\')"'),
      'ok',
    );
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

  test('buildJobImage creates an inspectable local image; imageExistsLocally detects it', () => {
    const manifest: ImageManifest = {
      harness: { cli: TEST_CLI, cli_version: TEST_CLI_VER },
      setup: { image: 'node:22' },
    };
    const hash = computeImageHash(manifest);
    const tag = jobImageTag(hash);

    buildJobImage({ tag, baseTag: BASE_TAG, manifest, contextDir: repoRoot });
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

  // AC1: docker-provider job runs gate → fake harness → decision → answer → settle
  //
  // The fake harness is delivered as a synced file (.fleet/fake-harness.mjs)
  // so no shell-quoting of JSON is needed. FLEET_HARNESS_CMD points at it.
  // FLEET_SYNC_JSON carries the file to the container; materializeWorkspace()
  // in the runner writes it to /workspace before anything else runs.
  test('docker-provider job runs gate → fake harness → decision → answer → settle', async (t) => {
    const { FleetDaemon } = await import('../src/daemon/server.ts');
    const { DockerProvider } = await import('../src/providers/docker.ts');
    const { promisify } = await import('node:util');
    const { execFile } = await import('node:child_process');

    const runCmd = promisify(execFile);

    const manifest: ImageManifest = {
      harness: { cli: TEST_CLI, cli_version: TEST_CLI_VER },
      setup: { image: 'node:22' },
    };
    const hash = computeImageHash(manifest);
    const tag = jobImageTag(hash);

    // Host address reachable from inside the Docker container.
    const dockerHostAddr = process.env.FLEET_DOCKER_HOST_ADDR ?? 'host.docker.internal';

    const home = mkdtempSync(join(tmpdir(), 'fleet-docker-loop-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));

    // Wrap DockerProvider to:
    //  1. Swap 127.0.0.1 → dockerHostAddr in FLEET_DAEMON_URL so the container
    //     can reach the daemon on the host.
    //  2. Add --add-host host.docker.internal:host-gateway for Linux.
    const innerProvider = new DockerProvider({ defaultImage: tag });
    const provider = {
      name: 'docker',
      async launch(spec: Parameters<typeof innerProvider.launch>[0]) {
        const hostSpec = { ...spec, daemonUrl: spec.daemonUrl.replace('127.0.0.1', dockerHostAddr) };
        const args = innerProvider.buildRunArgs(hostSpec);
        // Insert host resolution before the image tag.
        const imageIdx = args.indexOf(tag);
        if (imageIdx < 0) throw new Error(`image tag ${tag} not found in docker run args`);
        args.splice(imageIdx, 0, '--add-host', 'host.docker.internal:host-gateway');
        const { stdout } = await runCmd('docker', args);
        const containerId = stdout.trim();
        if (!containerId) throw new Error('docker run returned no container id');
        return { handle: containerId };
      },
      terminate(handle: string) { return innerProvider.terminate(handle); },
    };

    const daemon = new FleetDaemon({
      home,
      // The provider satisfies the Provider interface structurally.
      provider: provider as unknown as Parameters<typeof FleetDaemon>[0]['provider'],
      port: 0,
      longPollMs: 15_000,
    });
    const { port } = await daemon.start();
    t.after(() => daemon.stop());
    assert.ok(port, 'daemon must bind a TCP port for container-to-host reachability');

    // The fake harness is injected as a synced file; FLEET_HARNESS_CMD points
    // at it. The runner's materializeWorkspace writes it to the workspace before
    // running the pickup gate.
    const fakeHarnessB64 = Buffer.from(FAKE_HARNESS_CONTENT).toString('base64');

    const created = await fetch(`http://127.0.0.1:${port}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workOrder: DOCKER_WORK_ORDER,
        manifest: DOCKER_TEST_MANIFEST,
        env: { FLEET_HARNESS_CMD: 'node /workspace/.fleet/fake-harness.mjs' },
        sync: { '.fleet/fake-harness.mjs': fakeHarnessB64 },
        image: tag,
      }),
    });
    // Read the body once. A template literal in an assertion message is
    // evaluated eagerly, so `${await created.text()}` consumed the body whether
    // the assertion passed or not and the next line threw "Body has already
    // been read" — meaning this test could never pass, and being gated behind
    // FLEET_TEST_DOCKER=1 meant nobody found out.
    const createdBody = await created.text();
    assert.equal(created.status, 201, `job creation failed: ${createdBody}`);
    const { job } = JSON.parse(createdBody) as { job: { id: string } };
    const jobId = job.id;

    t.after(() => {
      try { execFileSync('docker', ['rm', '-f', `fleet-${jobId}`], { stdio: 'ignore' }); } catch { /* best effort */ }
    });

    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const getState = async () => {
      const r = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}`);
      return ((await r.json()) as { job: { state: string } }).job.state;
    };
    const waitFor = async (pred: (s: string) => boolean, label: string, ms = 90_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const s = await getState();
        if (pred(s)) return s;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}; last state=${s}`);
        await delay(500);
      }
    };

    // The fake harness writes a decision file → runner posts decision event →
    // daemon transitions to blocked. Fails here if container cannot reach daemon
    // (wrong dockerHostAddr); the error message names the missing env var.
    await waitFor((s) => s === 'blocked', `blocked (container→${dockerHostAddr}:${port})`);

    // Operator answers.
    const ans = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ option: 'alpha' }),
    });
    assert.equal(ans.status, 200);

    // Runner delivers the answer file; harness continues; runner settles.
    await waitFor((s) => s === 'done', 'done');

    const final = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}`);
    const { job: finalJob } = (await final.json()) as { job: { settle: { rung: string } } };
    assert.equal(finalJob.settle?.rung, 'implemented');
  });

  test('clean up test images after suite', () => {
    for (const tag of cleanup) removeImage(tag);
  });
});
