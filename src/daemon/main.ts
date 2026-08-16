// Fleet daemon entrypoint: `node src/daemon/main.ts`.
// Env: FLEET_HOME (default ~/.fleet), FLEET_PORT (optional TCP listener),
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

const daemon = new FleetDaemon({
  home,
  provider: await pickProvider(process.env.FLEET_PROVIDER ?? "process"),
  port,
});

const { socketPath: sock, port: boundPort } = await daemon.start();
console.log(`fleet daemon listening on ${sock}${boundPort !== null ? ` and 127.0.0.1:${boundPort}` : ""}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    daemon.stop().finally(() => process.exit(0));
  });
}
