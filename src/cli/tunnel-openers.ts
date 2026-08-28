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
  operatorTokenSsmPath,
  parseFleetConfigSsmResponse,
  parseSsmParameterValue,
  type FleetConfig,
} from '../providers/ecs.ts';
import {
  buildSecretAccessArgs,
  gcloudCli,
  gcpDaemonAccessFromFleetConfig,
  gcpTunnelOpener,
} from '../providers/gcp.ts';

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
  if (provider === 'gcp') {
    const access = gcpDaemonAccessFromFleetConfig(deployment.config);
    return { open: gcpTunnelOpener(access), remotePort: access.port };
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
  // gcp offers no live source by design: its config is a terraform-rendered
  // env file on the daemon VM, not a parameter the CLI can re-read. A stale
  // gcp capture is re-captured from `terraform output -json fleet_config`.
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

/**
 * Fetch the operator token the deployment's daemon published at boot (#188),
 * for a CLI whose local copy is absent or refused. Same dispatch shape as
 * refreshDeployment above: the captured config names its own config parameter,
 * the token is the sibling `operator-token` under that prefix, and the read
 * runs with the operator's existing AWS credentials. Returns undefined when
 * this provider offers no such source or the config does not name one — the
 * caller then falls back to the 401 the daemon already gave it.
 */
export function fetchDeploymentOperatorToken(
  config: Record<string, unknown>,
  run?: CloudRunner,
): Promise<string> | undefined {
  if (config.provider === 'gcp') {
    // The GCP daemon publishes a version of the unit-created secret at boot;
    // `versions access` prints the raw payload. Fetched with the operator's
    // own gcloud credentials, exactly like the SSM read below uses their AWS
    // ones.
    const secret = config.operator_token_secret;
    const project = config.project;
    if (typeof secret !== 'string' || secret === '' || typeof project !== 'string' || project === '') return undefined;
    return (run ?? gcloudCli)(buildSecretAccessArgs(project, secret)).then((stdout) => stdout.trim());
  }
  if (config.provider !== 'ecs') return undefined;
  const ssmPath = config.ssm_config_path;
  if (typeof ssmPath !== 'string' || ssmPath === '') return undefined;
  // --with-decryption and --region for the same reasons refreshDeployment
  // passes them: SecureString, and the parameter lives in the deployment's
  // region, not the caller's ambient one (#138).
  const args = ['ssm', 'get-parameter', '--name', operatorTokenSsmPath(ssmPath), '--with-decryption', '--output', 'json'];
  if (typeof config.region === 'string' && config.region !== '') args.push('--region', config.region);
  return (run ?? awsCli)(args).then((stdout) => parseSsmParameterValue(stdout).trim());
}
