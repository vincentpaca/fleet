import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerProvider } from "../src/providers/docker.ts";
import {
  EcsProvider,
  ecsConfigFromEnv,
  ecsConfigFromFleetConfig,
  parseFleetConfigSsmResponse,
  checkResourceFit,
  ecsDaemonAccessFromFleetConfig,
  parseDaemonTaskArn,
  parseDaemonRuntimeId,
  ssmSessionTarget,
  buildPortForwardArgs,
  ecsTunnelOpener,
} from "../src/providers/ecs.ts";
import { ProcessProvider, prepareWorkspace } from "../src/providers/process.ts";
import { materializeWorkspace } from "../src/runner/workspace.ts";
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

test("ecsConfigFromFleetConfig maps fleet_config keys to EcsConfig", () => {
  const config = ecsConfigFromFleetConfig({
    provider: "ecs",
    cluster: "fleet-cluster",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    launch_type: "EC2",
    subnets: [],
    security_groups: [],
  });
  assert.equal(config.cluster, "fleet-cluster");
  assert.equal(config.taskDefinition, "fleet-runner");
  assert.equal(config.containerName, "fleet-runner");
  assert.equal(config.launchType, "EC2");
  assert.deepEqual(config.subnets, []);
  assert.deepEqual(config.securityGroups, []);
  assert.equal(config.assignPublicIp, "DISABLED");
});

test("ecsConfigFromFleetConfig treats missing subnets/security_groups as empty", () => {
  const config = ecsConfigFromFleetConfig({
    provider: "ecs",
    cluster: "c",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    launch_type: "EC2",
  });
  // Bridge-mode tasks omit these; ecsConfigFromFleetConfig must not throw.
  assert.deepEqual(config.subnets, []);
  assert.deepEqual(config.securityGroups, []);
  // Missing subnets → no --network-configuration added in buildRunTaskArgs.
  const provider = new EcsProvider(config);
  assert.ok(!provider.buildRunTaskArgs(SPEC).includes("--network-configuration"));
});

test("parseFleetConfigSsmResponse extracts the nested Parameter.Value JSON", () => {
  const inner = {
    provider: "ecs",
    cluster: "fleet-cluster",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    launch_type: "EC2",
    subnets: [],
    security_groups: [],
  };
  const ssmJson = JSON.stringify({ Parameter: { Name: "/fleet/fleet-config", Value: JSON.stringify(inner) } });
  const parsed = parseFleetConfigSsmResponse(ssmJson);
  assert.equal(parsed.cluster, "fleet-cluster");
  assert.equal(parsed.runner_task_definition, "fleet-runner");
  assert.deepEqual(parsed.subnets, []);
});

test("parseFleetConfigSsmResponse throws when Parameter.Value is absent", () => {
  assert.throws(() => parseFleetConfigSsmResponse(JSON.stringify({ Parameter: {} })), /Parameter\.Value/);
  assert.throws(() => parseFleetConfigSsmResponse(JSON.stringify({})), /Parameter\.Value/);
});

