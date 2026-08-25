import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DockerProvider } from "../src/providers/docker.ts";
import {
  AWS_CLI_TIMEOUT_MS,
  ECS_RUN_TASK_TIMEOUT_MS,
  ECS_STOP_TASK_TIMEOUT_MS,
  EcsProvider,
  awsCli,
  ecsConfigFromEnv,
  ecsConfigFromFleetConfig,
  parseFleetConfigSsmResponse,
  checkResourceFit,
  ecsDaemonAccessFromFleetConfig,
  parseDaemonTaskArn,
  parseDaemonRuntimeId,
  ssmSessionTarget,
  buildPortForwardArgs,
  buildListDaemonTasksArgs,
  buildDescribeDaemonTaskArgs,
  ecsTunnelOpener,
} from "../src/providers/ecs.ts";
import { ProcessProvider, prepareWorkspace } from "../src/providers/process.ts";
import { materializeWorkspace } from "../src/runner/workspace.ts";
import type { CloudCliRunner, LaunchSpec } from "../src/providers/provider.ts";
import { writeSecretTempFile } from "../src/providers/provider.ts";
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

test("DockerProvider builds a docker run command with env via --env-file, never argv (#126)", () => {
  const provider = new DockerProvider();
  const args = provider.buildRunArgs(SPEC, "/private/fleet-env/payload");

  assert.deepEqual(args.slice(0, 2), ["run", "-d"]);
  assert.ok(args.includes("--name") && args.includes("fleet-job-abc123"));
  assert.ok(args.includes(`fleet.job=${SPEC.jobId}`));

  // The whole env rides the file; no value on argv, where `ps` would show it
  // to every process on the host for the container-create duration (#126).
  assert.equal(args[args.indexOf("--env-file") + 1], "/private/fleet-env/payload");
  assert.ok(!args.includes("-e"));
  for (const secret of [SPEC.runnerToken, "EXAMPLE_TOKEN=abc", "FLEET_MANIFEST_JSON"]) {
    assert.ok(args.every((arg) => !arg.includes(secret)), `argv leaks ${secret}`);
  }

  // Image then runner command, at the end.
  const imageIdx = args.indexOf("ghcr.io/acme/fleet-runner:1");
  assert.ok(imageIdx > 0);
  assert.deepEqual(args.slice(imageIdx + 1), ["node", "/opt/fleet/src/runner/main.ts"]);

  // No mounts, ever.
  assert.ok(!args.includes("-v") && !args.includes("--mount"));
});

test("DockerProvider env file carries every FLEET_* var and the operator env", () => {
  const provider = new DockerProvider();
  const lines = provider.envFileContents(SPEC).split("\n").filter((line) => line.length > 0);

  assert.ok(lines.includes(`FLEET_JOB_ID=${SPEC.jobId}`));
  assert.ok(lines.includes(`FLEET_DAEMON_URL=${SPEC.daemonUrl}`));
  assert.ok(lines.includes(`FLEET_RUNNER_TOKEN=${SPEC.runnerToken}`));
  assert.ok(lines.includes("FLEET_WORKSPACE=/workspace"));
  assert.ok(lines.includes("EXAMPLE_TOKEN=abc"));

  // Manifest and sync travel base64-encoded.
  const manifestLine = lines.find((line) => line.startsWith("FLEET_MANIFEST_JSON="));
  assert.ok(manifestLine);
  const decoded = JSON.parse(Buffer.from(manifestLine.split("=")[1], "base64").toString());
  assert.deepEqual(decoded, MANIFEST);
  assert.ok(lines.some((line) => line.startsWith("FLEET_SYNC_JSON=")));
});

test("DockerProvider refuses an env value with a newline — --env-file cannot carry it", () => {
  // The env-file format is line-delimited with no quoting: a multiline value
  // would silently truncate into a bogus second entry. Refuse loudly rather
  // than launch a container with corrupted env.
  const provider = new DockerProvider();
  assert.throws(
    () => provider.envFileContents({ ...SPEC, env: { BAD_VALUE: "line1\nline2" } }),
    /BAD_VALUE.*newline/,
  );
});

