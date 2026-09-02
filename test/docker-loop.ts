// Shared scaffolding for live Docker-provider loops (not a test file: no .test
// suffix, and export-only — test/helper-hygiene.test.ts enforces that).
//
// A daemon on a TCP port + DockerProvider wrapped to:
//  1. Swap 127.0.0.1 → dockerHostAddr in FLEET_DAEMON_URL so the container
//     can reach the daemon on the host.
//  2. Add --add-host host.docker.internal:host-gateway for Linux.
//
// Extracted from test/cli-image.test.ts when the foreign-repo end-to-end
// (#224) needed the same substrate: one daemon+provider wiring, not two.
//
// Container-to-host reachability notes:
//   Docker Desktop (macOS/Windows) provides host.docker.internal automatically;
//   on Linux set FLEET_DOCKER_HOST_ADDR=172.17.0.1 (docker0 bridge default) or
//   ensure Docker 20.10+ (--add-host host.docker.internal:host-gateway).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One line of a job's event log as the daemon stamped it. `type` and `text`
 * are named because every consumer reads them; the index signature keeps the
 * rest (settle's `report`/`outcome`, decision options) reachable with a cast
 * rather than a second parse.
 */
export type LoopEvent = { type: string; text?: string; [key: string]: unknown };

export type LoopHandle = {
  port: number;
  dockerHostAddr: string;
  /** POST /jobs; asserts 201, registers container cleanup, returns the job id. */
  postJob(body: Record<string, unknown>): Promise<string>;
  /** Poll GET /jobs/:id until pred(state); throws with the last state on timeout. */
  waitFor(jobId: string, pred: (s: string) => boolean, label: string, ms?: number): Promise<string>;
  /** All events for the job (NDJSON endpoint), parsed, in daemon-seq order. */
  events(jobId: string): Promise<LoopEvent[]>;
};

/**
 * `docker rm -f fleet-<jobId>` — best effort, so no container outlives the
 * test that launched it. Named because both dispatch routes need it: the
 * postJob below, and a test that dispatches through the CLI instead.
 */
export function removeJobContainer(jobId: string): void {
  try {
    execFileSync('docker', ['rm', '-f', `fleet-${jobId}`], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}

export async function startDockerLoop(t: { after(fn: () => void): void }, image: string, extraRunArgs: string[] = []): Promise<LoopHandle> {
  const { FleetDaemon } = await import('../src/daemon/server.ts');
  const { DockerProvider } = await import('../src/providers/docker.ts');
  const { writeSecretTempFile } = await import('../src/providers/provider.ts');
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const runCmd = promisify(execFile);

  // Host address reachable from inside the Docker container.
  const dockerHostAddr = process.env.FLEET_DOCKER_HOST_ADDR ?? 'host.docker.internal';

  const home = mkdtempSync(join(tmpdir(), 'fleet-docker-loop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const innerProvider = new DockerProvider({ defaultImage: image });
  const provider = {
    name: 'docker',
    async launch(spec: Parameters<typeof innerProvider.launch>[0]) {
      const hostSpec = { ...spec, daemonUrl: spec.daemonUrl.replace('127.0.0.1', dockerHostAddr) };
      // Env rides a 0600 temp file, never argv (#126) — same as the real launch().
      const envFile = writeSecretTempFile('fleet-env-', innerProvider.envFileContents(hostSpec));
      try {
        const args = innerProvider.buildRunArgs(hostSpec, envFile.path);
        // Insert host resolution before the image tag.
        const imageRef = (hostSpec as { image?: string }).image ?? image;
        const imageIdx = args.indexOf(imageRef);
        if (imageIdx < 0) throw new Error(`image tag ${imageRef} not found in docker run args`);
        args.splice(imageIdx, 0, '--add-host', 'host.docker.internal:host-gateway', ...extraRunArgs);
        const { stdout } = await runCmd('docker', args);
        const containerId = stdout.trim();
        if (!containerId) throw new Error('docker run returned no container id');
        return { handle: containerId };
      } finally {
        envFile.cleanup();
      }
    },
    terminate(handle: string) { return innerProvider.terminate(handle); },
  };

  const daemon = new FleetDaemon({
    home,
    // The provider satisfies the Provider interface structurally.
    provider: provider as unknown as Parameters<typeof FleetDaemon>[0]['provider'],
    port: 0,
    // 0.0.0.0, not the 127.0.0.1 default: on Linux the container reaches
    // the host at the docker bridge IP (host-gateway), where a
    // loopback-bound listener does not exist — every live-loop test here
    // sat at `queued` on CI while passing on Docker Desktop, whose
    // host.docker.internal routes into the host's loopback instead.
    // Ephemeral port, test-lifetime only. tcpHost keeps the ADVERTISED
    // url at 127.0.0.1 (it defaults to bindHost), because the wrapper
    // above rewrites exactly that into the container-reachable address.
    // '::' rather than '0.0.0.0': dual-stack, so the listener answers on IPv6
    // as well. `--add-host host.docker.internal:host-gateway` writes BOTH an
    // A and an AAAA record into the container's /etc/hosts (192.168.65.254 and
    // fdc4:f303:9324::254 on Docker Desktop), so whichever address the
    // container's resolver hands its client is the one that must answer. An
    // IPv4-only listener leaves the AAAA half of that pair connecting to
    // nothing, which presents as an intermittent hang rather than a refusal —
    // and a hang here means the job never reports in and sits at `queued`.
    // Node treats '::' as dual-stack unless ipv6Only is set, so this is
    // strictly more permissive than '0.0.0.0'.
    bindHost: '::',
    tcpHost: '127.0.0.1',
    longPollMs: 15_000,
  });
  const { port } = await daemon.start();
  t.after(() => daemon.stop());
  assert.ok(port, 'daemon must bind a TCP port for container-to-host reachability');

  const postJob = async (body: Record<string, unknown>): Promise<string> => {
    const created = await fetch(`http://127.0.0.1:${port}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Read the body once. A template literal in an assertion message is
    // evaluated eagerly, so `${await created.text()}` consumed the body whether
    // the assertion passed or not and the next line threw "Body has already
    // been read" — meaning this test could never pass, and being gated behind
    // FLEET_TEST_DOCKER=1 meant nobody found out.
    const createdBody = await created.text();
    assert.equal(created.status, 201, `job creation failed: ${createdBody}`);
    const { job } = JSON.parse(createdBody) as { job: { id: string } };
    t.after(() => removeJobContainer(job.id));
    return job.id;
  };

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const waitFor = async (jobId: string, pred: (s: string) => boolean, label: string, ms = 90_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}`);
      const s = ((await r.json()) as { job: { state: string } }).job.state;
      if (pred(s)) return s;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}; last state=${s}`);
      await delay(500);
    }
  };

  const events = async (jobId: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}/events`);
    const body = await r.text();
    return body
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as LoopEvent);
  };

  return { port, dockerHostAddr, postJob, waitFor, events };
}
