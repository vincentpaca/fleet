// Fleet daemon entrypoint: `node src/daemon/main.ts`.
// Env: FLEET_HOME (default ~/.fleet), FLEET_PORT (optional TCP listener),
// FLEET_DAEMON_HOST (IP/host to advertise in daemonUrl; default 127.0.0.1;
//   auto-discovered from ECS container metadata when FLEET_PORT is set and
//   ECS_CONTAINER_METADATA_URI_V4 is present),
// FLEET_PROVIDER (process | docker | ecs; default process), FLEET_NOTIFY_WEBHOOK
// (optional, comma-separated URLs; {text} payload per decision).
// Logs four terse `fleet daemon: ` lines at boot (home, provider, config source,
// listen address; a fifth when it discovers its IP from ECS metadata) and nothing
// per-request — see test/daemon-boot-log.test.ts.
import { mkdirSync } from "node:fs";
import { fleetHome } from "../shared/home.ts";
import { loadOrCreateOperatorToken, FleetDaemon } from "./server.ts";
import { ProcessProvider } from "../providers/process.ts";
import { DockerProvider } from "../providers/docker.ts";
import { EcsProvider, ecsConfigFromEnv, ecsConfigFromSsm } from "../providers/ecs.ts";
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
    default:
      throw new Error(`unknown FLEET_PROVIDER: ${choice.name} (expected process | docker | ecs)`);
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
const daemon = new FleetDaemon({
  home,
  provider,
  port,
  bindHost,
  tcpHost,
  operatorToken: loadOrCreateOperatorToken(home),
});

const { socketPath: sock, port: boundPort } = await daemon.start();
// Same `fleet daemon: ` prefix as the lines above: one filter on a log stream
// must not drop the line that says the daemon is up.
console.log(`fleet daemon: listening on ${sock}${boundPort !== null ? ` and ${bindHost}:${boundPort} (advertising ${tcpHost})` : ""}`);

// Only after start() holds the home lock: settle what a previous daemon's
// death orphaned (#123). Quiet unless it acts, and never on stdout — the boot
// lines above are a pinned contract (test/daemon-boot-log.test.ts).
await provider.recover?.();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    daemon.stop().finally(() => process.exit(0));
  });
}
