/**
 * Git URL normalization for token-authenticated containers.
 *
 * Job containers hold no SSH keys — their only git credential is a GitHub
 * token shipped through manifest env.vars. An ssh remote URL is therefore
 * unusable inside a sandbox, while an https one works everywhere the token
 * does (including the operator's own machine, where gh serves it as a
 * credential helper — see src/runner/git.ts).
 *
 * Scope: github.com only. Other hosts keep their URL untouched — rewriting
 * without a credential that can serve the host would break what ssh-agent
 * still covers on the process provider. Generic hosts arrive with the
 * credential broker (phase 2).
 */

/** ssh github.com remote (scp-like or ssh://) → https; anything else verbatim. */
export function toHttpsGitUrl(url: string): string {
  const scp = url.match(/^git@github\.com:(.+)$/);
  if (scp) return `https://github.com/${scp[1]}`;
  const ssh = url.match(/^ssh:\/\/git@github\.com\/(.+)$/);
  if (ssh) return `https://github.com/${ssh[1]}`;
  return url;
}
