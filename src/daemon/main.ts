// Fleet daemon entrypoint: `node src/daemon/main.ts`.
// Env: FLEET_HOME (default ~/.fleet), FLEET_PORT (optional TCP listener),
// FLEET_DAEMON_HOST (IP/host to advertise in daemonUrl; default 127.0.0.1;
//   auto-discovered from ECS container metadata when FLEET_PORT is set and
//   ECS_CONTAINER_METADATA_URI_V4 is present),
// FLEET_PROVIDER (process | docker | ecs; default process), FLEET_NOTIFY_WEBHOOK
// (optional, comma-separated URLs; {text} payload per decision).
import { mkdirSync } from "node:fs";
import { fleetHome } from "../shared/home.ts";
import { FleetDaemon } from "./server.ts";
import { ProcessProvider } from "../providers/process.ts";
import { DockerProvider } from "../providers/docker.ts";
import { EcsProvider, ecsConfigFromEnv, ecsConfigFromSsm } from "../providers/ecs.ts";
import type { Provider } from "../providers/provider.ts";

async function pickProvider(name: string): Promise<Provider> {
  switch (name) {
    case "process":
      return new ProcessProvider();
    case "docker":
      return new DockerProvider();
    case "ecs": {
      // FLEET_ECS_CLUSTER being set signals an explicit env override (tests,
      // manual deployments).  Otherwise read the SSM parameter that the infra
      // unit wrote at apply time so no FLEET_ECS_* vars need to be hand-set.
      const ssmPath = process.env.FLEET_ECS_CONFIG_SSM_PATH;
      if (ssmPath && !process.env.FLEET_ECS_CLUSTER) {
        return new EcsProvider(await ecsConfigFromSsm(ssmPath));
      }
      return new EcsProvider(ecsConfigFromEnv());
    }
    default:
      throw new Error(`unknown FLEET_PROVIDER: ${name} (expected process | docker | ecs)`);
  }
}

const home = fleetHome();
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

const daemon = new FleetDaemon({
  home,
  provider: await pickProvider(process.env.FLEET_PROVIDER ?? "process"),
  port,
  bindHost,
  tcpHost,
});

const { socketPath: sock, port: boundPort } = await daemon.start();
console.log(`fleet daemon listening on ${sock}${boundPort !== null ? ` and ${bindHost}:${boundPort} (advertising ${tcpHost})` : ""}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    daemon.stop().finally(() => process.exit(0));
  });
}
