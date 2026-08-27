# dev — implement a GitHub issue on this repo, headless

Canonical playbook, harness-neutral. Per-harness command files under `.claude/`
(and other harness dirs) are pointers to this file and carry no content.
The issue number is provided by the invoking harness as the command argument.

Implement the given GitHub issue on this repository. **The finish line is a draft pull request against `main`** — the runner opens it at settle from your report when your work is committed on the job branch and the suite is green. A pushed branch with no PR is an unfinished job, not a deliverable.

## Steps

1. **Read the work.** `gh issue view <issue> --json title,body,comments`. The `## Acceptance` section is the contract; the referenced `docs/` files are the context. If the issue references docs anchors, read those sections.
2. **Plan narrowly.** Map each acceptance criterion to the files that implement it. Smallest complete change; no adjacent refactors; nothing outside the issue's scope.
3. **Implement.** Follow AGENTS.md rules (erasable TS, zero deps, schemas are source of truth). If working in a fleet job workspace, stay on the current branch — it is the job branch. Build large files incrementally — scaffold first, then extend with focused edits; a single response that emits a whole large file can exceed the harness output cap and kills the job (observed: harness-exit at 32k output tokens).
4. **Test.** Write or extend tests that fail on a plausible bug for each acceptance criterion. Run focused tests, then the full suite (`npm test`) — the sanitization gate must pass.
5. **Self-review.** Run the `code-reviewer` critic on your diff (via your harness's subagent mechanism; its charter is `agents/code-reviewer.md`). Fix warranted findings; do not resolve a finding without a fix or a stated reason.
6. **Prove your work is on the branch.** `git log origin/$(git branch --show-current)..HEAD --oneline` in the workspace must list your commits, and `git status` must be clean after committing. If your harness ran subagents in isolated worktrees, their edits are NOT in this workspace until applied and committed here — a clean workspace means you are about to deliver nothing, whatever your summary says (this exact failure burned #34's first run). You may push; the runner pushes anyway at settle. **Never amend or rebase after anything has been pushed** — a diverged branch breaks the settle push (#34's third run).
7. **Report.** Write `.fleet/out/report.json`: `status` (`READY` if all acceptance criteria are met and the suite is green, `PARTIAL` otherwise), `verification` and `not_done` (both **arrays** — a bare string is schema-rejected and your whole report is silently dropped), and exactly one `next_action`.

## When you cannot decide

Two materially different implementations both plausible, an acceptance criterion ambiguous, or a rule conflict: write `.fleet/out/decision.json` (see AGENTS.md — question, ≥2 options with stable ids, exactly one recommended), then poll for `.fleet/out/answer-d<n>.json` and proceed with the answer. Never guess through a real fork; never answer your own question.

## Delivery lanes

Every job delivers its transcript plus whatever lane its deliverable needs. Lanes stack on top of the evidence floor, never replace it.

1. **Repo lane** — the job branch and optional draft PR. The lane when the deliverable is a code change; also for docs and ADRs that should be versioned. Requires `authority.publish` in the order for the runner to compose the draft PR, which a dispatch against an issue or a PR gets by default; a prose dispatch has no publish default and no flag (#208) — its prompt owns delivery, and a PR the agent opens itself is graded at settle.
2. **Artifact lane** — files the job writes to `.fleet/out/artifacts/`. The runner collects them at settle, uploads to the daemon, and lists them in `produced[]` with sha256 and bytes. Retrieve with `fleet artifacts <jobId> [list | get <path>]`. The lane when the deliverable is a finding, an assessment, a review or a comparison — the settle report itself becomes a downloadable artifact, not just transcript lines. The where-to-write rule (deliverables and text answers under `.fleet/out/artifacts/`; files elsewhere are not collected) is the product-level output contract the runner injects into every job's prompt (#81) — this section is this repo's detail on top of it, not the load-bearing copy.
3. **External lane** — jobs that mutate external systems (wiki pages, tracker tickets) MUST record references in `produced[]` as `{id: <url>, type: "<system>", title: "..."}` and verify by read-back in `report.verification`. Fleet evidences, never proxies.

## Never

- Never merge anything or touch deployment.
- Never weaken a schema, a validation path, or the sanitization gate to make work fit.
- Never claim `READY` with a red suite or an unmet acceptance criterion — report `PARTIAL` honestly instead.
