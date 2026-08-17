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

/** Inject a gh executor in tests; defaults to the real gh CLI. */
export type GhRunner = (args: string[]) => string;

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
};

const STAGED_ALWAYS = ['.fleet/manifest.json', '.fleet/order.json'];

function git(workspace: string, args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * Turn the staged workspace into a checkout of the repo on the job branch,
 * and push the branch immediately. Returns the branch name and base branch.
 */
export function setupWorkspace(workspace: string, opts: GitSetupOptions): { branch: string; base: string } {
  const branch = jobBranch(opts.target, opts.jobId);

  // Capture the dispatch payload before git touches the tree.
  const preserved = new Map<string, Buffer>();
  for (const rel of stagedPaths(workspace)) {
    const abs = join(workspace, rel);
    if (existsSync(abs)) preserved.set(rel, readFileSync(abs));
  }

  git(workspace, ['init', '-q']);
  if (opts.name) git(workspace, ['config', 'user.name', opts.name]);
  if (opts.email) git(workspace, ['config', 'user.email', opts.email]);
  git(workspace, ['remote', 'add', 'origin', opts.url]);
  const base = defaultRef(workspace, opts.url);
  if (opts.reentry) {
    // Re-entry: the job branch already exists on the remote (carries the WIP
    // commit from parking). Fetch it, check it out, and set the upstream
    // tracking so subsequent pushes work without specifying the remote.
    git(workspace, ['fetch', '--depth', String(opts.depth ?? 50), '-q', 'origin', branch]);
    git(workspace, ['checkout', '-q', '-f', '-B', branch, 'FETCH_HEAD']);
    git(workspace, ['branch', '--set-upstream-to', `origin/${branch}`, branch]);
  } else {
    git(workspace, ['fetch', '--depth', String(opts.depth ?? 50), '-q', 'origin', base]);
    git(workspace, ['checkout', '-q', '-f', '-B', branch, 'FETCH_HEAD']);
  }

  // Restore the dispatch payload over whatever the clone brought in, and make
  // sure none of it can ever be committed or pushed.
  const excludes: string[] = ['.fleet/out/'];
  for (const [rel, content] of preserved) {
    const abs = join(workspace, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const tracked = git(workspace, ['ls-files', '--', rel]).trim() !== '';
    if (tracked) git(workspace, ['update-index', '--skip-worktree', '--', rel]);
    else excludes.push(rel);
  }
  mkdirSync(join(workspace, '.git', 'info'), { recursive: true });
  appendFileSync(join(workspace, '.git', 'info', 'exclude'), excludes.join('\n') + '\n');

  if (!opts.reentry) {
    // Initial setup: push the branch immediately so evidence is preserved even
    // if the container dies before any work is committed.
    git(workspace, ['push', '-q', '-u', 'origin', branch]);
  }
  return { branch, base };
}

/** Commit everything and push. Returns 'clean' when there was nothing to commit. */
function commitAndPush(workspace: string, message: string): 'pushed' | 'clean' {
  git(workspace, ['add', '-A']);
  const staged = git(workspace, ['status', '--porcelain']).trim();
  if (staged === '') return 'clean';
  git(workspace, ['commit', '-q', '-m', message]);
  git(workspace, ['push', '-q']);
  return 'pushed';
}

/** The work commit at settle. Pushes partial work too — evidence over tidiness. */
export function pushWork(workspace: string, target: string, jobId: string, ok: boolean): 'pushed' | 'clean' {
  return commitAndPush(workspace, `${target}: fleet job ${jobId}${ok ? '' : ' (partial)'}`);
}

/** The WIP commit when a blocked job parks (#6 calls this). */
export function pushWip(workspace: string, reason: string): 'pushed' | 'clean' {
  return commitAndPush(workspace, `wip(park): ${reason}`);
}

/** HEAD SHA after all commits; used for settle reporting. */
export function getHeadSha(workspace: string): string {
  return git(workspace, ['rev-parse', 'HEAD']).trim();
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
  const run = opts.ghRun ?? ((args: string[]) =>
    execFileSync('gh', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  return run([
    'pr', 'create',
    '--draft',
    '--base', opts.base,
    '--head', opts.branch,
    '--title', opts.title,
    '--body', opts.body,
  ]).trim();
}