test("DockerProvider falls back to the default image when the spec has none", () => {
  const provider = new DockerProvider({ defaultImage: "node:22" });
  const args = provider.buildRunArgs({ ...SPEC, image: undefined }, "/tmp/envfile");
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
  // Missing subnets → no networkConfiguration added in buildRunTaskInput.
  const provider = new EcsProvider(config);
  assert.ok(!("networkConfiguration" in provider.buildRunTaskInput(SPEC)));
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

test("EcsProvider builds the run-task input JSON with env overrides; argv carries only the file (#126)", () => {
  const provider = new EcsProvider({
    cluster: "fleet-cluster",
    taskDefinition: "fleet-runner:3",
    containerName: "runner",
    subnets: ["subnet-aaa", "subnet-bbb"],
    securityGroups: ["sg-ccc"],
    launchType: "EC2",
    assignPublicIp: "DISABLED",
  });
  const input = provider.buildRunTaskInput(SPEC);

  assert.equal(input.cluster, "fleet-cluster");
  assert.equal(input.taskDefinition, "fleet-runner:3");
  assert.equal(input.launchType, "EC2");
  // The startedBy stamp must survive the move off argv exactly: #147's future
  // reconcile sweep keys on `fleet:<jobId>` to find fleet-owned tasks.
  assert.equal(input.startedBy, `fleet:${SPEC.jobId}`);

  const overrides = input.overrides as {
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

  const network = input.networkConfiguration as {
    awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: string };
  };
  assert.deepEqual(network.awsvpcConfiguration.subnets, ["subnet-aaa", "subnet-bbb"]);
  assert.equal(network.awsvpcConfiguration.assignPublicIp, "DISABLED");

  // argv itself names only the input file — no env value rides it (#126).
  const args = provider.buildRunTaskArgs("/private/fleet-ecs-run/payload");
  assert.deepEqual(args, [
    "ecs",
    "run-task",
    "--cli-input-json",
    "file:///private/fleet-ecs-run/payload",
    "--output",
    "json",
  ]);
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
  assert.ok(!("networkConfiguration" in provider.buildRunTaskInput(SPEC)));
});

test("DockerProvider includes FLEET_WORK_ORDER_JSON in the env file", () => {
  const provider = new DockerProvider();
  const lines = provider.envFileContents(SPEC).split("\n");
  const orderLine = lines.find((line) => line.startsWith("FLEET_WORK_ORDER_JSON="));
  assert.ok(orderLine, "FLEET_WORK_ORDER_JSON must be present so materializeWorkspace can write order.json");
  const decoded = JSON.parse(Buffer.from(orderLine.split("=")[1], "base64").toString());
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
    /escapes it/,
  );
});

test("prepareWorkspace rejects a sync key naming the workspace root with a readable error (#139)", () => {
  // "." resolves to the workspace itself: the old guard admitted it and
  // writeFileSync(workspace) crashed EISDIR — an opaque failure instead of a
  // readable rejection before anything is materialised.
  const root = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  assert.throws(
    () => prepareWorkspace({ ...SPEC, sync: { ".": Buffer.from("x").toString("base64") } }, root),
    (err: unknown) => {
      const message = String(err instanceof Error ? err.message : err);
      assert.match(message, /workspace root/, `expected a readable root rejection, got: ${message}`);
      assert.doesNotMatch(message, /EISDIR/, "must reject by policy, not crash on the write");
      return true;
    },
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

test("materializeWorkspace drops a sync key naming the workspace root instead of crashing EISDIR (#139)", () => {
  // The old guard (`target !== workspace && ...`) admitted the root itself, so
  // a sync key of "." reached writeFileSync(workspace) and threw EISDIR before
  // any EventSink existed — the job died with no readable trace. It must be
  // dropped with a warning like any other out-of-workspace entry, and the
  // remaining sync entries must still land.
  const workspace = mkdtempSync(join(tmpdir(), "fleet-mat-root-"));
  const origEnv = { ...process.env };
  const stderrLines: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => stderrLines.push(args.join(" "));
  try {
    process.env.FLEET_MANIFEST_JSON = Buffer.from(JSON.stringify(MANIFEST)).toString("base64");
    process.env.FLEET_SYNC_JSON = Buffer.from(
      JSON.stringify({
        ".": Buffer.from("boom").toString("base64"),
        ".env.development": Buffer.from("A=1\n").toString("base64"),
      }),
    ).toString("base64");

    materializeWorkspace(workspace); // must not throw

    assert.equal(readFileSync(join(workspace, ".env.development"), "utf8"), "A=1\n", "good entries still land");
    assert.ok(
      stderrLines.some((line) => line.includes('"."') && line.includes("workspace root")),
      `expected a readable warning naming the dropped "." entry; got: ${JSON.stringify(stderrLines)}`,
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
  assert.match(handle, /^pid:\d+/);

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
  // The state event after the answer is daemon-authored (#114): the hot-path
  // blocked → running transition must be reconstructable from the log alone.
  assert.deepEqual(types, ["state", "state", "decision", "answer", "state", "think", "settle", "state"]);
  assert.equal(events[4].state, "running");
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
  const pid = Number(/^pid:(\d+)/.exec(handle)![1]);
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

// --- Daemon-restart recovery + pid-identity (#123) -----------------------------
// The exit handler that disposes of a workspace lives in the daemon; the runner
// deliberately survives daemon death. These tests launch through a separate
// process that exits immediately (fixtures/orphan-launcher.mjs) so the exit
// handler is genuinely gone — exactly what a daemon restart leaves behind.

const ORPHAN_LAUNCHER = join(import.meta.dirname, "..", "fixtures", "orphan-launcher.mjs");

/** Launch jobId via the fixture; returns the printed handle. */
function launchOrphan(home: string, workspaceRoot: string, runnerPath: string, jobId: string): string {
  return execFileSync(
    process.execPath,
    [ORPHAN_LAUNCHER, home, workspaceRoot, runnerPath, jobId],
    { encoding: "utf8" },
  ).trim();
}

// Runner that outlives the launching daemon: waits for <workspaceRoot>/release,
// then leaves a retain request (its push failed) and exits.
const ORPHAN_RETAIN_RUNNER = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const release = join(process.env.FLEET_WORKSPACE, '..', 'release');
while (!existsSync(release)) await new Promise((r) => setTimeout(r, 25));
writeFileSync(join(process.env.FLEET_WORKSPACE, '.fleet', 'out', 'retain-workspace.json'), JSON.stringify({
  jobId: process.env.FLEET_JOB_ID,
  branch: 'fleet/APP-123-' + process.env.FLEET_JOB_ID,
  reason: 'fatal: could not read from remote repository',
  at: '2026-08-24T10:00:00.000Z',
}));
`;

test("recover() registers a retain request orphaned by a daemon restart, once the runner exits", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "orphan-retain-runner.mjs");
  writeFileSync(runnerPath, ORPHAN_RETAIN_RUNNER);
  const home = tempHome();
  const jobId = "job-orphan1";

  const handle = launchOrphan(home, workspaceRoot, runnerPath, jobId);
  assert.match(handle, /^pid:\d+/);
  const workspaces = () =>
    readdirSync(workspaceRoot).filter((name) => name.startsWith(`fleet-${jobId}-`));
  assert.equal(workspaces().length, 1, "the runner survived the daemon, workspace and all");

  // Restarted daemon: a fresh provider sweeps. The runner is still alive
  // (waiting on the release file), so its workspace must be left alone.
  const provider = new ProcessProvider({ workspaceRoot, home, sweepPollMs: 50 });
  provider.recover();
  assert.equal(workspaces().length, 1, "recover must not touch a live runner's workspace");
  const recordPath = join(home, "retained", `${jobId}.json`);
  assert.ok(!existsSync(recordPath), "nothing is retained while the runner still runs");

  // The runner fails its push and exits with no exit handler anywhere to see
  // it. Without the sweep this is the #38 leak: only copy of the work, and
  // doctor never hears about it.
  writeFileSync(join(workspaceRoot, "release"), "");
  await until(() => existsSync(recordPath), 10_000);
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  assert.equal(record.jobId, jobId);
  assert.equal(record.workspace, join(workspaceRoot, workspaces()[0]));
  assert.match(String(record.reason), /could not read from remote/);
  assert.equal(workspaces().length, 1, "the workspace must survive: it is the only copy of the work");
  // The runner record is spent once the disposition ran.
  await until(() => !existsSync(join(home, "runners", `${jobId}.json`)), 10_000);
});

test("recover() deletes the workspace of a clean-exit runner orphaned by a daemon restart", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "quiet-runner.mjs");
  writeFileSync(runnerPath, "process.exit(0);\n");
  const home = tempHome();
  const jobId = "job-orphan2";

  const handle = launchOrphan(home, workspaceRoot, runnerPath, jobId);
  const pid = Number(/^pid:(\d+)/.exec(handle)![1]);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  const workspaces = () =>
    readdirSync(workspaceRoot).filter((name) => name.startsWith(`fleet-${jobId}-`));
  assert.equal(workspaces().length, 1, "the leak: no exit handler survived to delete this");

  const provider = new ProcessProvider({ workspaceRoot, home, sweepPollMs: 50 });
  provider.recover();
  assert.equal(workspaces().length, 0, "recover must delete a delivered orphan's workspace");
  assert.ok(!existsSync(join(home, "retained")), "a delivered job leaves no retained record");
  assert.ok(!existsSync(join(home, "runners", `${jobId}.json`)), "the runner record is spent");
});

test("terminate does not signal a pid whose recorded identity no longer matches", async () => {
  // The recycled-pid hazard: a handle persisted before a daemon restart names
  // a pid the OS has since given to an unrelated process. The start-time check
  // must turn the SIGTERM into a no-op.
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000);"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    bystander.once("spawn", resolve);
    bystander.once("error", reject);
  });
  try {
    const provider = new ProcessProvider({
      workspaceRoot: mkdtempSync(join(tmpdir(), "fleet-ws-")),
      home: tempHome(),
    });
    await provider.terminate(`pid:${bystander.pid}:Mon Jan  1 00:00:00 2001`);
    // Give a wrongly-delivered SIGTERM time to land before asserting.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(bystander.exitCode, null, "terminate signalled an unrelated process");
    assert.equal(bystander.signalCode, null, "terminate signalled an unrelated process");
  } finally {
    bystander.kill("SIGKILL");
  }
});

test("terminate treats a dead pid with a recorded start time as already gone", async () => {
  const provider = new ProcessProvider({
    workspaceRoot: mkdtempSync(join(tmpdir(), "fleet-ws-")),
    home: tempHome(),
  });
  // No process can answer for this pid; identity cannot match, so terminate
  // must resolve without signalling or throwing.
  await provider.terminate("pid:999999999:Mon Jan  1 00:00:00 2001");
});

// --- Resource request / capacity-fit tests ------------------------------------

test("DockerProvider adds --cpus and --memory when resources are specified", () => {
  const provider = new DockerProvider();
  const args = provider.buildRunArgs({ ...SPEC, resources: { cpu: 1024, memory: 2048 } }, "/tmp/envfile");

  // --cpus: 1024 ECS units = 1.000 vCPU cores.
  const cpusIdx = args.indexOf("--cpus");
  assert.ok(cpusIdx !== -1, "--cpus flag must be present");
  assert.equal(args[cpusIdx + 1], "1.000");

  // --memory: 2048 MiB with 'm' suffix.
  const memIdx = args.indexOf("--memory");
  assert.ok(memIdx !== -1, "--memory flag must be present");
  assert.equal(args[memIdx + 1], "2048m");

  // Flags come before the env section (before --env-file).
  const envFileIdx = args.indexOf("--env-file");
  assert.ok(cpusIdx < envFileIdx && memIdx < envFileIdx);
});

test("DockerProvider omits resource flags when no resources are specified", () => {
  const provider = new DockerProvider();
  const args = provider.buildRunArgs({ ...SPEC, resources: undefined }, "/tmp/envfile");
  assert.ok(!args.includes("--cpus") && !args.includes("--memory"));
});

test("DockerProvider omits --cpus when only memory is specified", () => {
  const provider = new DockerProvider();
  const args = provider.buildRunArgs({ ...SPEC, resources: { memory: 512 } }, "/tmp/envfile");
  assert.ok(!args.includes("--cpus"));
  assert.ok(args.includes("--memory"));
  assert.equal(args[args.indexOf("--memory") + 1], "512m");
});

test("EcsProvider.buildRunTaskInput adds task-level cpu/memory overrides when resources are specified", () => {
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  const input = provider.buildRunTaskInput({ ...SPEC, resources: { cpu: 2048, memory: 4096 } });
  const overrides = input.overrides as { cpu?: string; memory?: string; containerOverrides: unknown[] };
  // ECS task-level override values must be strings.
  assert.equal(overrides.cpu, "2048");
  assert.equal(overrides.memory, "4096");
});

test("EcsProvider.buildRunTaskInput omits task-level cpu/memory when no resources are specified", () => {
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  const overrides = provider.buildRunTaskInput({ ...SPEC, resources: undefined }).overrides as Record<string, unknown>;
  assert.ok(!("cpu" in overrides));
  assert.ok(!("memory" in overrides));
});

test("EcsProvider.buildRunTaskInput sets only cpu override when only cpu is specified", () => {
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  const overrides = provider.buildRunTaskInput({ ...SPEC, resources: { cpu: 1024 } }).overrides as Record<string, unknown>;
  assert.equal(overrides.cpu, "1024");
  assert.ok(!("memory" in overrides));
});

test("EcsProvider.buildRunTaskInput sets only memory override when only memory is specified", () => {
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  const overrides = provider.buildRunTaskInput({ ...SPEC, resources: { memory: 2048 } }).overrides as Record<string, unknown>;
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

test("EcsProvider.buildRunTaskInput uses capacityProviderStrategy when capacityProvider is set", () => {
  // This is the defect #34 fix: run-task must use capacity-provider strategy so
  // ECS managed scaling fires; launchType EC2 bypasses it entirely.
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
  const input = provider.buildRunTaskInput(SPEC);

  // Must use capacityProviderStrategy, not launchType — the API rejects both at once.
  assert.deepEqual(input.capacityProviderStrategy, [
    { capacityProvider: "fleet-ec2", weight: 1, base: 0 },
  ]);
  assert.ok(!("launchType" in input), "must not include launchType when capacityProvider is set");
});

test("EcsProvider.buildRunTaskInput uses launchType when no capacityProvider is set", () => {
  // Backwards-compat path: env-var configs and legacy SSM configs without
  // capacity_provider fall back to the original launch type.
  const provider = new EcsProvider({
    cluster: "c", taskDefinition: "t", containerName: "runner",
    subnets: [], securityGroups: [], launchType: "EC2", assignPublicIp: "DISABLED",
    capacityTiers: [],
    // no capacityProvider
  });
  const input = provider.buildRunTaskInput(SPEC);
  assert.ok(!("capacityProviderStrategy" in input), "must not include strategy when capacityProvider absent");
  assert.equal(input.launchType, "EC2");
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

// ---------- region plumbing (#138) --------------------------------------------
// Every aws call against a deployment names the deployment's own region, taken
// from fleet_config. The alternative — the caller's ambient AWS_REGION — does
// not error when wrong: list-tasks in another region returns an empty list,
// which the tunnel path reports as the misleading "the daemon service is not
// up". The fake aws runner records the argv the real CLI would receive.

test("fleet_config region reaches every tunnel-path aws call and the session argv (#138)", async () => {
  const access = ecsDaemonAccessFromFleetConfig({
    provider: "ecs",
    cluster: "fleet",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    daemon_service: "fleet-daemon",
    daemon_container_name: "fleet-daemon",
    daemon_port: 9000,
    region: "ap-southeast-1",
  });
  assert.equal(access.region, "ap-southeast-1");

  const calls: string[][] = [];
  const opener = ecsTunnelOpener(access, async (args) => {
    calls.push(args);
    if (args[1] === "list-tasks") {
      return JSON.stringify({ taskArns: ["arn:aws:ecs:ap-southeast-1:111122223333:task/fleet/t1"] });
    }
    return JSON.stringify({
      tasks: [{ lastStatus: "RUNNING", containers: [{ name: "fleet-daemon", runtimeId: "rt-1" }] }],
    });
  });
  const endpoint = await opener(19000);

  // Both resolution reads (list-tasks, describe-tasks) and the start-session
  // argv that holds the tunnel open: `fleet connect` with only fleet_config
  // set — no ambient region vars — must land every call in the deployment.
  assert.equal(calls.length, 2);
  for (const args of calls) {
    const at = args.indexOf("--region");
    assert.ok(at >= 0, `aws call missing --region: aws ${args.join(" ")}`);
    assert.equal(args[at + 1], "ap-southeast-1");
  }
  const sessionAt = endpoint.argv.indexOf("--region");
  assert.ok(sessionAt >= 0, `start-session missing --region: ${endpoint.argv.join(" ")}`);
  assert.equal(endpoint.argv[sessionAt + 1], "ap-southeast-1");
});

test("a capture without region builds the exact pre-#138 argv (backward compatible)", () => {
  // Legacy fleet-config.json files predate the region field. They must keep
  // working on the operator's ambient region, not gain a `--region undefined`.
  assert.ok(!("region" in ecsDaemonAccessFromFleetConfig({
    provider: "ecs",
    cluster: "fleet",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    daemon_service: "fleet-daemon",
    daemon_container_name: "fleet-daemon",
    daemon_port: 9000,
  })));
  assert.ok(!buildListDaemonTasksArgs(DAEMON_ACCESS).includes("--region"));
  assert.ok(!buildDescribeDaemonTaskArgs(DAEMON_ACCESS, "arn").includes("--region"));
  assert.ok(!buildPortForwardArgs("ecs:fleet_t_rt", 9000, 19000).includes("--region"));
});

test("EcsProvider run-task and stop-task carry the fleet_config region (#138)", () => {
  const config = ecsConfigFromFleetConfig({
    provider: "ecs",
    cluster: "fleet-cluster",
    runner_task_definition: "fleet-runner",
    runner_container_name: "fleet-runner",
    region: "ap-southeast-1",
  });
  assert.equal(config.region, "ap-southeast-1");
  const provider = new EcsProvider(config);

  // Region rides argv, not the input file (#126 x #138): it is a routing
  // flag, not a secret, and stays uniform with every other aws builder.
  const runArgs = provider.buildRunTaskArgs("/private/fleet-ecs-run/payload");
  assert.equal(runArgs[runArgs.indexOf("--region") + 1], "ap-southeast-1");
  const stopArgs = provider.buildStopTaskArgs("arn:aws:ecs:ap-southeast-1:111122223333:task/fleet/t1");
  assert.equal(stopArgs[stopArgs.indexOf("--region") + 1], "ap-southeast-1");

  // No region in the config → no --region flag, same argv as before #138.
  const legacy = new EcsProvider(ECS_CONFIG);
  assert.ok(!legacy.buildRunTaskArgs("/private/fleet-ecs-run/payload").includes("--region"));
  assert.ok(!legacy.buildStopTaskArgs("handle").includes("--region"));
});

test("ecsConfigFromEnv carries FLEET_ECS_REGION when set (#138)", () => {
  const base = {
    FLEET_ECS_CLUSTER: "fleet-cluster",
    FLEET_ECS_TASK_DEF: "fleet-runner:3",
    FLEET_ECS_CONTAINER: "runner",
  };
  assert.equal(ecsConfigFromEnv(base).region, undefined);
  assert.equal(ecsConfigFromEnv({ ...base, FLEET_ECS_REGION: "ap-southeast-1" }).region, "ap-southeast-1");
});

// ---------- CLI budgets + terminate idempotency (#122) ------------------------
// A wedged `aws` CLI once hung the daemon's launch and cancel paths forever.
// The budgets are finite constants pinned here (the repo's API-only-constraint
// convention: the value ships as a literal, so drift is a visible test edit),
// and terminate-of-missing is success on every provider.

const ECS_CONFIG = {
  cluster: "fleet-cluster",
  taskDefinition: "fleet-runner:3",
  containerName: "runner",
  subnets: [] as string[],
  securityGroups: [] as string[],
  launchType: "EC2" as const,
  assignPublicIp: "DISABLED" as const,
};

function ecsWith(aws: CloudCliRunner): EcsProvider {
  return new EcsProvider(ECS_CONFIG, { aws });
}

/** A `docker` shim on PATH that fails like the real daemon does. */
function fakeDockerBin(stderr: string): string {
  const bin = mkdtempSync(join(tmpdir(), "fleet-fake-docker-"));
  const escaped = stderr.replaceAll("'", "'\\''");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\necho '${escaped}' >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  return bin;
}

test("ECS CLI budgets are finite, larger than the tunnel budget, and pinned (#122)", () => {
  assert.equal(ECS_RUN_TASK_TIMEOUT_MS, 120_000);
  assert.equal(ECS_STOP_TASK_TIMEOUT_MS, 30_000);
  assert.ok(ECS_RUN_TASK_TIMEOUT_MS > AWS_CLI_TIMEOUT_MS);
});

test("dispatch fails within the run-task budget when aws never returns (#122)", async (t) => {
  // IMDS stall / network blackhole: the CLI never answers. The budget must
  // reach the runner (so the real child is killed, not left holding the event
  // loop) and the launch promise must settle with a clean error either way.
  const seen: Array<number | undefined> = [];
  const wedged = async (args: string[], timeoutMs?: number): Promise<string> => {
    seen.push(timeoutMs);
    void args;
    return new Promise<string>(() => {});
  };
  const provider = ecsWith(wedged);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settled = assert.rejects(provider.launch(SPEC), /exceeded its .* budget/);
  t.mock.timers.tick(ECS_RUN_TASK_TIMEOUT_MS);
  await settled;
  assert.equal(seen[0], ECS_RUN_TASK_TIMEOUT_MS, "budget must be forwarded so the child is killed");
});

test("cancel fails within the stop-task budget when aws never returns (#122)", async (t) => {
  const wedged = async (): Promise<string> => new Promise<string>(() => {});
  const provider = ecsWith(wedged);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settled = assert.rejects(provider.terminate("arn:aws:ecs:us-east-1:1:task/fleet/t"), /exceeded its .* budget/);
  // Both the attempt and its one bounded retry live under the budget. The
  // rejection from the first timer propagates through Promise.race → finally →
  // terminate's catch → the second #cli call, which schedules its own timer.
  // That chain needs several microtask turns before the second tick can fire it.
  t.mock.timers.tick(ECS_STOP_TASK_TIMEOUT_MS);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(ECS_STOP_TASK_TIMEOUT_MS);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await settled;
});

test("the default aws runner kills the CLI child at the caller's budget (#122)", async (t) => {
  // An unkilled child keeps the event loop alive long after the caller gave
  // up — the reason the tunnel path has AWS_CLI_TIMEOUT_MS. The kill must
  // apply at whatever budget the caller passes, not only the tunnel's.
  const bin = mkdtempSync(join(tmpdir(), "fleet-fake-aws-"));
  writeFileSync(join(bin, "aws"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  const start = Date.now();
  await assert.rejects(awsCli(["ecs", "run-task"], 300), /was killed|timed out|failed/i);
  assert.ok(Date.now() - start < 10_000, "the child must die at the budget, not after sleep 30");
});

test("stop-task treats TaskNotFoundException as success and does not retry (#122)", async () => {
  const calls: string[][] = [];
  const provider = ecsWith(async (args) => {
    calls.push(args);
    throw new Error("An error occurred (TaskNotFoundException) when calling the StopTask operation");
  });
  await provider.terminate("arn:aws:ecs:us-east-1:1:task/fleet/gone");
  assert.equal(calls.length, 1, "not-found is terminal success, not a transient failure");
  assert.equal(calls[0][calls[0].indexOf("--task") + 1], "arn:aws:ecs:us-east-1:1:task/fleet/gone");
  assert.equal(calls[0][calls[0].indexOf("--reason") + 1], "fleet-cancel");
});

test("stop-task treats an already-stopped task as success (#122)", async () => {
  const provider = ecsWith(async () => {
    throw new Error("task arn:aws:ecs:us-east-1:1:task/fleet/t is already stopped");
  });
  await provider.terminate("arn:aws:ecs:us-east-1:1:task/fleet/t");
});

test("one transient stop-task failure is retried before the cancel succeeds (#122)", async () => {
  let attempts = 0;
  const provider = ecsWith(async () => {
    attempts++;
    if (attempts === 1) throw new Error("socket hang up");
    return "{}";
  });
  await provider.terminate("arn:aws:ecs:us-east-1:1:task/fleet/t");
  assert.equal(attempts, 2, "exactly one bounded retry");
});

test("a stop-task failure that survives its retry surfaces instead of stranding the task (#122)", async () => {
  let attempts = 0;
  const provider = ecsWith(async () => {
    attempts++;
    throw new Error("RequestThrottled");
  });
  await assert.rejects(provider.terminate("arn:aws:ecs:us-east-1:1:task/fleet/t"), /RequestThrottled/);
  assert.equal(attempts, 2);
});

test("docker terminate treats a missing container as success (#122)", async (t) => {
  const bin = fakeDockerBin("Error response from daemon: No such container: fleet-job-abc123");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  // `docker rm -f` exits non-zero when the container is already gone; cancel
  // must still succeed — termination is idempotent by contract.
  await new DockerProvider().terminate("abc123");
});

test("docker terminate still surfaces real failures (#122)", async (t) => {
  const bin = fakeDockerBin("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  await assert.rejects(new DockerProvider().terminate("abc123"), /daemon/);
});
test("docker terminate stops the container before removing it (#111)", async (t) => {
  const log = stubDockerOnPath(t);
  await new DockerProvider().terminate("abc123");

  // `rm -f` is SIGKILL with no grace: on its own, the runner's cancel teardown
  // never receives a signal, so a cancelled job's uncommitted work is gone.
  // `stop -t` is what buys the teardown its SIGTERM and its window to push.
  const calls = argvCalls(log);
  assert.equal(calls[0]?.[0], "stop", `expected a stop first; got ${JSON.stringify(calls)}`);
  assert.equal(calls[0]?.[1], "-t");
  assert.ok(Number(calls[0]?.[2]) > 8, "the grace must outlast the runner's cancel deadline");
  assert.equal(calls[0]?.[3], "abc123");
  assert.deepEqual(calls[1], ["rm", "-f", "abc123"]);
});

test("docker terminate removes the container even when the stop fails (#111)", async (t) => {
  // The reaper (#120) calls terminate on a container that has already exited,
  // where `stop` has nothing to do. A stop failure must never block the removal.
  const bin = fakeDockerBin("Error response from daemon: No such container: abc123");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  await new DockerProvider().terminate("abc123");
});

// --- Docker lifecycle: rm-before-run + reap on clean settle (#120) ------------

/** Prefix of the retain note the real runner composes (src/runner/settle.ts). */
const RETAINED_WORKSPACE_NOTE = "workspace retained at";

// Stub docker binary: records every invocation's argv (one space-joined line
// per call) to $FLEET_STUB_DOCKER_LOG, answers `run` with a unique fake
// container id, and — for the daemon round-trips below — execs the container
// command with the `--env-file` vars exported, like a real `docker run`.
// The file is read while the stub runs, before the provider deletes it (#126).
const STUB_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FLEET_STUB_DOCKER_LOG"
case "$1" in
  rm) exit 0 ;;
  run)
    n=$(cat "$FLEET_STUB_DOCKER_LOG.n" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$FLEET_STUB_DOCKER_LOG.n"
    printf 'deadbeef%012d\\n' "$n"
    shift
    detached=0
    while [ $# -gt 0 ]; do
      case "$1" in
        -e) export "\${2%%=*}=\${2#*=}"; shift 2 ;;
        --env-file)
          while IFS= read -r kv || [ -n "$kv" ]; do
            [ -n "$kv" ] && export "$kv"
          done < "$2"
          shift 2 ;;
        --name|--label|--cpus|--memory) shift 2 ;;
        -d) detached=1; shift ;;
        *) break ;;
      esac
    done
    shift # image
    if [ $# -gt 0 ]; then
      if [ "$detached" = 1 ]; then
        nohup "$@" >/dev/null 2>&1 &
      else exec "$@"; fi
    fi
    ;;
esac
`;

/** Put a stub docker first on PATH for this test; returns the argv log path. */
function stubDockerOnPath(
  t: { after: (fn: () => void | Promise<void>) => void },
  script: string = STUB_DOCKER,
): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-stub-docker-"));
  const log = join(dir, "docker-argv.log");
  writeFileSync(join(dir, "docker"), script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  const prevLog = process.env.FLEET_STUB_DOCKER_LOG;
  process.env.PATH = `${dir}:${prevPath}`;
  process.env.FLEET_STUB_DOCKER_LOG = log;
  t.after(() => {
    process.env.PATH = prevPath;
    if (prevLog === undefined) delete process.env.FLEET_STUB_DOCKER_LOG;
    else process.env.FLEET_STUB_DOCKER_LOG = prevLog;
  });
  return log;
}

function argvCalls(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(" "));
}

// --- Manifest secrets off argv (#126) ------------------------------------------
// While `docker run`/`aws ecs run-task` executes, its argv is world-readable in
// `ps`. Secrets must ride a 0600 temp file the substrate reads during the call
// and the provider deletes right after — on the failure path too.

test("writeSecretTempFile writes 0600 inside a fresh 0700 dir; cleanup removes both", () => {
  const { path, cleanup } = writeSecretTempFile("fleet-secret-test-", "SECRET_TOKEN=shh\n");
  try {
    assert.equal(readFileSync(path, "utf8"), "SECRET_TOKEN=shh\n");
    assert.equal(statSync(path).mode & 0o777, 0o600, "the payload must be owner-only");
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700, "the directory must be owner-only");
  } finally {
    cleanup();
  }
  assert.ok(!existsSync(path) && !existsSync(dirname(path)), "cleanup must remove file and dir");
});

// Stub docker for the #126 launch tests: copies the env file's content and
// captures its (and its directory's) permission bits at the moment docker
// runs — the provider deletes the file right after, so assertions must read
// the copies. `ls -l | cut -c 1-10` is the portable way to read mode bits.
const SECRETS_STUB_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FLEET_STUB_DOCKER_LOG"
if [ "$1" = "run" ]; then
  grab=0
  for a in "$@"; do
    if [ "$grab" = 1 ]; then
      cp "$a" "$FLEET_STUB_DOCKER_LOG.env"
      ls -l "$a" | cut -c 1-10 > "$FLEET_STUB_DOCKER_LOG.mode"
      ls -ld "\${a%/*}" | cut -c 1-10 > "$FLEET_STUB_DOCKER_LOG.dirmode"
      grab=0
    fi
    [ "$a" = "--env-file" ] && grab=1
  done
  echo deadbeef000000000001
fi
exit 0
`;

// Stub docker whose `rm` succeeds (launch's pre-run cleanup) but whose `run`
// fails — the shape of a docker daemon rejecting the create.
const FAILING_RUN_STUB_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FLEET_STUB_DOCKER_LOG"
[ "$1" = "rm" ] && exit 0
echo "docker: create failed" >&2
exit 125
`;

test("DockerProvider.launch keeps env off argv; docker reads a 0600 file deleted after (#126)", async (t) => {
  const log = stubDockerOnPath(t, SECRETS_STUB_DOCKER);
  const { handle } = await new DockerProvider().launch(SPEC);
  assert.equal(handle, "deadbeef000000000001");

  const runCall = argvCalls(log).find((call) => call[0] === "run");
  assert.ok(runCall, "docker run was invoked");
  // The ps window (#126): no env value anywhere on the docker argv.
  assert.ok(!runCall.includes("-e"));
  assert.ok(runCall.every((arg) => !arg.includes(SPEC.runnerToken)), "runner token leaked into argv");

  // The env reached docker through the file...
  const delivered = readFileSync(`${log}.env`, "utf8");
  assert.ok(delivered.includes(`FLEET_RUNNER_TOKEN=${SPEC.runnerToken}`));
  assert.ok(delivered.includes("EXAMPLE_TOKEN=abc"));
  // ...which was 0600 inside a 0700 directory while docker could read it...
  assert.equal(readFileSync(`${log}.mode`, "utf8").trim(), "-rw-------");
  assert.equal(readFileSync(`${log}.dirmode`, "utf8").trim(), "drwx------");
  // ...and is gone once launch resolves.
  const envPath = runCall[runCall.indexOf("--env-file") + 1];
  assert.ok(!existsSync(envPath), "env file must not outlive the launch");
});

test("DockerProvider.launch deletes the env file when docker run fails (#126)", async (t) => {
  const log = stubDockerOnPath(t, FAILING_RUN_STUB_DOCKER);
  await assert.rejects(new DockerProvider().launch(SPEC));
  const runCall = argvCalls(log).find((call) => call[0] === "run");
  assert.ok(runCall, "docker run was attempted");
  const envPath = runCall[runCall.indexOf("--env-file") + 1];
  assert.ok(!existsSync(envPath), "env file must be deleted on the failure path too");
});

test("EcsProvider.launch feeds run-task from a 0600 input file, keeps secrets off argv, deletes it (#126)", async () => {
  let argv: string[] = [];
  let inputPath = "";
  let fileMode = 0;
  let dirMode = 0;
  let input: {
    startedBy?: string;
    overrides?: { containerOverrides: { environment: { name: string; value: string }[] }[] };
  } = {};
  const provider = ecsWith(async (args) => {
    argv = args;
    const fileArg = args[args.indexOf("--cli-input-json") + 1];
    assert.match(fileArg, /^file:\/\//);
    inputPath = fileArg.slice("file://".length);
    fileMode = statSync(inputPath).mode & 0o777;
    dirMode = statSync(dirname(inputPath)).mode & 0o777;
    input = JSON.parse(readFileSync(inputPath, "utf8")) as typeof input;
    return JSON.stringify({ tasks: [{ taskArn: "arn:aws:ecs:us-east-1:1:task/fleet/t1" }] });
  });

  const { handle } = await provider.launch(SPEC);
  assert.equal(handle, "arn:aws:ecs:us-east-1:1:task/fleet/t1");

  // The ps window (#126): no env value or overrides JSON anywhere on argv.
  assert.ok(argv.every((arg) => !arg.includes(SPEC.runnerToken)), "runner token leaked into argv");
  assert.ok(!argv.includes("--overrides"));

  // The parameters reached the CLI through an owner-only file...
  assert.equal(fileMode, 0o600);
  assert.equal(dirMode, 0o700);
  // ...with the startedBy stamp intact — #147's reconcile sweep keys on it —
  assert.equal(input.startedBy, `fleet:${SPEC.jobId}`);
  // ...and the env overrides complete.
  const env = Object.fromEntries(
    (input.overrides?.containerOverrides[0].environment ?? []).map((e) => [e.name, e.value]),
  );
  assert.equal(env.FLEET_RUNNER_TOKEN, SPEC.runnerToken);
  assert.equal(env.EXAMPLE_TOKEN, "abc");

  assert.ok(!existsSync(inputPath), "input file must be deleted after a successful launch");
});

test("EcsProvider.launch deletes the input file when run-task fails (#126)", async () => {
  let inputPath = "";
  const provider = ecsWith(async (args) => {
    inputPath = args[args.indexOf("--cli-input-json") + 1].slice("file://".length);
    throw new Error("ThrottlingException");
  });
  await assert.rejects(provider.launch(SPEC), /ThrottlingException/);
  assert.ok(inputPath.length > 0, "run-task was attempted");
  assert.ok(!existsSync(inputPath), "input file must be deleted on the failure path too");
});

// Narrow a daemon JSON response down to its job record (runtime-checked).
type JobView = { id: string; state: string; marker?: string };

function jobOf(payload: unknown): JobView {
  if (typeof payload !== "object" || payload === null || !("job" in payload)) {
    throw new Error(`unexpected daemon response: ${JSON.stringify(payload)}`);
  }
  // Runtime shape checked above; JobRecord's public fields are all we read.
  const { job } = payload as { job: JobView };
  return job;
}

test("DockerProvider.launch removes any stale fleet-<jobId> container before run", async (t) => {
  const log = stubDockerOnPath(t);
  const provider = new DockerProvider();
  await provider.launch({ ...SPEC });

  const calls = argvCalls(log);
  // A parked job's exited container still owns the name; without the removal
  // the re-entry `docker run --name fleet-<jobId>` fails "already in use".
  assert.deepEqual(calls[0], ["rm", "-f", `fleet-${SPEC.jobId}`]);
  assert.equal(calls[1]?.[0], "run");
  assert.deepEqual(calls[1]?.slice(0, 4), ["run", "-d", "--name", `fleet-${SPEC.jobId}`]);
});

// Fake runner behind the stub docker: raises a decision, parks, and exits.
// On re-entry (reentry answer present in the env) it resumes and settles.
const DOCKER_PARK_RUNNER = `
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
if (process.env.FLEET_REENTRY_ANSWER_JSON === undefined) {
  await post({
    type: "decision",
    id: "d1",
    question: "Proceed with the cutover?",
    options: [
      { id: "go", label: "Proceed", recommended: true },
      { id: "hold", label: "Hold" },
    ],
  });
  await post({ type: "state", state: "blocked", marker: "parked" });
} else {
  await post({ type: "think", text: "resumed after operator answer" });
  await post({
    type: "settle",
    rung: "implemented",
    minutes: 1,
    outcome: { produced: [], findings: 0, decisions: 1 },
  });
  await post({ type: "state", state: "done" });
}
`;

test("docker park -> answer -> resume launches cleanly and reaps on settle", async (t) => {
  const log = stubDockerOnPath(t);
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "park-runner.mjs");
  writeFileSync(runnerPath, DOCKER_PARK_RUNNER);

  const provider = new DockerProvider({
    runnerCmd: [process.execPath, runnerPath],
    defaultImage: "node:22",
  });
  const daemon = new FleetDaemon({ home: tempHome(), provider, port: 0, longPollMs: 400 });
  const { socketPath: sock } = await daemon.start();
  t.after(() => daemon.stop());

  const created = await op(sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST });
  assert.equal(created.status, 201, created.body);
  const { id } = jobOf(created.json);
  const name = `fleet-${id}`;

  const state = async () => jobOf((await op(sock, "GET", `/jobs/${id}`)).json).state;
  const marker = async () => jobOf((await op(sock, "GET", `/jobs/${id}`)).json).marker;

  // Launch #1: the pre-run removal must precede the run (the fix under test).
  await until(() => argvCalls(log).length >= 2, 10_000);
  let calls = argvCalls(log);
  assert.deepEqual(calls[0], ["rm", "-f", name]);
  assert.deepEqual(calls[1]?.slice(0, 4), ["run", "-d", "--name", name]);

  // Wait for the PARK, not just for `blocked`. The decision event blocks the
  // job on its own, one event ahead of `state: blocked, marker: parked`, so a
  // poll on the state alone can land in between — and an answer arriving there
  // takes the hot path, which re-launches nothing and leaves this test waiting
  // on a container that never starts.
  await until(async () => (await marker()) === "parked", 10_000);
  assert.equal(await state(), "blocked");
  const answered = await op(sock, "POST", `/jobs/${id}/answer`, { option: "go" });
  assert.equal(answered.status, 200, answered.body);

  // Launch #2 (re-entry): the exited pre-park container was removed again.
  await until(() => argvCalls(log).length >= 4, 10_000);
  calls = argvCalls(log);
  assert.deepEqual(calls[2], ["rm", "-f", name]);
  assert.deepEqual(calls[3]?.slice(0, 4), ["run", "-d", "--name", name]);

  await until(async () => (await state()) === "done", 10_000);

  // Reap on clean settle: the exited re-entry container must be removed.
  await until(
    () => argvCalls(log).some((c) => c[0] === "rm" && c[2] === "deadbeef000000000002"),
    10_000,
  );
});

// Fake runner behind the stub docker: settles straight through. When the
// operator env carries FLEET_TEST_RETAIN=1 it first posts the exact note the
// real runner composes (via composeSettle) when a work push failed.
const DOCKER_SETTLE_RUNNER = `
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
if (process.env.FLEET_TEST_RETAIN === "1") {
  await post({
    type: "log",
    who: "runner",
    text: ${JSON.stringify(RETAINED_WORKSPACE_NOTE)} + "evidence-copy-for-manual-inspection (work push failed)",
  });
}
await post({
  type: "settle",
  rung: "implemented",
  minutes: 1,
  outcome: { produced: [], findings: 0, decisions: 0 },
});
await post({ type: "state", state: "done" });
`;

test("cleanly settled docker job is reaped; retained-workspace container is not", async (t) => {
  const log = stubDockerOnPath(t);
  const workspaceRoot = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  const runnerPath = join(workspaceRoot, "settle-runner.mjs");
  writeFileSync(runnerPath, DOCKER_SETTLE_RUNNER);

  const provider = new DockerProvider({
    runnerCmd: [process.execPath, runnerPath],
    defaultImage: "node:22",
  });
  const daemon = new FleetDaemon({ home: tempHome(), provider, port: 0, longPollMs: 400 });
  const { socketPath: sock } = await daemon.start();
  t.after(() => daemon.stop());

  const createJob = async (env?: Record<string, string>) => {
    const created = await op(sock, "POST", "/jobs", { workOrder: WORK_ORDER, manifest: MANIFEST, ...(env ? { env } : {}) });
    assert.equal(created.status, 201, created.body);
    return jobOf(created.json).id;
  };
  const state = async (id: string) => jobOf((await op(sock, "GET", `/jobs/${id}`)).json).state;

  // Retained first so its fake container id sorts before the control's.
  const retainedId = await createJob({ FLEET_TEST_RETAIN: "1" });
  const controlId = await createJob();
  await until(async () => (await state(retainedId)) === "done", 10_000);
  await until(async () => (await state(controlId)) === "done", 10_000);

  // The guard condition must actually have been exercised: the retain note
  // rides in the retained job's event log ahead of the terminal state.
  const events = parseNdjson((await op(sock, "GET", `/jobs/${retainedId}/events`)).body);
  const noted = events.some(
    (event) =>
      typeof event === "object" && event !== null && "type" in event && event.type === "log" &&
      "text" in event && typeof event.text === "string" && event.text.startsWith(RETAINED_WORKSPACE_NOTE),
  );
  assert.ok(noted, "retain note must precede settle");

  // Deterministic completion signal: wait until the CONTROL job (no retain
  // note) has been reaped — by then the retained job's terminal effects have
  // long since run, so absence of its reap is not a race.
  await until(
    () => argvCalls(log).some((c) => c[0] === "rm" && c[2] === "deadbeef000000000002"),
    10_000,
  );

  // The cleanly settled control container was removed...
  assert.ok(argvCalls(log).some((c) => c[0] === "rm" && c[2] === "deadbeef000000000002"));
  // ...while the retained workspace kept its stopped container.
  assert.equal(
    argvCalls(log).filter((c) => c[0] === "rm" && c[2] === "deadbeef000000000001").length,
    0,
    "a retained workspace keeps its stopped container",
  );
});

// --- Two-layer image override on ECS (#49) -----------------------------------

test("EcsProvider.checkImageOverride refuses the computed job image, naming it and the way out", () => {
  const provider = new EcsProvider({
    cluster: "c",
    taskDefinition: "t",
    containerName: "runner",
    subnets: [],
    securityGroups: [],
    launchType: "EC2",
    assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  assert.throws(
    () => provider.checkImageOverride("fleet-job:abc123def4567890"),
    (error: Error) => {
      // The refusal must be actionable: name the image, say why ECS cannot run
      // it, and point at both exits (drop cli_version, or a docker deployment).
      assert.match(error.message, /fleet-job:abc123def4567890/);
      assert.match(error.message, /task definition pins/);
      assert.match(error.message, /cli_version/);
      return true;
    },
  );
});

test("EcsProvider.buildRunTaskInput never leaks spec.image into run-task — the refusal is the contract", () => {
  const provider = new EcsProvider({
    cluster: "c",
    taskDefinition: "pinned-task-def",
    containerName: "runner",
    subnets: [],
    securityGroups: [],
    launchType: "EC2",
    assignPublicIp: "DISABLED",
    capacityTiers: [],
  });
  // If someone wires spec.image into the run-task input without the ECR push
  // and a task-definition revision, ECS would reject or (worse) half-honor it —
  // dispatch must keep using the pinned task definition only.
  const input = provider.buildRunTaskInput({ ...SPEC, image: "fleet-job:abc123def4567890" });
  assert.equal(JSON.stringify(input).includes("fleet-job:abc123def4567890"), false);
  assert.equal(input.taskDefinition, "pinned-task-def");
});
