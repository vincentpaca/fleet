/**
 * Workspace git lifecycle (issue #2): clone the repo onto a job branch that
 * is pushed at creation — so retain-for-evidence holds even if the container
 * dies — commit and push the work at settle, and expose the WIP push that
 * parking (#6) will call.
 *
 * PR delivery (issue #3): createDraftPr opens a draft PR when authority.publish
 * is granted. getHeadSha exposes the current HEAD for logging and the settle
 * report. setupWorkspace now returns {branch, base} so the caller knows the
 * base branch without re-querying the remote.
 *
 * Activation: the runner calls setupWorkspace only when FLEET_GIT_URL is set.
 * The CLI resolves the manifest's workspace.repo at dispatch (including the
 * "origin" sentinel) and ships it as env; providers stay git-agnostic.
 *
 * Called from inside the sandbox, with one host-side exception: `fleet
 * resume-push` (#38) reuses pushWork/remoteHasHead/getHeadSha against a
 * workspace the runner left behind, so these three must stay pure functions of
 * a workspace path — no runner env, no daemon.
 *
 * The provider stages the dispatch payload (.fleet/manifest.json, order.json,
 * sync files) into the workspace BEFORE the clone. Those must survive the
 * checkout and must never be committed: staged files are captured in memory,
 * restored after checkout, ignored via .git/info/exclude when untracked, and
 * flagged skip-worktree when the repo itself tracks a file of the same path
 * (the dispatched manifest wins over the cloned one, but is never pushed).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// The gh-executor seam (inject in tests; defaults to the real gh CLI) is
// shared with the daemon's rung verification — one definition (#128).
import type { GhRunner } from '../shared/git.ts';

export type GitSetupOptions = {
  url: string;
  jobId: string;
  target: string;
  /** Committer identity; falls back to existing git config when absent. */
  name?: string;
  email?: string;
  /** Fetch depth; enough history for context without full clones. */
  depth?: number;
  /**
   * Re-entry mode (issue #6): fetch and check out the existing job branch
   * (which carries the WIP commit from parking) instead of creating a fresh
   * branch from the base. Does NOT push — the branch already exists on the
   * remote, so there is no collision guard to trip.
   */
  reentry?: boolean;
  /**
   * Branch adoption (issue #80): a followthrough dispatch continuing an
   * existing PR names that PR's head branch here. Same mechanics as re-entry —
   * fetch, check out, set upstream, no creation push — but on the adopted
   * branch instead of this job's own fleet/<target>-<jobId> name, so work
   * pushes update the existing PR in place.
   */
  adoptBranch?: string;
};

const STAGED_ALWAYS = ['.fleet/manifest.json', '.fleet/order.json'];

/**
 * Credential wiring for https remotes. When the job env carries a GitHub
 * token (GH_TOKEN or GITHUB_TOKEN — both spellings reach gh), expose gh as
 * git's credential helper for github.com through GIT_CONFIG_* env vars.
 * The runner's main applies this to its own process.env once, before the
 * gate: everything a job spawns (this module's git calls, the pickup gate,
 * the repo's harness and its agent) inherits it. Env-scoped on purpose: the
 * process provider runs on the operator's own machine, and nothing here may
 * touch their git config. Containers have no other helper, so this is the
 * one that answers; on an operator machine it appends to their existing
 * helpers, which keep working.
 */
export function gitCredentialEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) return {};
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '!gh auth git-credential',
  };
}

/**
 * Bound on the gh calls at settle (#152). Generous — a PR create over a
 * working connection is seconds — because its only job is to keep a hung gh
 * from wedging the runner until the daemon's backstop reaps it. Network git
 * calls take their bound per call instead: the caller knows what budget the
 * push sits inside (the cancel teardown's slice is far tighter than this).
 */
const GH_TIMEOUT_MS = 120_000;

/**
 * The one chokepoint for git/gh invocations. `timeoutMs` bounds the call with
 * SIGKILL, not the default SIGTERM: a push hung on a black-holed connection
 * shrugs off SIGTERM the same way the pickup gate did (#111), and an ignored
 * kill leaves execFileSync blocked past its own timeout — the wedge the
 * timeout exists to break. A timed-out call throws an error that names the
 * timeout, so the log lines built from err.message distinguish "the push
 * hung" from every other push failure (#152).
 */
