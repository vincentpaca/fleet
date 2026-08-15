import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerProvider } from "../src/providers/docker.ts";
import { EcsProvider, ecsConfigFromEnv } from "../src/providers/ecs.ts";
import { ProcessProvider, prepareWorkspace } from "../src/providers/process.ts";
import type { LaunchSpec } from "../src/providers/provider.ts";
import { FleetDaemon } from "../src/daemon/server.ts";
import { parseNdjson } from "../src/shared/ndjson.ts";
import { MANIFEST, WORK_ORDER, op, tempHome, until } from "./daemon-helpers.ts";

const SPEC: LaunchSpec = {
  jobId: "job-abc123",
  daemonUrl: "http://127.0.0.1:4646",
  runnerToken: "tok-0123456789abcdef",
  image: "ghcr.io/acme/fleet-runner:1",
  env: { EXAMPLE_TOKEN: "abc" },
  sync: { ".env.development": Buffer.from("A=1\n").toString("base64") },
  manifest: MANIFEST,
  workOrder: WORK_ORDER,
};

test("DockerProvider builds a docker run command with env-injected config", () => {
  const provider = new DockerProvider();
  const args = provider.buildRunArgs(SPEC);

  assert.deepEqual(args.slice(0, 2), ["run", "-d"]);
  assert.ok(args.includes("--name") && args.includes("fleet-job-abc123"));
  assert.ok(args.includes(`fleet.job=${SPEC.jobId}`));

  // Env pairs: every FLEET_* injected, workspace fixed inside the container.
  const envPairs = args.filter((_, i) => args[i - 1] === "-e");
  assert.ok(envPairs.includes(`FLEET_JOB_ID=${SPEC.jobId}`));
  assert.ok(envPairs.includes(`FLEET_DAEMON_URL=${SPEC.daemonUrl}`));
  assert.ok(envPairs.includes(`FLEET_RUNNER_TOKEN=${SPEC.runnerToken}`));
  assert.ok(envPairs.includes("FLEET_WORKSPACE=/workspace"));
  assert.ok(envPairs.includes("EXAMPLE_TOKEN=abc"));

  // Manifest and sync travel base64-encoded.
  const manifestPair = envPairs.find((pair) => pair.startsWith("FLEET_MANIFEST_JSON="));
  assert.ok(manifestPair);
  const decoded = JSON.parse(Buffer.from(manifestPair.split("=")[1], "base64").toString());
  assert.deepEqual(decoded, MANIFEST);
  assert.ok(envPairs.some((pair) => pair.startsWith("FLEET_SYNC_JSON=")));

  // Image then runner command, at the end.
  const imageIdx = args.indexOf("ghcr.io/acme/fleet-runner:1");
  assert.ok(imageIdx > 0);
  assert.deepEqual(args.slice(imageIdx + 1), ["node", "/opt/fleet/src/runner/main.ts"]);

  // No mounts, ever.
  assert.ok(!args.includes("-v") && !args.includes("--mount"));
});

test("DockerProvider falls back to the default image when the spec has none", () => {
  const provider = new DockerProvider({ defaultImage: "node:22" });
  const args = provider.buildRunArgs({ ...SPEC, image: undefined });
  assert.ok(args.includes("node:22"));
});

test("ecsConfigFromEnv reads FLEET_ECS_* and names missing required vars", () => {
  assert.throws(() => ecsConfigFromEnv({}), /FLEET_ECS_CLUSTER/);
  const config = ecsConfigFromEnv({
    FLEET_ECS_CLUSTER: "fleet-cluster",
    FLEET_ECS_TASK_DEF: "fleet-runner:3",
    FLEET_ECS_CONTAINER: "runner",
    FLEET_ECS_SUBNETS: "subnet-aaa, subnet-bbb",
    FLEET_ECS_SECURITY_GROUPS: "sg-ccc",
  });
  assert.equal(config.cluster, "fleet-cluster");
  assert.equal(config.taskDefinition, "fleet-runner:3");
  assert.equal(config.containerName, "runner");
  assert.deepEqual(config.subnets, ["subnet-aaa", "subnet-bbb"]);
  assert.deepEqual(config.securityGroups, ["sg-ccc"]);
  assert.equal(config.launchType, "EC2");
  assert.equal(config.assignPublicIp, "DISABLED");
});