test("ecsConfigFromFleetConfig throws on missing required fields", () => {
  const base = {
    provider: "ecs",
    cluster: "c",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    launch_type: "EC2",
  };
  assert.throws(() => ecsConfigFromFleetConfig({ ...base, cluster: "" }), /cluster/);
  assert.throws(() => ecsConfigFromFleetConfig({ ...base, runner_task_definition: "" }), /runner_task_definition/);
  assert.throws(() => ecsConfigFromFleetConfig({ ...base, runner_container_name: "" }), /runner_container_name/);
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
  // The materialisation payload must be provider-complete: the ECS path once
  // omitted the work order and the runner died at the pickup gate with no
  // target (first real cloud job, #9).
  assert.ok(envByName.FLEET_WORK_ORDER_JSON, "FLEET_WORK_ORDER_JSON must be present so materializeWorkspace can write order.json");

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

test("DockerProvider includes FLEET_WORK_ORDER_JSON in env", () => {
  const provider = new DockerProvider();
  const args = provider.buildRunArgs(SPEC);
  const envPairs = args.filter((_, i) => args[i - 1] === "-e");
  const orderPair = envPairs.find((pair) => pair.startsWith("FLEET_WORK_ORDER_JSON="));
  assert.ok(orderPair, "FLEET_WORK_ORDER_JSON must be present so materializeWorkspace can write order.json");
  const decoded = JSON.parse(Buffer.from(orderPair.split("=")[1], "base64").toString());
  assert.deepEqual(decoded, WORK_ORDER);
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

test("materializeWorkspace writes manifest, order, and sync files from env vars", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fleet-mat-"));
  const origEnv = { ...process.env };
  try {
    process.env.FLEET_MANIFEST_JSON = Buffer.from(JSON.stringify(MANIFEST)).toString("base64");
    process.env.FLEET_WORK_ORDER_JSON = Buffer.from(JSON.stringify(WORK_ORDER)).toString("base64");
    process.env.FLEET_SYNC_JSON = Buffer.from(
      JSON.stringify({ ".env.development": Buffer.from("A=1\n").toString("base64") }),
    ).toString("base64");
    materializeWorkspace(workspace);

    assert.deepEqual(
      JSON.parse(readFileSync(join(workspace, ".fleet/manifest.json"), "utf8")),
      MANIFEST,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(workspace, ".fleet/order.json"), "utf8")),
      WORK_ORDER,
    );
    assert.equal(readFileSync(join(workspace, ".env.development"), "utf8"), "A=1\n");
    assert.ok(existsSync(join(workspace, ".fleet/out")));
  } finally {
    // Restore env: test isolation requires no FLEET_* vars leak to other tests.
    for (const key of ["FLEET_MANIFEST_JSON", "FLEET_WORK_ORDER_JSON", "FLEET_SYNC_JSON"]) {
      if (key in origEnv) {
        process.env[key] = origEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }
});

test("materializeWorkspace drops path-traversal sync entries and logs a warning", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fleet-mat-"));
  const origEnv = { ...process.env };
  const stderrLines: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => stderrLines.push(args.join(" "));
  try {
    process.env.FLEET_MANIFEST_JSON = Buffer.from(JSON.stringify(MANIFEST)).toString("base64");
    process.env.FLEET_SYNC_JSON = Buffer.from(
      JSON.stringify({ "../evil.txt": Buffer.from("x").toString("base64") }),
    ).toString("base64");
    materializeWorkspace(workspace);

    // The traversal entry must not have landed outside the workspace.
    assert.ok(!existsSync(join(workspace, "../evil.txt")));
    // A warning must have been emitted so operators can diagnose the dropped file.
    assert.ok(
      stderrLines.some((line) => line.includes("../evil.txt")),
      `expected a warning mentioning the dropped path; got: ${JSON.stringify(stderrLines)}`,
    );
  } finally {
    console.error = origError;
    for (const key of ["FLEET_MANIFEST_JSON", "FLEET_SYNC_JSON"]) {
      if (key in origEnv) {
        process.env[key] = origEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }
});

test("materializeWorkspace is a no-op when the manifest file already exists on disk", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fleet-mat-noop-"));
  const fleetDir = join(workspace, ".fleet");
  mkdirSync(fleetDir, { recursive: true });
  writeFileSync(join(fleetDir, "manifest.json"), JSON.stringify({ version: 1, _source: "already-there" }));

  const origEnv = { ...process.env };
  try {
    // FLEET_MANIFEST_JSON is set but should be ignored because the file exists.
    process.env.FLEET_MANIFEST_JSON = Buffer.from(JSON.stringify(MANIFEST)).toString("base64");
    materializeWorkspace(workspace);

    // Original content must be untouched.
    assert.equal(
      JSON.parse(readFileSync(join(fleetDir, "manifest.json"), "utf8"))._source,
      "already-there",
    );
  } finally {
    if (origEnv.FLEET_MANIFEST_JSON !== undefined) {
      process.env.FLEET_MANIFEST_JSON = origEnv.FLEET_MANIFEST_JSON;
    } else {
      delete process.env.FLEET_MANIFEST_JSON;
    }
  }
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

  // Workspaces are as disposable as containers: gone once the runner exits.
  // (Materialisation itself is covered by the prepareWorkspace unit test.)
  await until(
    async () => readdirSync(workspaceRoot).every((name) => !name.startsWith(`fleet-${id}-`)),
    10_000,
  );
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

// --- Retained workspaces after a failed push (#38) ----------------------------

// Fake runner that leaves a retain request behind, as the real one does when
// its work push fails. The reason line is what the operator later reads back.
const RETAIN_RUNNER = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.FLEET_WORKSPACE, '.fleet', 'out', 'retain-workspace.json'), JSON.stringify({
  jobId: process.env.FLEET_JOB_ID,
  target: 'APP-123',
  branch: 'fleet/APP-123-' + process.env.FLEET_JOB_ID,
  base: 'main',
  ok: true,
  reason: 'fatal: could not read from remote repository',
  at: '2026-08-17T10:00:00.000Z',
}));
`;

test("ProcessProvider keeps and registers a workspace the runner asked to retain", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "retain-runner.mjs");
  writeFileSync(runnerPath, RETAIN_RUNNER);
  const home = tempHome();

  const provider = new ProcessProvider({ runnerPath, workspaceRoot, home });
  await provider.launch(SPEC);

  const recordPath = join(home, "retained", `${SPEC.jobId}.json`);
  await until(() => existsSync(recordPath), 10_000);
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;

  // The kept directory is still there, and the record points at it.
  const kept = readdirSync(workspaceRoot).filter((name) => name.startsWith(`fleet-${SPEC.jobId}-`));
  assert.equal(kept.length, 1, "the workspace must survive: it is the only copy of the work");
  assert.equal(record.workspace, join(workspaceRoot, kept[0]));
  assert.equal(record.jobId, SPEC.jobId);
  assert.equal(record.branch, `fleet/APP-123-${SPEC.jobId}`);
  assert.match(String(record.reason), /could not read from remote/);
});

test("ProcessProvider keeps an unparseable retain request's workspace and records what it can", async () => {
  // A half-written request file must not read as "no retention requested" —
  // that would delete the only copy of the work on a parse error.
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "torn-runner.mjs");
  writeFileSync(
    runnerPath,
    `import { writeFileSync } from 'node:fs';\n` +
      `import { join } from 'node:path';\n` +
      `writeFileSync(join(process.env.FLEET_WORKSPACE, '.fleet', 'out', 'retain-workspace.json'), '{"jobId":"job-');\n`,
  );
  const home = tempHome();

  const provider = new ProcessProvider({ runnerPath, workspaceRoot, home });
  await provider.launch(SPEC);

  const recordPath = join(home, "retained", `${SPEC.jobId}.json`);
  await until(() => existsSync(recordPath), 10_000);
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  assert.equal(record.jobId, SPEC.jobId);
  assert.match(String(record.reason), /unreadable/);
  assert.equal(record.branch, undefined, "nothing is invented for a record we could not read");
  const kept = readdirSync(workspaceRoot).filter((name) => name.startsWith(`fleet-${SPEC.jobId}-`));
  assert.equal(kept.length, 1, "an unreadable request still keeps the workspace");
});

test("ProcessProvider registers a failed push even under FLEET_KEEP_WORKSPACE", async () => {
  // The debug flag keeps directories; it must not hide a lost delivery from
  // doctor and resume-push.
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "retain-runner.mjs");
  writeFileSync(runnerPath, RETAIN_RUNNER);
  const home = tempHome();
  const previous = process.env.FLEET_KEEP_WORKSPACE;
  process.env.FLEET_KEEP_WORKSPACE = "1";

  try {
    const provider = new ProcessProvider({ runnerPath, workspaceRoot, home });
    await provider.launch(SPEC);
    await until(() => existsSync(join(home, "retained", `${SPEC.jobId}.json`)), 10_000);
  } finally {
    if (previous === undefined) delete process.env.FLEET_KEEP_WORKSPACE;
    else process.env.FLEET_KEEP_WORKSPACE = previous;
  }
});

test("ProcessProvider deletes the workspace and registers nothing without a retain request", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "quiet-runner.mjs");
  writeFileSync(runnerPath, "process.exit(0);\n");
  const home = tempHome();

  const provider = new ProcessProvider({ runnerPath, workspaceRoot, home });
  await provider.launch(SPEC);

  await until(
    () => readdirSync(workspaceRoot).every((name) => !name.startsWith(`fleet-${SPEC.jobId}-`)),
    10_000,
  );
  assert.ok(!existsSync(join(home, "retained")), "a delivered job leaves no retained record");
});

// --- Resource request / capacity-fit tests ------------------------------------

test("DockerProvider adds --cpus and --memory when resources are specified", () => {
  const provider = new DockerProvider();
  const args = provider.buildRunArgs({ ...SPEC, resources: { cpu: 1024, memory: 2048 } });

  // --cpus: 1024 ECS units = 1.000 vCPU cores.
  const cpusIdx = args.indexOf("--cpus");
  assert.ok(cpusIdx !== -1, "--cpus flag must be present");
  assert.equal(args[cpusIdx + 1], "1.000");

  // --memory: 2048 MiB with 'm' suffix.
  const memIdx = args.indexOf("--memory");
  assert.ok(memIdx !== -1, "--memory flag must be present");
  assert.equal(args[memIdx + 1], "2048m");

  // Flags come before the env section (before first -e).
  const firstEnvIdx = args.indexOf("-e");
  assert.ok(cpusIdx < firstEnvIdx && memIdx < firstEnvIdx);
});

test("DockerProvider omits resource flags when no resources are specified", () => {
  const provider = new DockerProvider();
  const args = provider.buildRunArgs({ ...SPEC, resources: undefined });
  assert.ok(!args.includes("--cpus") && !args.includes("--memory"));
});

test("DockerProvider omits --cpus when only memory is specified", () => {
  const provider = new DockerProvider();
  const args = provider.buildRunArgs({ ...SPEC, resources: { memory: 512 } });
  assert.ok(!args.includes("--cpus"));
  assert.ok(args.includes("--memory"));
  assert.equal(args[args.indexOf("--memory") + 1], "512m");
});

test("EcsProvider.buildRunTaskArgs adds task-level cpu/memory overrides when resources are specified", () => {
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  const args = provider.buildRunTaskArgs({ ...SPEC, resources: { cpu: 2048, memory: 4096 } });
  const overrides = JSON.parse(args[args.indexOf("--overrides") + 1]) as {
    cpu?: string; memory?: string; containerOverrides: unknown[];
  };
  // ECS task-level override values must be strings.
  assert.equal(overrides.cpu, "2048");
  assert.equal(overrides.memory, "4096");
});

test("EcsProvider.buildRunTaskArgs omits task-level cpu/memory when no resources are specified", () => {
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  const args = provider.buildRunTaskArgs({ ...SPEC, resources: undefined });
  const overrides = JSON.parse(args[args.indexOf("--overrides") + 1]) as Record<string, unknown>;
  assert.ok(!("cpu" in overrides));
  assert.ok(!("memory" in overrides));
});

test("EcsProvider.buildRunTaskArgs sets only cpu override when only cpu is specified", () => {
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  const args = provider.buildRunTaskArgs({ ...SPEC, resources: { cpu: 1024 } });
  const overrides = JSON.parse(args[args.indexOf("--overrides") + 1]) as Record<string, unknown>;
  assert.equal(overrides.cpu, "1024");
  assert.ok(!("memory" in overrides));
});

test("EcsProvider.buildRunTaskArgs sets only memory override when only memory is specified", () => {
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  const args = provider.buildRunTaskArgs({ ...SPEC, resources: { memory: 2048 } });
  const overrides = JSON.parse(args[args.indexOf("--overrides") + 1]) as Record<string, unknown>;
  assert.ok(!("cpu" in overrides));
  assert.equal(overrides.memory, "2048");
});

test("checkResourceFit passes when the request fits within at least one tier", () => {
  const tiers = [{ cpu: 1024, memory: 2048 }, { cpu: 4096, memory: 8192 }];
  // Fits the first tier.
  assert.doesNotThrow(() => checkResourceFit({ cpu: 512, memory: 1024 }, tiers));
  // Fits only the second tier.
  assert.doesNotThrow(() => checkResourceFit({ cpu: 2048, memory: 4096 }, tiers));
  // Exactly at a tier boundary.
  assert.doesNotThrow(() => checkResourceFit({ cpu: 4096, memory: 8192 }, tiers));
});

test("checkResourceFit throws with exact numbers when the request exceeds all tiers", () => {
  const tiers = [{ cpu: 2048, memory: 3584 }];
  let caught: Error | null = null;
  try {
    checkResourceFit({ cpu: 4096, memory: 3584 }, tiers);
  } catch (error) {
    caught = error as Error;
  }
  assert.ok(caught !== null, "checkResourceFit must throw when request exceeds all tiers");
  assert.ok(caught.message.includes("cpu=4096"), `expected message to include requested cpu; got: ${caught.message}`);
  assert.ok(caught.message.includes("memory=3584"), `expected message to include requested memory; got: ${caught.message}`);
  assert.ok(caught.message.includes("cpu=2048"), `expected message to include offered cpu; got: ${caught.message}`);
});

test("checkResourceFit is a no-op when no tiers are declared (legacy config)", () => {
  // No tiers = no infra config yet; skip check rather than block everything.
  assert.doesNotThrow(() => checkResourceFit({ cpu: 999999, memory: 999999 }, []));
});

test("checkResourceFit is a no-op when no resources are requested", () => {
  const tiers = [{ cpu: 256, memory: 512 }];
  assert.doesNotThrow(() => checkResourceFit({}, tiers));
});

test("ecsConfigFromFleetConfig carries capacity_tiers from fleet_config", () => {
  const config = ecsConfigFromFleetConfig({
    provider: "ecs",
    cluster: "c",
    runner_task_definition: "t",
    runner_container_name: "runner",
    launch_type: "EC2",
    capacity_tiers: [{ cpu: 2048, memory: 3584 }],
  });
  assert.deepEqual(config.capacityTiers, [{ cpu: 2048, memory: 3584 }]);
});

test("ecsConfigFromFleetConfig defaults capacityTiers to [] when absent", () => {
  const config = ecsConfigFromFleetConfig({
    provider: "ecs",
    cluster: "c",
    runner_task_definition: "t",
    runner_container_name: "runner",
    launch_type: "EC2",
  });
  assert.deepEqual(config.capacityTiers, []);
});

test("EcsProvider.checkResources delegates to checkResourceFit with the config tiers", () => {
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [{ cpu: 2048, memory: 3584 }],
  });
  // Within capacity: no throw.
  assert.doesNotThrow(() => provider.checkResources({ cpu: 1024, memory: 2048 }));
  // Exceeds capacity: throws.
  assert.throws(() => provider.checkResources({ cpu: 4096, memory: 3584 }), /exceeds offered capacity/);
});

// --- Defect #34 fixes: capacity-provider strategy + non-loopback daemon URL ---

test("EcsProvider.buildRunTaskArgs uses --capacity-provider-strategy when capacityProvider is set", () => {
  // This is the defect #34 fix: run-task must use capacity-provider strategy so
  // ECS managed scaling fires; --launch-type EC2 bypasses it entirely.
  const provider = new EcsProvider({
    cluster: "fleet-cluster",
    taskDefinition: "fleet-runner:3",
    containerName: "runner",
    subnets: [],
    securityGroups: [],
    launchType: "EC2",
    assignPublicIp: "DISABLED",
    capacityTiers: [],
    capacityProvider: "fleet-ec2",
  });
  const args = provider.buildRunTaskArgs(SPEC);

  // Must use --capacity-provider-strategy, not --launch-type.
  assert.ok(args.includes("--capacity-provider-strategy"), "must include --capacity-provider-strategy");
  assert.ok(!args.includes("--launch-type"), "must not include --launch-type when capacityProvider is set");

  // The strategy value must name the provider with weight and base.
  const strategyIdx = args.indexOf("--capacity-provider-strategy");
  const strategyVal = args[strategyIdx + 1];
  assert.ok(strategyVal.includes("fleet-ec2"), `strategy must name the capacity provider; got: ${strategyVal}`);
  assert.ok(strategyVal.includes("weight=1"), `strategy must include weight; got: ${strategyVal}`);
  assert.ok(strategyVal.includes("base=0"), `strategy must include base; got: ${strategyVal}`);
});

test("EcsProvider.buildRunTaskArgs uses --launch-type when no capacityProvider is set", () => {
  // Backwards-compat path: env-var configs and legacy SSM configs without
  // capacity_provider fall back to the original --launch-type flag.
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
    // no capacityProvider
  });
  const args = provider.buildRunTaskArgs(SPEC);
  assert.ok(!args.includes("--capacity-provider-strategy"), "must not include strategy when capacityProvider absent");
  assert.ok(args.includes("--launch-type"), "must fall back to --launch-type");
  assert.equal(args[args.indexOf("--launch-type") + 1], "EC2");
});

test("ecsConfigFromFleetConfig reads capacity_provider field", () => {
  const config = ecsConfigFromFleetConfig({
    provider: "ecs",
    cluster: "fleet-cluster",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    capacity_provider: "fleet-ec2",
    // launch_type intentionally omitted — capacity_provider is now preferred
  });
  assert.equal(config.capacityProvider, "fleet-ec2");
  // launchType falls back to "EC2" when absent.
  assert.equal(config.launchType, "EC2");
});

test("ecsConfigFromFleetConfig leaves capacityProvider undefined when absent", () => {
  const config = ecsConfigFromFleetConfig({
    provider: "ecs",
    cluster: "c",
    runner_task_definition: "t",
    runner_container_name: "runner",
    launch_type: "EC2",
  });
  assert.equal(config.capacityProvider, undefined);
  assert.equal(config.launchType, "EC2");
});

test("ecsConfigFromFleetConfig makes launch_type optional (defaults to EC2)", () => {
  // New fleet_config SSM parameters omit launch_type in favour of capacity_provider.
  // Old code must not throw on the absence of launch_type.
  assert.doesNotThrow(() =>
    ecsConfigFromFleetConfig({
      provider: "ecs",
      cluster: "c",
      runner_task_definition: "t",
      runner_container_name: "runner",
      capacity_provider: "fleet-ec2",
      // no launch_type
    }),
  );
});

test("FleetDaemon.daemonUrl returns non-loopback TCP URL when tcpHost is a private IP", async (t) => {
  // Defect #34: runner tasks in ECS cannot reach 127.0.0.1. When tcpHost is set
  // to the daemon's VPC private IP, daemonUrl must advertise that address.
  // bindHost stays 127.0.0.1 (the test host's loopback) so the TCP server actually
  // starts — we are verifying URL construction, not actual VPC reachability.
  const home = tempHome();
  const provider = new ProcessProvider();
  const daemon = new FleetDaemon({ home, provider, port: 0, bindHost: "127.0.0.1", tcpHost: "10.0.1.55" });
  const { port } = await daemon.start();
  t.after(() => daemon.stop());
  assert.ok(port !== null && port > 0, "ephemeral port must be assigned");
  assert.equal(daemon.daemonUrl, `http://10.0.1.55:${port}`, "daemonUrl must use the configured tcpHost");
});

test("FleetDaemon.daemonUrl defaults to 127.0.0.1 when tcpHost is not set", async (t) => {
  const home = tempHome();
  const provider = new ProcessProvider();
  const daemon = new FleetDaemon({ home, provider, port: 0 });
  const { port } = await daemon.start();
  t.after(() => daemon.stop());
  assert.equal(daemon.daemonUrl, `http://127.0.0.1:${port}`);
});

test("GET /health returns {ok: true} with status 200", async (t) => {
  // The daemon Dockerfile HEALTHCHECK and the ECS service health check both
  // hit /health.  It must answer without any state, auth, or provider calls.
  const home = tempHome();
  const provider = new ProcessProvider();
  const daemon = new FleetDaemon({ home, provider, port: 0, longPollMs: 400 });
  const { socketPath: sock, port } = await daemon.start();
  t.after(() => daemon.stop());
  assert.ok(port !== null);

  // Hit /health via TCP (the path operators and ECS health checks use).
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.ok, true);

  // Also verify via the unix socket (the operator CLI path).
  const sockResult = await op(sock, "GET", "/health");
  assert.equal(sockResult.status, 200);
  assert.equal((sockResult.json as { ok: boolean }).ok, true);
});

