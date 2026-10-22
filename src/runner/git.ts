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
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// The gh-executor seam (inject in tests; defaults to the real gh CLI) is
// shared with the daemon's rung verification — one definition (#128).
import type { GhRunner } from '../shared/git.ts';
import { displayTarget, isIssueTarget } from '../shared/issue-ref.ts';

type GitSetupOptions = {
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
   * Branch adoption (issue #80): a dispatch continuing an existing PR names
   * that PR's head branch here. Same mechanics as re-entry — fetch, check out,
   * set upstream, no creation push — but on the adopted branch instead of this
   * job's own fleet/<target>-<jobId> name, so work pushes update the existing
   * PR in place.
   */
  adoptBranch?: string;
  /**
   * Harness-exit auto-retry (#30): which launch attempt this is (2 = the one
   * automatic retry). The previous attempt pushed this job's branch — same job
   * id, same name — so before creating its own, this attempt renames the
   * remote branch to <branch>-attempt<n-1>: the claim is released and the
   * creation push cannot collide, while the pushed evidence stays reachable.
   */
  retryAttempt?: number;
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
  // Merge with inherited GIT_CONFIG_* (#139): the job env may already carry
  // config entries (an operator's own injection, a CI harness). Returning a
  // hardcoded GIT_CONFIG_COUNT of 1 silently clobbered them — append the
  // helper at the next index instead.
  const inherited = parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
  const next = Number.isInteger(inherited) && inherited > 0 ? inherited : 0;
  return {
    GIT_CONFIG_COUNT: String(next + 1),
    [`GIT_CONFIG_KEY_${next}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${next}`]: '!gh auth git-credential',
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
function runTool(tool: 'git' | 'gh', workspace: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(tool, args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env !== undefined ? { env } : {}),
      ...(timeoutMs !== undefined ? { timeout: timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`${tool} ${args[0]} timed out after ${timeoutMs}ms`);
    }
    // Callers log err.message's first line, and execFileSync's first line is
    // the argv echoed back — the diagnosis (the tool's stderr) sat below the
    // fold and never reached a settle report (#218). Refold to one line naming
    // the subcommand and the first stderr line.
    const stderr = (err as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' ? stderr.trim().split('\n')[0] : '';
    if (detail !== '') throw new Error(`${tool} ${args[0]} failed: ${detail}`);
    throw err;
  }
}

function git(workspace: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv): string {
  return runTool('git', workspace, args, timeoutMs, env);
}

/** Default gh executor for findOpenPr/createDraftPr — bounded (#152). */
function defaultGhRun(workspace: string): GhRunner {
  return (args: string[]) => runTool('gh', workspace, args, GH_TIMEOUT_MS);
}

/**
 * Longest a single path component of a ref may be. A loose ref is a file and
 * git locks it by creating `<name>.lock` beside it, so the ceiling is the
 * filesystem's NAME_MAX (255 on ext4 and APFS) less those five characters.
 * Measured, not assumed: a 250-character component is created, 251 fails with
 * `cannot lock ref ...: File name too long`.
 */
const REF_COMPONENT_MAX = 250;

/**
 * Held back from a branch's last component for the `-<jobId>` that makes two
 * jobs on one target distinct (21 characters from newId, with slack), the
 * `-<digest>` a cut target carries (9), plus the
 * `-attempt<n>` a claim release appends to the whole name (releaseRetryClaim,
 * `fleet reclaim`) — a job branch that cannot be released is the same dead end
 * as one that cannot be created. Fixed rather than measured off the actual id:
 * `fleet reclaim` matches claims by jobBranch(target, ''), which only stays a
 * prefix of jobBranch(target, jobId) if the target is cut to the same width
 * either way.
 */
const BRANCH_SUFFIX_RESERVE = 50;

/** Width of the digest that keeps two cut-to-the-same-prefix targets apart. */
const TARGET_DIGEST_LEN = 8;

/**
 * fleet/<target>-<jobId>, target sanitized to git-ref-safe characters and cut
 * to what git can lock. Prose targets are whole prompts (the canary's is 223
 * characters after sanitizing), and an over-long name failed as a dead job at
 * setupWorkspace. The jobId is appended after the cut, never inside it.
 *
 * Cutting alone would collapse two long targets that agree on their first
 * `width` sanitized characters into one claim namespace, and `fleet reclaim
 * <target>` releases by that namespace — reclaiming one would rename the
 * other's live claim. So a cut name carries a digest of the WHOLE target.
 * Derived from the target and not the job id on purpose: jobBranch(target, '')
 * must stay a prefix of jobBranch(target, jobId) for reclaim to match at all.
 */
export function jobBranch(target: string, jobId: string): string { // contract pin: test-only export, asserted by the suite
  const safe = target
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // '.' survives the class above, so a target with an ellipsis in it reaches
    // git as '..' — which git rejects anywhere in a ref, killing the job at
    // setupWorkspace exactly as an over-long name did.
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  // Re-trim after the cut: it can land mid-separator, and git rejects a
  // component ending in '.'.
  const width = REF_COMPONENT_MAX - BRANCH_SUFFIX_RESERVE;
  const cut = safe.slice(0, width).replace(/[-.]+$/, '') || 'work';
  const digest = safe.length > width
    ? `-${createHash('sha256').update(target).digest('hex').slice(0, TARGET_DIGEST_LEN)}`
    : '';
  return `fleet/${cut}${digest}-${jobId}`;
}

/** Sequences git's ref rules forbid anywhere in a name (git-check-ref-format(1)). */
const REF_FORBIDDEN = /[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{/;

/** A slash-separated part of a ref: non-empty, lockable, not a .lock or dot-file name. */
function validRefComponent(part: string): boolean {
  return part !== ''
    && part.length <= REF_COMPONENT_MAX
    && !part.startsWith('.')
    && !part.endsWith('.')
    && !part.endsWith('.lock');
}

/**
 * The only characters an externally-chosen branch name may contain.
 *
 * git's own rules are the wrong shape for this boundary. git-check-ref-format(1)
 * happily permits `$`, backtick, `(`, `)`, `|`, `{`, `}` and every other byte it
 * has no use for — they are meaningless to git, so it does not care. But the
 * consumer downstream is not git: the name is interpolated verbatim into the
 * harness prompt (continuationClause, src/runner/harness.ts) and into a command
 * line. The threat is a name read as something other than a name — an
 * instruction to the agent, or a substitution to a shell — not a ref git would
 * refuse. A rules-check can only subtract what git happens to dislike; a
 * whitelist admits only what a branch name plausibly needs, so a character
 * nobody thought about is refused by default rather than admitted by default.
 * Mirrored as `pattern` on continues.branch in schemas/work-order.schema.json,
 * which is where the daemon enforces the same shape at intake.
 */
const BRANCH_NAME_ALLOWED = /^[A-Za-z0-9._/-]+$/;

/**
 * git-check-ref-format(1)'s rules for `refs/heads/<name>`, applied without
 * spawning git, AND THEN narrowed to BRANCH_NAME_ALLOWED, for names chosen
 * outside this system — a PR's headRefName is whatever the person who opened it
 * typed, and it travels from there into a prompt and into git argv here. Three
 * of git's own rules are also applied more tightly than a bare refname check:
 * a leading '-' (git reads it as an option), a bare '@' (git's own shorthand
 * for HEAD), and REF_COMPONENT_MAX (a legal refname git still cannot lock).
 */
export function validBranchName(name: string): boolean {
  if (name === '' || name.startsWith('-') || name === '@') return false;
  if (REF_FORBIDDEN.test(name)) return false;
  if (!BRANCH_NAME_ALLOWED.test(name)) return false;
  return name.split('/').every(validRefComponent);
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
 * Merge exclude entries into .git/info/exclude, deduped (#139): every launch
 * gets a fresh workspace today, but nothing structural guarantees that — a
 * reused workspace must never accrete duplicate entries. Read-merge-write,
 * not check-then-append: a read that treats a missing file as empty and one
 * whole-file write leave no exists/read/append window (js/file-system-race).
 */
function mergeExcludes(workspace: string, excludes: string[]): void {
  mkdirSync(join(workspace, '.git', 'info'), { recursive: true });
  const excludeFile = join(workspace, '.git', 'info', 'exclude');
  let current = '';
  try {
    current = readFileSync(excludeFile, 'utf8');
  } catch {
    // No exclude file yet: merge into empty content.
  }
  const present = new Set(current.split('\n'));
  const fresh = excludes.filter((line) => !present.has(line));
  if (fresh.length === 0) return;
  const head = current === '' || current.endsWith('\n') ? current : current + '\n';
  writeFileSync(excludeFile, head + fresh.join('\n') + '\n');
}

/**
 * Rename a branch on the remote without destroying its commits: copy the ref
 * to the new name, then delete the old one. The daemon has no workspace, so
 * this is how a claim branch is released from inside one — the auto-retry's
 * fresh runner (#30) and `fleet reclaim` both call it. Returns 'absent' when
 * the source branch does not exist on the remote (nothing to release —
 * a prior attempt that died before its creation push).
 */
export function renameRemoteBranch(workspace: string, from: string, to: string, timeoutMs?: number): 'renamed' | 'absent' {
  const listed = git(workspace, ['ls-remote', '--heads', 'origin', from], timeoutMs);
  if (listed.trim() === '') return 'absent';
  // Fetch the ref so the local repo holds the object FETCH_HEAD names — a
  // push can only send commits it has.
  git(workspace, ['fetch', '-q', 'origin', from], timeoutMs);
  git(workspace, ['push', '-q', 'origin', `FETCH_HEAD:refs/heads/${to}`], timeoutMs);
  git(workspace, ['push', '-q', 'origin', `:refs/heads/${from}`], timeoutMs);
  return 'renamed';
}

/** What a retry moved aside: its claim branch, and its side branch (#291). */
type Released = { released?: string; releasedSide?: string };

/**
 * Auto-retry (#30): release the previous attempt's claim before this attempt
 * creates its branch under the same name. Rename, never delete — the partial
 * work stays reachable at <branch>-attempt<n-1>. The side branch (#291) moves
 * aside the same way, so two attempts never merge into one. Returns the renamed
 * branch, or undefined when this launch is not a retry (or nothing was ever
 * pushed).
 */
function releaseRetryClaim(workspace: string, refs: JobRefs, existing: boolean, retryAttempt?: number): Released {
  if (existing || retryAttempt === undefined || retryAttempt <= 1) return {};
  const sideTo = refs.side + '-attempt' + (retryAttempt - 1);
  const claimTo = refs.branch + '-attempt' + (retryAttempt - 1);
  const side = renameRemoteBranch(workspace, refs.side, sideTo) === 'renamed';
  const claim = renameRemoteBranch(workspace, refs.branch, claimTo) === 'renamed';
  return { ...(claim ? { released: claimTo } : {}), ...(side ? { releasedSide: sideTo } : {}) };
}

/**
 * Turn the staged workspace into a checkout of the repo on the job branch,
 * and push the branch immediately. Returns the branch name and base branch,
 * plus the released claim branch when a retry renamed one (#30).
 */
export function setupWorkspace(workspace: string, opts: GitSetupOptions): JobRefs & { base: string; released?: string; releasedSide?: string; divertedEarlier?: string } {
  const branch = opts.adoptBranch ?? jobBranch(opts.target, opts.jobId);
  const side = divertedBranch(opts.jobId);
  // Adoption and re-entry share the checkout path: the branch already exists
  // on the remote, so neither creates nor pushes anything at setup.
  const existing = opts.reentry === true || opts.adoptBranch !== undefined;

  const preserved = preserveDispatchFiles(workspace);

  git(workspace, ['init', '-q']);
  if (opts.name) git(workspace, ['config', 'user.name', opts.name]);
  if (opts.email) git(workspace, ['config', 'user.email', opts.email]);
  git(workspace, ['remote', 'add', 'origin', opts.url]);
  const base = defaultRef(workspace, opts.url);

  const released = releaseRetryClaim(workspace, { branch, side }, existing, opts.retryAttempt);

  checkoutBranch(workspace, branch, base, existing, opts.depth);

  // Restore the dispatch payload over whatever the clone brought in, and make
  // sure none of it can ever be committed or pushed.
  mergeExcludes(workspace, restoreDispatchFiles(workspace, preserved));

  if (!existing) {
    // Initial setup: push the branch immediately so evidence is preserved even
    // if the container dies before any work is committed.
    git(workspace, ['push', '-q', '-u', 'origin', branch]);
  }
  // Re-entry (#291): work an earlier generation diverted, and nobody has since
  // brought over, is not on the branch just checked out. Say so, rather than
  // let the run continue without it.
  const divertedEarlier = existing && !sideMerged(workspace, { branch, side }) ? side : undefined;
  return {
    branch, side, base, ...released,
    ...(divertedEarlier !== undefined ? { divertedEarlier } : {}),
  };
}

/**
 * Where a job's runner pushes go (#291): the job branch (or the adopted PR's
 * head, #80) and the side branch for work the job branch would refuse. Passed
 * in by the caller and never read from the checkout or from git config — the
 * agent creates and checks out branches at will and can edit its config.
 */
type JobRefs = { branch: string; side: string };

/**
 * Work the job branch would refuse, pushed to the side branch instead (#291).
 * `diverted` names it, `reason` says why in one clause, `moved` is false when
 * the side branch already held exactly this work, and `delivered` says whether
 * the job branch itself carries work beyond base (only judged when a base is
 * given, i.e. at settle).
 */
export type Diverted = { diverted: string; reason: string; moved: boolean; delivered: boolean };

/**
 * The side branch for a job's diverted work: keyed on the job id, so a `pr/<n>`
 * continuation never shares one with the job it continues, and a retry renames
 * the previous attempt's aside (releaseRetryClaim) exactly like its claim.
 * Deliberately outside `fleet/<target>-*`: pickup gates treat every such branch
 * that is not the job's own as a rival claim (.fleet/gate.mjs claimFindings),
 * so a name in that namespace would block this job's own re-entry and retry and
 * every later dispatch of the target, in repos whose gates Fleet cannot edit.
 */
export function divertedBranch(jobId: string): string {
  return `fleet-diverged/${jobId}`;
}

/**
 * Commits the runner itself built with commit-tree and pushed from a checkout
 * that was not the job branch (#291), each keyed on the branch the agent was
 * on when it was built. The agent's branch never contains them, by design, so
 * "HEAD builds on the job branch" forgives them — but only while the agent is
 * still on that branch. A commit of the agent's own is never recorded (pushed
 * as-is, it was in HEAD when pushed): forgiving one would let a later checkout
 * of an unrelated branch merge over it and drop it from the job branch's tree.
 * In-process: a fresh runner (re-entry, the host-side `fleet resume-push`)
 * starts with none, and errs toward diverting.
 */
const runnerSnapshots = new Map<string, string>();

/** Milliseconds left for the next network call of one push; undefined = unbounded. */
type Budget = () => number | undefined;

/**
 * One deadline shared by every network call of one push (#291), started at the
 * first call so a lone push still gets — and its timeout message still names —
 * the whole bound. A fetch then a push used to get the full bound each, which
 * on a black-holed remote ran the cancel teardown past its own deadline.
 */
function budget(timeoutMs?: number): Budget {
  let end: number | undefined;
  return () => {
    if (timeoutMs === undefined) return undefined;
    end ??= Date.now() + timeoutMs;
    return Math.max(1, end - Date.now());
  };
}

/**
 * Commit everything and push it to the job branch. Outcomes:
 * - 'pushed': this call moved the remote job branch.
 * - 'delivered': the remote branch already carries work beyond base (the agent
 *   pushed itself). The delivery exists regardless of who pushed it — #34/#37
 *   attempt runs were mislabeled "clean" for exactly this.
 * - 'clean': nothing committed anywhere; there is no deliverable.
 * - Diverted: HEAD does not build on the job branch, so the work went to the
 *   side branch (#291).
 *
 * A bare `git push` followed the agent's current branch and upstream (#291):
 * failing outright after `checkout -b x origin/main` (the work died with the
 * container) or landing a WIP commit on another PR after `gh pr checkout`. Only
 * a checkout that IS the job branch gets a local runner commit; from any other
 * branch the runner commits with commit-tree, so a branch that tracks another
 * PR never carries a runner commit its agent could later plain-push.
 *
 * `timeoutMs` bounds the network calls only, as one shared deadline — local
 * add/commit/rev-list cannot hang on a dead connection and a large tree must
 * not trip a bound meant for one (#152).
 */
function commitAndPush(workspace: string, refs: JobRefs, message: string, base?: string, timeoutMs?: number): 'pushed' | 'delivered' | 'clean' | Diverted {
  const left = budget(timeoutMs);
  const { branch } = refs;
  if (!buildsOn(workspace, branch)) {
    const d = divert(workspace, refs, message, left);
    // Its own bound: the delivery check is the settle's question, not the push's.
    const delivered = remoteAheadOfBase(workspace, branch, base, timeoutMs);
    if (d === 'clean') return delivered ? 'delivered' : 'clean';
    return { ...d, delivered };
  }
  const onJobBranch = currentBranch(workspace) === branch && isAncestor(workspace, `origin/${branch}`, 'HEAD');
  let outcome: 'pushed' | 'clean' | 'unmoved';
  try {
    outcome = onJobBranch
      ? commitOnJobBranch(workspace, branch, message, left)
      : snapshotPush(workspace, branch, git(workspace, ['rev-parse', `origin/${branch}`]).trim(), snapshotTree(workspace), message, left);
  } catch (err) {
    // Rejected (e.g. the agent amended after its own push, or the remote moved
    // past our tracking ref): judge delivery by what the remote actually has.
    if (remoteAheadOfBase(workspace, branch, base, timeoutMs)) return 'delivered';
    throw err;
  }
  if (outcome === 'pushed') return 'pushed';
  return remoteAheadOfBase(workspace, branch, base, timeoutMs) ? 'delivered' : 'clean';
}

/** The agent is on the job branch itself: commit there and push, as always. */
function commitOnJobBranch(workspace: string, branch: string, message: string, left: Budget): 'pushed' | 'clean' {
  git(workspace, ['add', '-A']);
  const staged = git(workspace, ['status', '--porcelain']).trim();
  if (staged !== '') git(workspace, ['commit', '-q', '-m', message]);
  const ahead = git(workspace, ['rev-list', '--count', `origin/${branch}..HEAD`]).trim();
  if (staged === '' && ahead === '0') return 'clean';
  git(workspace, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], left());
  return 'pushed';
}

/**
 * Does HEAD build on the job branch? Yes when every commit the remote job
 * branch has and HEAD lacks is a snapshot this runner built from the branch
 * the agent is on now. False for an unknown ref, too.
 */
function buildsOn(workspace: string, branch: string): boolean {
  try {
    const missing = git(workspace, ['rev-list', `origin/${branch}`, '--not', 'HEAD']).split('\n').filter(Boolean);
    const current = currentBranch(workspace);
    return missing.every((sha) => current !== '' && runnerSnapshots.get(sha) === current);
  } catch {
    return false;
  }
}

/** The checked-out branch's name; '' on a detached HEAD. */
function currentBranch(workspace: string): string {
  return git(workspace, ['branch', '--show-current']).trim();
}

/** Is `ancestor` in the history of `of`? False for an unknown ref, too. */
function isAncestor(workspace: string, ancestor: string, of: string): boolean {
  try {
    git(workspace, ['merge-base', '--is-ancestor', ancestor, of]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A branch's tip on the remote, fetched fresh; undefined when the remote has
 * no such branch. Absence is an empty `ls-remote` listing — the same test
 * renameRemoteBranch uses — never a match on git's stderr, which is localized
 * and can open with a "warning: redirecting" line. A timeout or a dead remote
 * throws: reading those as "absent" sent the push after them into a second
 * full bound.
 */
function fetchedTip(workspace: string, branch: string, left: Budget): string | undefined {
  if (git(workspace, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], left()).trim() === '') return undefined;
  git(workspace, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], left());
  return git(workspace, ['rev-parse', `refs/remotes/origin/${branch}`]).trim();
}

/**
 * Is everything on the side branch already on the job branch? True when there
 * is no side branch. Re-entry and settle ask this before telling anyone to
 * reconcile diverted work (#291), so work already brought over is not
 * announced again. Throws when the remote cannot answer.
 */
export function sideMerged(workspace: string, refs: JobRefs, timeoutMs?: number): boolean {
  const left = budget(timeoutMs);
  const tip = fetchedTip(workspace, refs.side, left);
  if (tip === undefined) return true;
  git(workspace, ['fetch', '-q', 'origin', `+refs/heads/${refs.branch}:refs/remotes/origin/${refs.branch}`], left());
  return isAncestor(workspace, tip, `origin/${refs.branch}`);
}

/**
 * The working tree as a git tree, staged through a COPY of the index: the
 * agent's own index (its staging, and the skip-worktree bits that keep the
 * dispatch payload out of commits) stays exactly as it was. The copy keeps
 * those bits, so the snapshot excludes the payload just as a commit would.
 */
function snapshotTree(workspace: string): string {
  const gitDir = git(workspace, ['rev-parse', '--absolute-git-dir']).trim();
  const index = join(gitDir, 'fleet-divert-index');
  try {
    // A runner killed mid-snapshot leaves the copy's lock behind.
    rmSync(`${index}.lock`, { force: true });
    copyFileSync(join(gitDir, 'index'), index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(workspace, ['add', '-A'], undefined, env);
    return git(workspace, ['write-tree'], undefined, env).trim();
  } finally {
    rmSync(index, { force: true });
  }
}

/** The tree a commit points at. */
function treeOf(workspace: string, commit: string): string {
  return git(workspace, ['rev-parse', `${commit}^{tree}`]).trim();
}

/**
 * Push the working state to `ref` as a fast-forward of `seen`, moving no local
 * branch: the commit is built with commit-tree. Parents are `seen` plus HEAD
 * (just one when either contains the other), so the push never needs force.
 * 'clean' when there is nothing new: the tree is HEAD's and HEAD's commits are
 * all already on some origin branch — so a review job that ran `gh pr checkout
 * <n>` republishes nothing of PR n's as its own. `moved: false` when `seen`
 * already holds this work; a tree equal to HEAD's never "reverts" a snapshot
 * that carried uncommitted edits since dropped.
 */
function snapshotPush(workspace: string, ref: string, seen: string | undefined, tree: string, message: string, left: Budget): 'pushed' | 'clean' | 'unmoved' {
  const head = git(workspace, ['rev-parse', 'HEAD']).trim();
  const headTree = treeOf(workspace, head);
  const inSeen = seen !== undefined && isAncestor(workspace, head, seen);
  if (inSeen && (tree === headTree || tree === treeOf(workspace, seen as string))) return 'unmoved';
  const fresh = tree !== headTree
    || git(workspace, ['rev-list', '-n', '1', head, '--not', '--remotes=origin']).trim() !== '';
  if (!fresh) return seen === undefined ? 'clean' : 'unmoved';
  const tip = snapshotCommit(workspace, parentsFor(workspace, seen, head), tree, message);
  git(workspace, ['push', '-q', 'origin', `${tip}:refs/heads/${ref}`], left());
  git(workspace, ['update-ref', `refs/remotes/origin/${ref}`, tip]);
  // Only what the runner built; HEAD itself, pushed as-is, is the agent's.
  if (tip !== head) runnerSnapshots.set(tip, currentBranch(workspace));
  return 'pushed';
}

/** Parents that make the snapshot a fast-forward of `seen` and contain HEAD. */
function parentsFor(workspace: string, seen: string | undefined, head: string): string[] {
  if (seen === undefined || isAncestor(workspace, seen, head)) return [head];
  return isAncestor(workspace, head, seen) ? [seen] : [seen, head];
}

/** The snapshot commit: the lone parent itself when it already has this tree. */
function snapshotCommit(workspace: string, parents: string[], tree: string, message: string): string {
  if (parents.length === 1 && tree === treeOf(workspace, parents[0])) return parents[0];
  return git(workspace, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message]).trim();
}

/**
 * Push a diverged HEAD's work to the side branch (#291) — never to the job
 * branch, which refuses it, and never to the branch the agent is on.
 */
function divert(workspace: string, refs: JobRefs, message: string, left: Budget): Omit<Diverted, 'delivered'> | 'clean' {
  // Local work first: `add -A` on a big tree must not eat the push's deadline,
  // which starts at the first network call.
  const tree = snapshotTree(workspace);
  const seen = fetchedTip(workspace, refs.side, left);
  const pushed = snapshotPush(workspace, refs.side, seen, tree, message, left);
  if (pushed === 'clean') return 'clean';
  const current = currentBranch(workspace);
  const on = current === '' ? 'a detached HEAD' : `branch ${current}`;
  return {
    diverted: refs.side,
    reason: `the agent is on ${on}, whose history does not contain origin/${refs.branch}`,
    moved: pushed === 'pushed',
  };
}

/** Does the remote job branch carry commits beyond the base branch? */
function remoteAheadOfBase(workspace: string, branch: string, base: string | undefined, timeoutMs?: number): boolean {
  if (!base) return false;
  try {
    git(workspace, ['fetch', '-q', 'origin'], timeoutMs);
    const count = git(workspace, ['rev-list', '--count', `origin/${base}..origin/${branch}`]).trim();
    return count !== '0';
  } catch {
    return false;
  }
}

/** The work commit at settle. Pushes partial work too — evidence over tidiness. */
export function pushWork(workspace: string, refs: JobRefs, target: string, jobId: string, ok: boolean, base?: string, timeoutMs?: number): 'pushed' | 'delivered' | 'clean' | Diverted {
  return commitAndPush(workspace, refs, `${target}: fleet job ${jobId}${ok ? '' : ' (partial)'}`, base, timeoutMs);
}

/** The WIP commit when a blocked job parks (#6 calls this). */
export function pushWip(workspace: string, refs: JobRefs, reason: string, timeoutMs?: number): 'pushed' | 'delivered' | 'clean' | Diverted {
  return commitAndPush(workspace, refs, `wip(park): ${reason}`, undefined, timeoutMs);
}

/**
 * The periodic WIP checkpoint during a run (#190): same commit-and-push
 * machinery as the park/cancel pushes, bounded the same way. A clean,
 * fully-pushed workspace is a no-op ('clean'); each later checkpoint and the
 * final teardown push then move only the delta since the last one.
 */
export function pushCheckpoint(workspace: string, refs: JobRefs, note: string, timeoutMs?: number): 'pushed' | 'delivered' | 'clean' | Diverted {
  return commitAndPush(workspace, refs, `wip(checkpoint): ${note}`, undefined, timeoutMs);
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
 * are on it. Judging a continuation by that would claim a rung for doing
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
 * #80): a dispatch that adopted a branch reports the existing PR at
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
  const ref = displayTarget(opts.target);
  const title = opts.issueTitle ? `${ref}: ${opts.issueTitle}` : `${ref}: fleet job ${opts.jobId}`;
  const list = (v: string[] | string | undefined): string[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  const r = opts.report;
  const lines: string[] = [
    '## Problem',
    `${opts.issueTitle ?? 'See the referenced work item.'}${isIssueTarget(opts.target) ? ` Closes ${ref}.` : ''}`,
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