test("EcsProvider builds an aws ecs run-task command with env overrides", () => {
  const provider = new EcsProvider({
    cluster: "fleet-cluster",
    taskDefinition: "fleet-runner:3",
    containerName: "runner",
    subnets: ["subnet-aaa", "subnet-bbb"],
    securityGroups: ["sg-ccc"],
    launchType: "EC2",
    assignPublicIp: "DISABLED",
  });
  const args = provider.buildRunTaskArgs(SPEC);

  assert.deepEqual(args.slice(0, 2), ["ecs", "run-task"]);
  assert.equal(args[args.indexOf("--cluster") + 1], "fleet-cluster");
  assert.equal(args[args.indexOf("--task-definition") + 1], "fleet-runner:3");
  assert.equal(args[args.indexOf("--launch-type") + 1], "EC2");
  assert.equal(args[args.indexOf("--started-by") + 1], `fleet:${SPEC.jobId}`);

  const overrides = JSON.parse(args[args.indexOf("--overrides") + 1]) as {
    containerOverrides: { name: string; environment: { name: string; value: string }[] }[];
  };
  assert.equal(overrides.containerOverrides[0].name, "runner");
  const envByName = Object.fromEntries(
    overrides.containerOverrides[0].environment.map((e) => [e.name, e.value]),
  );
  assert.equal(envByName.FLEET_JOB_ID, SPEC.jobId);
  assert.equal(envByName.FLEET_RUNNER_TOKEN, SPEC.runnerToken);
  assert.equal(envByName.FLEET_DAEMON_URL, SPEC.daemonUrl);
  assert.equal(envByName.EXAMPLE_TOKEN, "abc");
  assert.ok(envByName.FLEET_MANIFEST_JSON);

  const network = JSON.parse(args[args.indexOf("--network-configuration") + 1]) as {
    awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: string };
  };
  assert.deepEqual(network.awsvpcConfiguration.subnets, ["subnet-aaa", "subnet-bbb"]);
  assert.equal(network.awsvpcConfiguration.assignPublicIp, "DISABLED");
});

test("EcsProvider omits network configuration when no subnets are configured", () => {
  const provider = new EcsProvider({
    cluster: "c",
    taskDefinition: "t",
    containerName: "runner",
    subnets: [],
    securityGroups: [],
    launchType: "EC2",
    assignPublicIp: "DISABLED",
  });
  assert.ok(!provider.buildRunTaskArgs(SPEC).includes("--network-configuration"));
});

test("prepareWorkspace materialises manifest, order, and sync files; refuses path escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const workspace = prepareWorkspace(SPEC, root);

  assert.deepEqual(JSON.parse(readFileSync(join(workspace, ".fleet/manifest.json"), "utf8")), MANIFEST);
  assert.deepEqual(JSON.parse(readFileSync(join(workspace, ".fleet/order.json"), "utf8")), WORK_ORDER);
  assert.equal(readFileSync(join(workspace, ".env.development"), "utf8"), "A=1\n");
  assert.ok(existsSync(join(workspace, ".fleet/out")));

  assert.throws(
    () => prepareWorkspace({ ...SPEC, sync: { "../evil.txt": Buffer.from("x").toString("base64") } }, root),
    /escapes workspace/,
  );
});