// ---------- operator access: SSM port-forward primitives (#57) ----------
// `fleet connect` builds its whole command from these. Every test below fails
// on a mistake that would produce a plausible-looking but unusable tunnel.

const DAEMON_ACCESS = {
  cluster: "fleet",
  service: "fleet-daemon",
  containerName: "fleet-daemon",
  port: 9000,
};

test("ecsDaemonAccessFromFleetConfig reads the daemon access fields", () => {
  const access = ecsDaemonAccessFromFleetConfig({
    provider: "ecs",
    cluster: "fleet",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    daemon_service: "fleet-daemon",
    daemon_container_name: "fleet-daemon",
    daemon_port: 9000,
  });
  assert.deepEqual(access, DAEMON_ACCESS);
});

test("ecsDaemonAccessFromFleetConfig names the missing daemon access field", () => {
  const base = {
    provider: "ecs",
    cluster: "fleet",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    daemon_service: "fleet-daemon",
    daemon_container_name: "fleet-daemon",
    daemon_port: 9000,
  };
  assert.throws(
    () => ecsDaemonAccessFromFleetConfig({ ...base, daemon_service: undefined }),
    /daemon_service/,
  );
  assert.throws(
    () => ecsDaemonAccessFromFleetConfig({ ...base, daemon_container_name: undefined }),
    /daemon_container_name/,
  );
  // A config captured before the unit described its port must not silently
  // forward to port 0 (or to NaN, which aws would accept as a string).
  assert.throws(() => ecsDaemonAccessFromFleetConfig({ ...base, daemon_port: undefined }), /daemon_port/);
});

