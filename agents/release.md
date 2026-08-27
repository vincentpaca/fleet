# release — prepare a release PR for this repo

Canonical playbook, harness-neutral. Per-harness command files under `.claude/`
(and other harness dirs) are pointers to this file and carry no content.
The target version is provided by the invoking context — a command argument in
a local harness session, a Fleet work order, or the operator's own choice when
working by hand. All three executors are legal; the publish pipeline neither
knows nor cares which one ran this.

**The finish line is a draft release PR against `main`** containing exactly two
changes: the new `CHANGELOG.md` entry and the `package.json` version bump.
Merging that PR is the release: `.github/workflows/release.yml` runs the suite,
tags `v<version>`, creates the GitHub Release from the changelog entry, and
publishes to npm. Nothing in this playbook publishes anything.

## Steps

1. **Find the boundary.** The last release is the newest `v*` tag:
   `git describe --tags --abbrev=0 --match 'v*' origin/main`. If no `v*` tag
   exists yet, the boundary is the hand publish recorded as the oldest entry
   in `CHANGELOG.md` — use that entry's date.
2. **Collect the raw material.** Every PR merged to `main` since the boundary:
   `gh pr list --state merged --base main --limit 200 --json number,title,labels,body,mergedAt`,
   filtered to merges after the boundary. PR bodies in this repo carry honest
   `## Problem` and `## Not done` sections — read them; they are the changelog's
   source, not the PR titles. Also take the code diff between the boundary and
   `origin/main`: its shape drives the upgrade notes below.
3. **Write the changelog entry.** Prepend to `CHANGELOG.md`, directly under the
   file's intro, a section headed `## <version> — <YYYY-MM-DD>`. The publish
   workflow extracts this exact section as the GitHub Release body, so the
   heading shape is a contract (pinned by `test/release-playbook.test.ts`).
   Four subsections, in this order:
   - **What's new for you** — commands and behavior changes an operator will
     notice, written as sentences about what they can do or what changed, never
     a restyled PR-title list.
   - **Upgrade notes** — derived from the diff's shape, one note per trigger:
     anything under `infra/` changed → tell the operator to re-run
     `terraform apply` for their deployment; anything under `images/` changed →
     tell them to rebuild the runner images; any `schemas/*.json` change →
     a migration note naming the shape that moved and what existing data or
     manifests must do about it. If none apply, write "None."
   - **Breaking changes** — loud and specific: what breaks, who is affected,
     what to do. If none, write "None."
   - **All merged PRs** — the appendix and ground truth: the full list, one
     line per PR, `#<number>: <title>`. GitHub's generated release notes
     (`.github/release.yml`) group by the same labels if you want a starting
     point, but the committed list is the record.
4. **Bump the version.** Set `package.json` `"version"` to the target. Nothing
   else in the file. `main` always carries the last released version, so a git
   install reports honestly — this bump lands only by merging the release PR.
5. **Verify.** `npm ci && npm test` — the full suite, green. The publish
   workflow re-runs it after merge, but a release PR opened red is noise.
6. **Open the draft release PR.** Branch `release/v<version>`, base `main`,
   title `Release v<version>`, draft. Body in this repo's PR shape:
   `## Problem` (one line: what span of merges this release cuts), `## Status`,
   `## Verification` (the exact commands from step 5 and their results),
   `## Not done` (anything deliberately left out of this release). The operator
   reads and edits the changelog like any other review; nothing ships before
   they merge.

## Never

- Never merge the release PR — no code path merges; the merge is the human gate.
- Never edit `.github/workflows/` — workflow changes need an operator's own
  push (#48).
- Never publish to npm from this playbook or any machine outside CI — npm
  provenance attestation only works from GitHub Actions, and the workflow owns
  the publish.
