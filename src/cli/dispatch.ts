/**
 * What a dispatch IS, and what that implies — the shape rule (#36,
 * docs/decisions.md#d17).
 *
 * Modes left the surface: a dispatch is a target and a prompt. Everything the
 * six modes claimed to control is now read off fields the order already
 * carries. `continues` present means the dispatch adopts an existing PR; else a
 * numeric target means an issue; else it is prose. `continues` is checked FIRST
 * and not as a tie-break: the CLI rewrites a PR dispatch's target to its linked
 * closing issue, so an adoption's target is usually numeric too.
 *
 * Its own module because a repo's pickup gate keys strictness on the same rule
 * and cannot import this — a gate is repo-owned and must stand alone, so
 * `.fleet/gate.mjs` carries an independent copy and `test/gate.test.ts` pins the
 * two against each other. Splitting this out is what gives that test something
 * to compare against; a copy inside `src/cli/main.ts` would be unimportable
 * (that module runs the CLI on import).
 */
import { isIssueTarget } from '../shared/issue-ref.ts';
import { targetableRungs } from '../validate.mjs';

/** Not exported: nothing outside this module names a shape (AGENTS.md). */
type DispatchShape = 'adoption' | 'issue' | 'prose';

/**
 * The dispatch's shape. Call with the post-PR-resolution target.
 *
 * `continues` is tested for truthiness, not for `!== undefined`, to match the
 * gate's copy exactly: the gate reads a staged JSON file where `null` is a
 * possible value, and two copies of one rule that disagree on any input make
 * the pin that compares them worthless.
 */
export function dispatchShape(target: string, continues: unknown): DispatchShape {
  if (continues) return 'adoption';
  return isIssueTarget(target) ? 'issue' : 'prose';
}

/**
 * Authority and finish line per shape. An issue or an adopted PR is a delivery
 * dispatch: it publishes and aims at merge-ready. Prose is not — the runner
 * composes no PR for it, which is what makes an open-ended prompt a legitimate
 * dispatch rather than a defect. There is no flag to change that (#208):
 * prose delivery is prompt-owned — a prompt that asks for a PR gets one from
 * the agent itself, and the settle grades what actually happened.
 */
export const SHAPE_DEFAULTS: Record<DispatchShape, { publish: boolean; finish: string }> = {
  adoption: { publish: true, finish: 'merge-ready' },
  issue: { publish: true, finish: 'merge-ready' },
  prose: { publish: false, finish: 'inspected' },
};

/**
 * The compat `mode` the migration-window release still writes, computed from
 * shape. Operator repos carry their own pickup-gate copies and every pre-#36
 * copy reads a missing `mode` as `implement` (strict), so a CLI that stopped
 * writing the field would fail every prose dispatch against every un-updated
 * gate. On those gates an issue or adoption dispatch then gates exactly as it
 * did; a bare prose dispatch newly passes report-only, which is the point of
 * #36. Deliberately keyed on shape and not on `--mode`: a mapped
 * `--mode assess 42` must still pay the issue readiness check (D17).
 *
 * The follow-up release stops writing this, and says "regenerate your repo gate
 * first".
 */
/**
 * The launch instruction for a shape, or undefined when the operator has not
 * given one.
 *
 * This is the whole of #240. A prose target has never been an identity — no
 * `Closes #n`, no readiness check, nothing reads it but the branch name — so it
 * is the operator saying what they want run, and it runs as typed:
 * `fleet delegate "/dev-sprint"` launches `/dev-sprint`.
 *
 * An issue or an adoption returns undefined, because a number says which work,
 * never what to do about it. Fleet used to fill that gap from
 * `harness.commands[0]`, which is how a repo with four workflows could only
 * ever reach the first one and how Fleet ended up choosing the verb (D8). It
 * does not any more: the caller refuses the dispatch and tells the operator to
 * say what to run. `fleet delegate 69 --prompt "/dev-work #69"` names both.
 */
export function defaultPrompt(shape: DispatchShape, target: string): string | undefined {
  return shape === 'prose' ? target : undefined;
}

export const COMPAT_MODE: Record<DispatchShape, string> = {
  adoption: 'followthrough',
  issue: 'implement',
  prose: 'investigate',
};

/**
 * The `authority` block: `publish` — the one bit any code reads, gating
 * draft-PR creation in the runner — plus D5's two `const false` limits.
 *
 * The deprecated subfields (`edit`, `jira`, `runtime_read`) and `report` are
 * NOT written, even in the migration window. The pre-window schema required
 * only `["mode", "target", "finish"]` and nothing inside `authority`, so an
 * order carrying just these three keys validates against it — checked, not
 * assumed: `fixtures/work-order-pre-window.schema.json` is frozen alongside the
 * gate and `test/gate-window-compat.test.ts` validates every order this CLI
 * writes against it. Writing dead fields "for compatibility" that compatibility
 * does not need would be a claim the schema disproves, and it would also emit
 * mode↔authority pairings no pre-window producer ever wrote (a compat mode of
 * `investigate` beside `runtime_read: false`, say). `mode` is the one legacy
 * field the window still writes, and it is load-bearing — see {@link COMPAT_MODE}.
 */
export function shapeAuthority(publish: boolean): Record<string, unknown> {
  return { publish, merge: false, deploy: false };
}

/**
 * Rungs that cannot be reached without push authority: `pr-open` and everything
 * above it on the ladder. Everything below — `inspected`, `implemented`,
 * `focused-green`, `static-green` and `pushed` — is reachable with
 * `publish: false`, because the runner creates and pushes the job branch
 * whenever the workspace has a git URL and gates only PR creation on the bit
 * (`src/runner/main.ts`). Used to decide whether a repo's
 * `manifest.gates.default_finish` can apply to a given dispatch.
 *
 * Derived from the schema's ladder, not restated: a rung added at or above
 * `pr-open` must land in this set automatically, or the very bug
 * `reachableRepoDefault` exists to prevent comes back silently.
 * `test/cli-delegate.test.ts` pins the split point.
 */
const PUBLISH_RUNG_FLOOR = 'pr-open';
const PUBLISH_RUNGS = new Set(
  targetableRungs.slice(assertLadderFloor(targetableRungs.indexOf(PUBLISH_RUNG_FLOOR))),
);

/** The ladder must contain the floor; a schema that dropped it is a bug, not a default. */
function assertLadderFloor(index: number): number {
  if (index < 0) throw new Error(`work-order schema no longer lists the "${PUBLISH_RUNG_FLOOR}" rung`);
  return index;
}

/**
 * A repo's `manifest.gates.default_finish`, when this dispatch could actually
 * reach it — otherwise undefined, and the shape default stands.
 *
 * The knob names where a repo's delivered work stops (this repo's manifest says
 * `pr-open`). Applied blindly it would give every prose dispatch a target its
 * own authority forbids, so each one would report short of its goal on every
 * run. Applied per rung rather than per shape, it keeps working for the rungs
 * that do not need publishing — a repo defaulting to `static-green` gets it on
 * prose too. An explicit `--finish` is never second-guessed: the operator
 * naming a rung is a decision, not a default. (With `--publish` gone (#208),
 * the only prose route to a publish-true order is the deprecated `--mode
 * implement`, for the life of that flag.)
 */
export function reachableRepoDefault(
  defaultFinish: string | undefined,
  publish: boolean,
): string | undefined {
  if (defaultFinish === undefined) return undefined;
  return publish || !PUBLISH_RUNGS.has(defaultFinish) ? defaultFinish : undefined;
}