test("parseDaemonTaskArn takes the first running task and names the service when there is none", () => {
  const arn = "arn:aws:ecs:us-east-1:111122223333:task/fleet/0af1b2c3d4e5";
  assert.equal(parseDaemonTaskArn(JSON.stringify({ taskArns: [arn] }), DAEMON_ACCESS), arn);
  assert.throws(
    () => parseDaemonTaskArn(JSON.stringify({ taskArns: [] }), DAEMON_ACCESS),
    /fleet-daemon.*fleet|no running task/,
  );
});

test("parseDaemonRuntimeId picks the daemon container by name, not by position", () => {
  // A task with a sidecar listed first: taking containers[0] would forward to
  // the wrong process and produce a tunnel that connects to nothing.
  const describe = JSON.stringify({
    tasks: [
      {
        lastStatus: "RUNNING",
        containers: [
          { name: "log-router", runtimeId: "aaaa-1111" },
          { name: "fleet-daemon", runtimeId: "bbbb-2222" },
        ],
      },
    ],
  });
  assert.equal(parseDaemonRuntimeId(describe, "fleet-daemon"), "bbbb-2222");
});

test("parseDaemonRuntimeId refuses a task that is not running or has no runtime id yet", () => {
  const pending = JSON.stringify({
    tasks: [{ lastStatus: "PENDING", containers: [{ name: "fleet-daemon" }] }],
  });
  assert.throws(() => parseDaemonRuntimeId(pending, "fleet-daemon"), /PENDING/);

  const noRuntime = JSON.stringify({
    tasks: [{ lastStatus: "RUNNING", containers: [{ name: "fleet-daemon" }] }],
  });
  assert.throws(() => parseDaemonRuntimeId(noRuntime, "fleet-daemon"), /runtimeId/);

  const wrongName = JSON.stringify({
    tasks: [{ lastStatus: "RUNNING", containers: [{ name: "other", runtimeId: "x" }] }],
  });
  assert.throws(() => parseDaemonRuntimeId(wrongName, "fleet-daemon"), /no container named fleet-daemon/);

  assert.throws(() => parseDaemonRuntimeId(JSON.stringify({ tasks: [] }), "fleet-daemon"), /no task/);
});