function runTool(tool: 'git' | 'gh', workspace: string, args: string[], timeoutMs?: number): string {
  try {
    return execFileSync(tool, args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(timeoutMs !== undefined ? { timeout: timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`${tool} ${args[0]} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

function git(workspace: string, args: string[], timeoutMs?: number): string {
  return runTool('git', workspace, args, timeoutMs);
}

/** Default gh executor for findOpenPr/createDraftPr — bounded (#152). */
function defaultGhRun(workspace: string): GhRunner {
  return (args: string[]) => runTool('gh', workspace, args, GH_TIMEOUT_MS);
}

/** fleet/<target>-<jobId>, target sanitized to git-ref-safe characters. */
export function jobBranch(target: string, jobId: string): string {
  const safe = target.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'work';
  return `fleet/${safe}-${jobId}`;
}

/** Sync paths from the staged manifest, so they can be preserved + excluded. */
function stagedPaths(workspace: string): string[] {
  const paths = [...STAGED_ALWAYS];
  try {
    const manifest = JSON.parse(readFileSync(join(workspace, '.fleet', 'manifest.json'), 'utf8'));
    for (const rel of manifest?.workspace?.sync ?? []) {
      if (typeof rel === 'string') paths.push(rel);
    }
  } catch {
    // No readable manifest staged: nothing extra to preserve.
  }
  return paths;
}

/** Default branch of the remote, from its HEAD symref. */
function defaultRef(workspace: string, url: string): string {
  const out = git(workspace, ['ls-remote', '--symref', url, 'HEAD']);
  const match = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (!match) throw new Error(`cannot resolve default branch of ${url}`);
  return match[1];
}

/** Capture the dispatch payload in memory before git touches the tree. */
function preserveDispatchFiles(workspace: string): Map<string, Buffer> {
  const preserved = new Map<string, Buffer>();
  for (const rel of stagedPaths(workspace)) {
    const abs = join(workspace, rel);
    if (existsSync(abs)) preserved.set(rel, readFileSync(abs));
  }
  return preserved;
}

/**
 * Fetch and check out the job branch. Re-entry/adoption uses the existing
 * remote branch; a fresh dispatch creates it from the default branch.
 */
function checkoutBranch(workspace: string, branch: string, base: string, existing: boolean, depth?: number): void {
  if (existing) {
    // Re-entry or adoption: the branch already exists on the remote (WIP
    // commit from parking, or the continued PR's head). Fetch it, check it
    // out, and set the upstream tracking so subsequent pushes work without
    // specifying the remote.
    git(workspace, ['fetch', '--depth', String(depth ?? 50), '-q', 'origin', branch]);
    git(workspace, ['checkout', '-q', '-f', '-B', branch, 'FETCH_HEAD']);
    git(workspace, ['branch', '--set-upstream-to', 'origin/' + branch, branch]);
  } else {
    git(workspace, ['fetch', '--depth', String(depth ?? 50), '-q', 'origin', base]);
    git(workspace, ['checkout', '-q', '-f', '-B', branch, 'FETCH_HEAD']);
  }
}

/**
 * Restore the dispatch payload over the checkout and build the exclude list.
 * Tracked files get skip-worktree; untracked files go into .git/info/exclude.
 * Returns the full exclude list so the caller can write it once.
 */
function restoreDispatchFiles(workspace: string, preserved: Map<string, Buffer>): string[] {
  const excludes: string[] = ['.fleet/out/'];
  for (const [rel, content] of preserved) {
    const abs = join(workspace, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const tracked = git(workspace, ['ls-files', '--', rel]).trim() !== '';
    if (tracked) git(workspace, ['update-index', '--skip-worktree', '--', rel]);
    else excludes.push(rel);
  }
  return excludes;
}

/**
 * Turn the staged workspace into a checkout of the repo on the job branch,
 * and push the branch immediately. Returns the branch name and base branch.
 */
export function setupWorkspace(workspace: string, opts: GitSetupOptions): { branch: string; base: string } {
  const branch = opts.adoptBranch ?? jobBranch(opts.target, opts.jobId);
  // Adoption and re-entry share the checkout path: the branch already exists
  // on the remote, so neither creates nor pushes anything at setup.
  const existing = opts.reentry === true || opts.adoptBranch !== undefined;

  const preserved = preserveDispatchFiles(workspace);

  git(workspace, ['init', '-q']);
  if (opts.name) git(workspace, ['config', 'user.name', opts.name]);
  if (opts.email) git(workspace, ['config', 'user.email', opts.email]);
  git(workspace, ['remote', 'add', 'origin', opts.url]);
  const base = defaultRef(workspace, opts.url);

  checkoutBranch(workspace, branch, base, existing, opts.depth);

  // Restore the dispatch payload over whatever the clone brought in, and make
  // sure none of it can ever be committed or pushed.
  const excludes = restoreDispatchFiles(workspace, preserved);
  mkdirSync(join(workspace, '.git', 'info'), { recursive: true });
  appendFileSync(join(workspace, '.git', 'info', 'exclude'), excludes.join('\n') + '\n');

  if (!existing) {
    // Initial setup: push the branch immediately so evidence is preserved even
    // if the container dies before any work is committed.
    git(workspace, ['push', '-q', '-u', 'origin', branch]);
  }
  return { branch, base };
}

/**
 * Commit everything and push. Outcomes:
 * - 'pushed': this call moved the remote.
 * - 'delivered': the remote branch already carries work beyond base (the agent
 *   pushed itself; possibly our push then failed on a post-push amend). The
 *   delivery exists regardless of who pushed it — #34/#37 attempt runs were
 *   mislabeled "clean" for exactly this.
 * - 'clean': nothing committed anywhere; there is no deliverable.
 *
 * `timeoutMs` bounds the network calls only (the push, and the verification
 * fetch on its failure path) — local add/commit/rev-list cannot hang on a
 * dead connection and a large tree must not trip a bound meant for one (#152).
 */
function commitAndPush(workspace: string, message: string, base?: string, timeoutMs?: number): 'pushed' | 'delivered' | 'clean' {
  git(workspace, ['add', '-A']);
  const staged = git(workspace, ['status', '--porcelain']).trim();
  if (staged !== '') git(workspace, ['commit', '-q', '-m', message]);
  const ahead = git(workspace, ['rev-list', '--count', '@{upstream}..HEAD']).trim();
  if (staged !== '' || ahead !== '0') {
    try {
      git(workspace, ['push', '-q'], timeoutMs);
      return 'pushed';
    } catch (err) {
      // Push rejected (e.g. the agent amended after its own push). Fall through:
      // judge delivery by what the remote actually has.
      if (remoteAheadOfBase(workspace, base, timeoutMs)) return 'delivered';
      throw err;
    }
  }
  return remoteAheadOfBase(workspace, base, timeoutMs) ? 'delivered' : 'clean';
}

/** Does the remote branch carry commits beyond the base branch? */
function remoteAheadOfBase(workspace: string, base?: string, timeoutMs?: number): boolean {
  if (!base) return false;
  try {
    git(workspace, ['fetch', '-q', 'origin'], timeoutMs);
    const branch = git(workspace, ['branch', '--show-current']).trim();
    const count = git(workspace, ['rev-list', '--count', `origin/${base}..origin/${branch}`]).trim();
    return count !== '0';
  } catch {
    return false;
  }
}

/** The work commit at settle. Pushes partial work too — evidence over tidiness. */
export function pushWork(workspace: string, target: string, jobId: string, ok: boolean, base?: string, timeoutMs?: number): 'pushed' | 'delivered' | 'clean' {
  return commitAndPush(workspace, `${target}: fleet job ${jobId}${ok ? '' : ' (partial)'}`, base, timeoutMs);
}

/** The WIP commit when a blocked job parks (#6 calls this). */
export function pushWip(workspace: string, reason: string, timeoutMs?: number): 'pushed' | 'clean' {
  return commitAndPush(workspace, `wip(park): ${reason}`, undefined, timeoutMs);
}

/** HEAD SHA after all commits; used for settle reporting. */
export function getHeadSha(workspace: string): string {
  return git(workspace, ['rev-parse', 'HEAD']).trim();
}

/**
 * Does origin/<branch> contain this workspace's HEAD? The delivery test for a
 * late push (#38): 'delivered' only says the remote branch is ahead of base —
 * it can be ahead with somebody else's commit while this HEAD exists nowhere
 * but here. `fleet resume-push` deletes the workspace on this answer alone.
 */
export function remoteHasHead(workspace: string, branch: string): boolean {
  try {
    git(workspace, ['fetch', '-q', 'origin', branch]);
    git(workspace, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
    return true;
  } catch {
    // Unreachable remote, missing branch, or HEAD not an ancestor — all "no".
    return false;
  }
}

/**
 * Did the remote branch gain commits beyond a known SHA? The delivery test for
 * an adopted branch (#80): pushWork's 'delivered' only says the branch is ahead
 * of base, which an adopted PR branch always is — the original job's commits
 * are on it. Judging a followthrough by that would claim a rung for doing
 * nothing. `sinceSha` is the adopted branch tip captured at setup.
 */
export function remoteMovedBeyond(workspace: string, branch: string, sinceSha: string, timeoutMs?: number): boolean {
  try {
    git(workspace, ['fetch', '-q', 'origin', branch], timeoutMs);
    const count = git(workspace, ['rev-list', '--count', `${sinceSha}..FETCH_HEAD`]).trim();
    return count !== '0';
  } catch {
    // Unreachable remote or unknown SHA — never claim movement it cannot prove.
    return false;
  }
}

/**
 * The open PR whose head is `branch`, or undefined when none exists (issue
 * #80): a followthrough that adopted a branch reports the existing PR at
 * settle instead of creating one. Same GhRunner seam as createDraftPr.
 */
export function findOpenPr(workspace: string, branch: string, ghRun?: GhRunner): { url: string; number: number } | undefined {
  const run = ghRun ?? defaultGhRun(workspace);
  const out = run(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url,number', '--limit', '1']);
  const parsed = JSON.parse(out) as { url?: unknown; number?: unknown }[];
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  if (first && typeof first.url === 'string' && typeof first.number === 'number') {
    return { url: first.url, number: first.number };
  }
  return undefined;
}

/**
 * Compose PR title and body per the delivery standard (AGENTS.md#delivery-standard).
 * Pure: (target, issueTitle, report) → text. Title is never a bare number; body
 * renders the settle report as sections, not raw JSON. Thin inputs degrade to
 * honest minimal text, never to machine exhaust.
 */
export function composeDraftPrText(opts: {
  target: string;
  issueTitle?: string;
  jobId: string;
  report?: {
    status?: string;
    verification?: string[] | string;
    not_done?: string[] | string;
    next_action?: string;
  };
}): { title: string; body: string } {
  const ref = /^\d+$/.test(opts.target) ? `#${opts.target}` : opts.target;
  const title = opts.issueTitle ? `${ref}: ${opts.issueTitle}` : `${ref}: fleet job ${opts.jobId}`;
  const list = (v: string[] | string | undefined): string[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  const r = opts.report;
  const lines: string[] = [
    '## Problem',
    `${opts.issueTitle ?? 'See the referenced work item.'}${/^\d+$/.test(opts.target) ? ` Closes ${ref}.` : ''}`,
    '',
    '## Status',
    r?.status ? `${r.status}` : 'No report was produced — inspect the job transcript before reviewing.',
  ];
  const ver = list(r?.verification);
  lines.push('', '## Verification', ...(ver.length ? ver.map((v) => `- ${v}`) : ['- none reported']));
  const nd = list(r?.not_done);
  lines.push('', '## Not done', ...(nd.length ? nd.map((v) => `- ${v}`) : ['- nothing']));
  if (r?.next_action) lines.push('', `Next action: ${r.next_action}`);
  lines.push('', `_Fleet job ${opts.jobId}; full transcript: \`fleet logs ${opts.jobId}\`._`);
  return { title, body: lines.join('\n') };
}

/**
 * Open a draft PR and return its URL (issue #3: authority.publish).
 * Caller provides a ghRun callback for testability; the real runner uses the
 * default which shells out to `gh`.
 *
 * The PR body receives the settle report verbatim so reviewers see what the
 * agent claims it accomplished. The URL is returned so the runner can embed it
 * in the settle event's report.pr field.
 *
 * Never merges — no code path in this function can call a merge API.
 */
export function createDraftPr(workspace: string, opts: {
  base: string;
  branch: string;
  title: string;
  body: string;
  ghRun?: GhRunner;
}): string {
  const run = opts.ghRun ?? defaultGhRun(workspace);
  return run([
    'pr', 'create',
    '--draft',
    '--base', opts.base,
    '--head', opts.branch,
    '--title', opts.title,
    '--body', opts.body,
  ]).trim();
}
