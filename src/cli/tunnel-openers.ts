/**
 * Composition root for operator access: a captured deployment's `provider`
 * chooses the cloud that knows how to reach into it. This file is the ONE place
 * in core allowed to import a concrete provider (test/cloud-agnostic.test.ts
 * lists it beside src/daemon/main.ts, which does the same for launching), so
 * everything here is dispatch and nothing else — no supervision, no I/O of its
 * own, no policy. Adding a cloud means adding a case here and an implementation
 * in src/providers/<name>.ts.
 */
import type { CloudCliRunner, TunnelOpener } from '../providers/provider.ts';
import {
  awsCli,
  ecsDaemonAccessFromFleetConfig,
  ecsTunnelOpener,
  parseFleetConfigSsmResponse,
  type FleetConfig,
} from '../providers/ecs.ts';

/** Re-exported so core can name the type without importing a cloud. */
export type CloudRunner = CloudCliRunner;

/**
 * A deployment description and where it was read from. The config stays
 * untyped in core: only the provider knows which fields it needs, and it
 * validates them field-by-field when it is handed one.
 */
export type Deployment = {
  /** Human-readable origin: a file path, or a live parameter name. */
  source: string;
  config: Record<string, unknown>;
  /** daemon_url captured alongside the config, when the operator added one. */
  daemonUrl?: string;
};

/** How to open a tunnel into this deployment, and the port it lands on inside. */
export function tunnelOpenerFor(deployment: Deployment): { open: TunnelOpener; remotePort: number } {
  const provider = deployment.config.provider;
  if (provider === 'ecs') {
    // Cast, not trust: ecsDaemonAccessFromFleetConfig names every field it
    // needs and throws when the capture is missing one.
    const access = ecsDaemonAccessFromFleetConfig(deployment.config as FleetConfig);
    return { open: ecsTunnelOpener(access), remotePort: access.port };
  }
  throw new Error(
    `no tunnel implementation for provider "${provider}" (from ${deployment.source}) — use that unit's connect_hint output by hand`,
  );
}

/**
 * Re-read a deployment's own description from the live source it names, for a
 * captured file that predates a field. Returns undefined when this provider
 * offers no such source, or when the config does not name one — the caller then
 * has to tell the operator to re-capture.
 */
export function refreshDeployment(
  config: Record<string, unknown>,
  run: CloudRunner = awsCli,
): Promise<{ source: string; config: Record<string, unknown> }> | undefined {
  if (config.provider !== 'ecs') return undefined;
  const ssmPath = config.ssm_config_path;
  if (typeof ssmPath !== 'string' || ssmPath === '') return undefined;
  // --with-decryption: the parameter is a SecureString (infra/aws/main.tf), and
  // without it the call returns ciphertext that fails to parse.
  // --region when the capture names one (#138): the parameter lives in the
  // deployment's region, and the ambient region — the only other candidate —
  // being wrong is a likely reason the operator is refreshing at all.
  const args = ['ssm', 'get-parameter', '--name', ssmPath, '--with-decryption', '--output', 'json'];
  if (typeof config.region === 'string' && config.region !== '') args.push('--region', config.region);
  return run(args).then((stdout) => ({
    source: `SSM parameter ${ssmPath}`,
    config: parseFleetConfigSsmResponse(stdout),
  }));
}