test("ssmSessionTarget uses the task id and underscores, never the ARN or commas", () => {
  const target = ssmSessionTarget(
    "fleet",
    "arn:aws:ecs:us-east-1:111122223333:task/fleet/0af1b2c3d4e5",
    "bbbb-2222",
  );
  // The SSM API's target regex rejects both the slashes in an ARN and the
  // comma form used by ecs execute-command — either would fail at session start.
  assert.equal(target, "ecs:fleet_0af1b2c3d4e5_bbbb-2222");
  assert.ok(!target.includes(","));
  assert.ok(!target.includes("/"));
});

test("buildPortForwardArgs forwards the daemon port to the chosen local port", () => {
  const args = buildPortForwardArgs("ecs:fleet_task_rt", 9000, 19000);
  assert.deepEqual(args.slice(0, 5), [
    "ssm",
    "start-session",
    "--target",
    "ecs:fleet_task_rt",
    "--document-name",
  ]);
  assert.equal(args[5], "AWS-StartPortForwardingSessionToRemoteHost");
  assert.equal(args[6], "--parameters");
  // Ports are strings inside arrays — the SSM document rejects bare numbers,
  // and swapping the two ports produces a tunnel to the wrong end.
  assert.deepEqual(JSON.parse(args[7]), {
    host: ["localhost"],
    portNumber: ["9000"],
    localPortNumber: ["19000"],
  });
});

