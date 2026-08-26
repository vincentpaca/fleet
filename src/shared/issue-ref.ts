/**
 * Is this work-order target a GitHub issue reference, and what is its canonical
 * form?
 *
 * One predicate, because four surfaces answer the same question and drifted:
 * the CLI classifies a dispatch's shape by it (#36), the board and `fleet
 * status` decide whether to render a `#` prefix by it, and the runner decides
 * whether a draft PR body may say `Closes #<n>` by it. Before this module they
 * were four inline regexes, one of which re-prefixed an already-prefixed target
 * and printed `##42`. The display form is a function rather than an exported
 * prefixer plus a guard at each call site, for the same reason.
 *
 * The one copy that stays independent is `.fleet/gate.mjs`'s: a repo's pickup
 * gate is repo-owned and must stand alone, so it cannot import this.
 * `test/gate.test.ts` pins the two against each other.
 */

/** Leading "#" on an issue reference. */
const STRIP_HASH = /^#/;

/** Issue number: only digits. */
const IS_ISSUE_NUM = /^\d+$/;

/**
 * `#42` → `42`; anything that is not a bare issue reference is untouched.
 * Narrower than a blanket strip on purpose: prose an operator wrote with a `#`
 * in front keeps it.
 */
export function normalizeTarget(raw: string): string {
  const stripped = raw.replace(STRIP_HASH, '');
  return IS_ISSUE_NUM.test(stripped) ? stripped : raw;
}

/** Does this target name a GitHub issue? `42` and `#42` both do. */
export function isIssueTarget(target: string): boolean {
  return IS_ISSUE_NUM.test(normalizeTarget(target));
}

/**
 * A target as it should read on screen or in a PR title: `#42` for an issue
 * (whether the stored order said `42` or `#42`), the raw string for anything
 * else. One function rather than an exported `#`-prefixer plus a guard at every
 * call site — the four call sites this replaced each wrote the same ternary, and
 * one of them applied the prefix without the guard and printed `##42`.
 */
export function displayTarget(target: string): string {
  return isIssueTarget(target) ? `#${normalizeTarget(target)}` : target;
}
