// Fleet daemon entrypoint: `node src/daemon/main.ts`.
// Env: FLEET_HOME (default ~/.fleet), FLEET_PORT (optional TCP listener),
// FLEET_DAEMON_HOST (IP/host to advertise in daemonUrl; default 127.0.0.1;
//   auto-discovered from ECS container metadata when FLEET_PORT is set and
//   ECS_CONTAINER_METADATA_URI_V4 is present; setting it explicitly also
//   widens the bind to 0.0.0.0 — a daemon told to advertise a network address
//   has to be reachable on it),
// FLEET_PROVIDER (process | docker | ecs | gcp; default process),
// FLEET_NOTIFY_WEBHOOK (optional, comma-separated URLs; {text} payload per
// decision).
// Logs four terse `fleet daemon: ` lines at boot (home, provider, config source,
// listen address; a fifth when it discovers its IP from ECS metadata, and one
// more when it publishes the operator token to SSM or Secret Manager — #188)
// and nothing per-request — see test/daemon-boot-log.test.ts.
import { mkdirSync } from "node:fs";
import { fleetHome } from "../shared/home.ts";
import { loadOrCreateOperatorToken, FleetDaemon } from "./server.ts";
import { ProcessProvider } from "../providers/process.ts";
import { DockerProvider } from "../providers/docker.ts";
import { EcsProvider, ecsConfigFromEnv, ecsConfigFromSsm, publishOperatorTokenToSsm } from "../providers/ecs.ts";
import { GcpProvider, gcpConfigFromEnv, publishOperatorTokenToSecretManager } from "../providers/gcp.ts";
import type { Provider } from "../providers/provider.ts";

/**
 * Which provider to build and where its configuration comes from. Decided in
 * one place so the boot log (below) states the same source the provider reads
 * — a boot line derived from a second copy of this branch could lie (#53).
 * `ssmPath` carries the decision; `configSource` is only the log label. It is a
 * parameter *name* or the literal `env`/`none`, never a configuration value:
 * boot evidence must be safe to ship to a log group.
 */
type ProviderChoice = { name: string; configSource: string; ssmPath?: string };

function providerChoice(): ProviderChoice {
  const name = process.env.FLEET_PROVIDER ?? "process";
  // gcp config arrives entirely as FLEET_GCP_* env — the unit renders a
  // daemon.env file into the VM's cloud-init, so there is no live-fetch step.
  if (name === "gcp") return { name, configSource: "env" };
  // Only ecs reads configuration from outside the process env.
  if (name !== "ecs") return { name, configSource: "none" };
  // FLEET_ECS_CLUSTER being set signals an explicit env override (tests,
  // manual deployments).  Otherwise read the SSM parameter that the infra
  // unit wrote at apply time so no FLEET_ECS_* vars need to be hand-set.
  const ssmPath = process.env.FLEET_ECS_CONFIG_SSM_PATH;
  if (ssmPath && !process.env.FLEET_ECS_CLUSTER) {
    return { name, configSource: `ssm:${ssmPath}`, ssmPath };
  }
  return { name, configSource: "env" };
}

async function buildProvider(choice: ProviderChoice, home: string): Promise<Provider> {
  switch (choice.name) {
    case "process":
      // home: where a workspace retained after a failed push is registered (#38).
      return new ProcessProvider({ home });
    case "docker":
      return new DockerProvider();
    case "ecs":
      return new EcsProvider(
        choice.ssmPath !== undefined ? await ecsConfigFromSsm(choice.ssmPath) : ecsConfigFromEnv(),
      );
    case "gcp":
      return new GcpProvider(gcpConfigFromEnv());
    default:
      throw new Error(`unknown FLEET_PROVIDER: ${choice.name} (expected process | docker | ecs | gcp)`);
  }
}

// Boot evidence, emitted before anything that can hang or fail — creating home
// (an NFS mount in ECS), the SSM read, the bind. A task that logged these three
// lines and nothing else is stuck before bind, which is exactly what #9's
// bring-up could not tell without ECS exec.
const home = fleetHome();
const choice = providerChoice();
console.log(`fleet daemon: home ${home}`);
console.log(`fleet daemon: provider ${choice.name}`);
console.log(`fleet daemon: config source ${choice.configSource}`);

mkdirSync(home, { recursive: true });

const portEnv = process.env.FLEET_PORT;
const port = portEnv !== undefined && portEnv !== "" ? Number(portEnv) : undefined;
if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
  console.error(`invalid FLEET_PORT: ${portEnv}`);
  process.exit(1);
}

// Resolve the host the daemon advertises to runners in daemonUrl.
// Priority: explicit FLEET_DAEMON_HOST > ECS metadata auto-discovery > 127.0.0.1.
// When FLEET_PORT is set and ECS_CONTAINER_METADATA_URI_V4 is present (inside an ECS
// task), we auto-discover the container's private VPC IP from the metadata endpoint.
// The bind host is 0.0.0.0 in ECS (listen on all interfaces) so the discovered IP
// is reachable, and 127.0.0.1 otherwise (local/test use).
let tcpHost = process.env.FLEET_DAEMON_HOST ?? "";
let bindHost = "127.0.0.1";