// Fake runner: exercises the full ProcessProvider round-trip against a real
// daemon over TCP — state running, decision, operator answer wake, settle, done.
const FAKE_RUNNER = `
const base = process.env.FLEET_DAEMON_URL;
const job = process.env.FLEET_JOB_ID;
const token = process.env.FLEET_RUNNER_TOKEN;
const headers = { "content-type": "application/json", "x-fleet-runner-token": token };
let seq = 0;
const post = async (ev) => {
  const res = await fetch(base + "/internal/jobs/" + job + "/events", {
    method: "POST",
    headers,
    body: JSON.stringify({ job, seq: seq++, ...ev }),
  });
  if (!res.ok) throw new Error("post failed: " + res.status + " " + (await res.text()));
};
await post({ type: "state", state: "running" });
await post({
  type: "decision",
  id: "d1",
  question: "Proceed with the migration?",
  options: [
    { id: "go", label: "Proceed", recommended: true },
    { id: "hold", label: "Hold" },
  ],
});
let answer = null;
while (!answer) {
  const res = await fetch(base + "/internal/jobs/" + job + "/answer?decision=d1", { headers });
  if (res.status === 200) answer = await res.json();
}
await post({ type: "think", text: "answered: " + answer.option });
await post({
  type: "settle",
  rung: "implemented",
  minutes: 1,
  outcome: { produced: [], findings: 0, decisions: 1 },
});
await post({ type: "state", state: "done" });
`;

test("ProcessProvider round-trips a fake runner: events, decision, answer, settle, done", async (t) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "fake-runner.mjs");
  writeFileSync(runnerPath, FAKE_RUNNER);

  const provider = new ProcessProvider({ runnerPath, workspaceRoot });
  const daemon = new FleetDaemon({ home: tempHome(), provider, port: 0, longPollMs: 400 });
  const { socketPath: sock, port } = await daemon.start();
  t.after(() => daemon.stop());
  assert.ok(port !== null && port > 0);

  const created = await op(sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(created.status, 201, created.body);
  const { id, handle } = (created.json as { job: { id: string; handle: string } }).job;
  assert.match(handle, /^pid:\d+$/);

  // The child process reaches the daemon over 127.0.0.1 and raises a decision.
  const state = async () =>
    ((await op(sock, "GET", `/jobs/${id}`)).json as { job: { state: string } }).job.state;
  await until(async () => (await state()) === "blocked", 10_000);

  // Operator answers; the runner's long-poll wakes and the job settles.
  const answered = await op(sock, "POST", `/jobs/${id}/answer`, { option: "go" });
  assert.equal(answered.status, 200, answered.body);
  await until(async () => (await state()) === "done", 10_000);

  const job = ((await op(sock, "GET", `/jobs/${id}`)).json as {
    job: { settle: { rung: string }; doneCheck: { verified: boolean } };
  }).job;
  assert.equal(job.settle.rung, "implemented");
  assert.equal(job.doneCheck.verified, true);

  const events = parseNdjson((await op(sock, "GET", `/jobs/${id}/events`)).body) as {
    type: string;
    text?: string;
    by?: string;
    state?: string;
  }[];
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["state", "state", "decision", "answer", "think", "settle", "state"]);
  assert.equal(events.find((e) => e.type === "answer")?.by, "operator");
  assert.equal(events.find((e) => e.type === "think")?.text, "answered: go");
  assert.equal(events[events.length - 1].state, "done");

  // The provider materialised the workspace for this job.
  const wsDir = readdirSync(workspaceRoot).find((name) => name.startsWith(`fleet-${id}-`));
  assert.ok(wsDir, "workspace dir not created");
  const manifestOnDisk = JSON.parse(readFileSync(join(workspaceRoot, wsDir, ".fleet/manifest.json"), "utf8"));
  assert.deepEqual(manifestOnDisk, MANIFEST);
});

test("ProcessProvider.terminate kills the child and is idempotent", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "sleeper.mjs");
  writeFileSync(runnerPath, "await new Promise(() => {});\n");

  const provider = new ProcessProvider({ runnerPath, workspaceRoot });
  const { handle } = await provider.launch({ ...SPEC, daemonUrl: "http://127.0.0.1:1" });
  const pid = Number(handle.replace("pid:", ""));
  assert.ok(pid > 0);

  await provider.terminate(handle);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  // Second terminate on an exited pid must not throw (ESRCH swallowed).
  await provider.terminate(handle);
});
