// Provider contract: how the daemon launches and terminates job sandboxes.

export type LaunchSpec = {
  jobId: string;
  /** How the runner reaches the daemon: http://127.0.0.1:port, or unix:<path>. */
  daemonUrl: string;
  runnerToken: string;
  image?: string;
  /** Extra environment for the sandbox (operator-supplied values). */
  env: Record<string, string>;
  /** Files to materialise in the workspace: relPath -> base64 content. */
  sync: Record<string, string>;
  manifest: unknown;
  workOrder: unknown;
};

export interface Provider {
  readonly name: string;
  launch(spec: LaunchSpec): Promise<{ handle: string }>;
  terminate(handle: string): Promise<void>;
}

/** FLEET_* env every provider injects into the sandbox. */
export function runnerEnv(spec: LaunchSpec, workspace: string): Record<string, string> {
  return {
    ...spec.env,
    FLEET_JOB_ID: spec.jobId,
    FLEET_DAEMON_URL: spec.daemonUrl,
    FLEET_RUNNER_TOKEN: spec.runnerToken,
    FLEET_WORKSPACE: workspace,
  };
}