if (port !== undefined) {
  // An explicitly-set non-loopback FLEET_DAEMON_HOST widens the bind (#185):
  // the operator (or the GCP unit's env file) is saying "runners reach me at
  // this network address", and a daemon that advertises it while binding
  // loopback is unreachable by every job and by the IAP tunnel alike. The ECS
  // branch below reaches the same bind through metadata discovery; this is
  // the substrate-neutral form of the same decision. A loopback value stays
  // on the loopback bind — advertising 127.0.0.1 wants no wider listener.
  if (tcpHost !== "" && tcpHost !== "127.0.0.1" && tcpHost !== "localhost") {
    bindHost = "0.0.0.0";
  }
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (metadataUri) {
    // We're inside an ECS task: listen on all interfaces so the task's VPC ENI
    // is reachable, then advertise the discovered private IP to runner tasks.
    bindHost = "0.0.0.0";
    if (!tcpHost) {
      try {
        const resp = await fetch(metadataUri);
        const meta = await resp.json() as Record<string, unknown>;
        const networks = meta.Networks as Array<{ IPv4Addresses?: string[] }> | undefined;
        const ip = networks?.[0]?.IPv4Addresses?.[0];
        if (ip) {
          tcpHost = ip;
          console.log(`fleet daemon: discovered private IP ${ip} from ECS container metadata`);
        }
      } catch {
        // Best-effort: if metadata is unavailable, fall through to 127.0.0.1.
      }
    }
  }
}
if (!tcpHost) tcpHost = "127.0.0.1";

// Operator secret for /jobs/* (issue #133): generated on first boot,
// persisted 0600 at $FLEET_HOME/operator-token, read by the CLI over the
// socket and over an SSM tunnel alike. Every real daemon enforces it —
// there is no credential-free deployment of the /jobs/* surface.
const provider = await buildProvider(choice, home);
const operatorToken = loadOrCreateOperatorToken(home);
const daemon = new FleetDaemon({
  home,
  provider,
  port,
  bindHost,
  tcpHost,
  operatorToken,
});

const { socketPath: sock, port: boundPort } = await daemon.start();
// Same `fleet daemon: ` prefix as the lines above: one filter on a log stream
// must not drop the line that says the daemon is up.
console.log(`fleet daemon: listening on ${sock}${boundPort !== null ? ` and ${bindHost}:${boundPort} (advertising ${tcpHost})` : ""}`);

// Token distribution (#188): a fresh cloud deployment mints its token on a
// volume the operator cannot read without `ecs execute-command` by hand, so
// publish it as the SecureString SSM parameter next to the config this boot
// just read — the CLI fetches it from there with the operator's own AWS
// credentials. After the listen line: a hung SSM write must not block the
// bind, and best-effort: a daemon that serves but could not publish is
// strictly better than one that is down. The log line carries the parameter
// NAME only — boot evidence must be safe to ship to a log group.
if (choice.name === "ecs" && choice.ssmPath !== undefined) {
  try {
    const name = await publishOperatorTokenToSsm(choice.ssmPath, operatorToken);
    console.log(`fleet daemon: published operator token to ssm:${name}`);
  } catch (error) {
    console.error(`fleet: operator token publish failed: ${String(error)} — the CLI cannot fetch it; read $FLEET_HOME/operator-token via ecs execute-command instead`);
  }
}

// Same contract on GCP (#185): the unit creates the secret, the daemon adds a
// version at boot, the CLI fetches it with the operator's own gcloud
// credentials. Gated on the secret being named — a hand-run gcp daemon
// without one simply serves. Best-effort and after the listen line, for the
// same reasons as the SSM publish above.
if (choice.name === "gcp" && process.env.FLEET_GCP_TOKEN_SECRET) {
  try {
    const name = await publishOperatorTokenToSecretManager(
      process.env.FLEET_GCP_PROJECT ?? "",
      process.env.FLEET_GCP_TOKEN_SECRET,
      operatorToken,
    );
    console.log(`fleet daemon: published operator token to secret-manager:${name}`);
  } catch (error) {
    console.error(`fleet: operator token publish failed: ${String(error)} — the CLI cannot fetch it; read $FLEET_HOME/operator-token over an IAP SSH session instead`);
  }
}

// Only after start() holds the home lock: settle what a previous daemon's
// death orphaned (#123). Quiet unless it acts, and never on stdout — the boot
// lines above are a pinned contract (test/daemon-boot-log.test.ts).
await provider.recover?.();

// Same slot, cloud side (#147): stop any task whose startedBy names a job the
// registry holds terminal — a wedged run-task or a failed stop-task leaves one
// running and billing with no stored handle. No-op for providers without a
// sandbox listing; a sweep failure must not take the daemon down with it.
try {
  for (const orphan of (await daemon.reconcileOrphans()).orphans) {
    console.error(
      `fleet: reconcile ${orphan.stopped ? "stopped" : "could not stop"} ` +
      `orphaned task ${orphan.handle} (job ${orphan.job})`,
    );
  }
} catch (error) {
  console.error(`fleet: orphan reconcile failed at boot: ${String(error)}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    daemon.stop().finally(() => process.exit(0));
  });
}