test("ecsTunnelOpener resolves the current task on every call", async () => {
  // The daemon task id changes on every service deployment. An opener that
  // cached its first answer would reopen forever against a dead container.
  const runtimeIds = ["rt-one", "rt-two"];
  const taskArns = [
    "arn:aws:ecs:us-east-1:111122223333:task/fleet/task-one",
    "arn:aws:ecs:us-east-1:111122223333:task/fleet/task-two",
  ];
  let round = 0;
  const calls: string[][] = [];
  const opener = ecsTunnelOpener(DAEMON_ACCESS, async (args) => {
    calls.push(args);
    if (args[1] === "list-tasks") return JSON.stringify({ taskArns: [taskArns[round]] });
    return JSON.stringify({
      tasks: [
        { lastStatus: "RUNNING", containers: [{ name: "fleet-daemon", runtimeId: runtimeIds[round++] }] },
      ],
    });
  });

  const first = await opener(19000);
  assert.equal(first.id, "ecs:fleet_task-one_rt-one");
  assert.deepEqual(first.argv.slice(0, 4), ["aws", "ssm", "start-session", "--target"]);
  assert.equal(first.argv[4], "ecs:fleet_task-one_rt-one");

  const second = await opener(19000);
  assert.equal(second.id, "ecs:fleet_task-two_rt-two");
  assert.equal(calls.length, 4, "each open re-lists and re-describes");
  // describe-tasks must ask about the task list-tasks just returned.
  assert.equal(calls[3][calls[3].indexOf("--tasks") + 1], taskArns[1]);
});
