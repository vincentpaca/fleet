# dev — implement a GitHub issue on this repo, headless

Canonical playbook, harness-neutral. Per-harness command files under `.claude/`
(and other harness dirs) are pointers to this file and carry no content.
The issue number is provided by the invoking harness as the command argument.

Implement the given GitHub issue on this repository.

## Steps

1. **Read the work.** `gh issue view <issue> --json title,body,comments`. The `## Acceptance` section is the contract; the referenced `docs/` files are the context. If the issue references docs anchors, read those sections.
2. **Plan narrowly.** Map each acceptance criterion to the files that implement it. Smallest complete change; no adjacent refactors; nothing outside the issue's scope.
3. **Implement.** Follow AGENTS.md rules (erasable TS, zero deps, schemas are source of truth). If working in a fleet job workspace, stay on the current branch — it is the job branch. Build large files incrementally — scaffold first, then extend with focused edits; a single response that emits a whole large file can exceed the harness output cap and kills the job (observed: harness-exit at 32k output tokens).
4. **Test.** Write or extend tests that fail on a plausible bug for each acceptance criterion. Run focused tests, then the full suite (`npm test`) — the sanitization gate must pass.
5. **Self-review.** Run the `code-reviewer` critic on your diff (via your harness's subagent mechanism; its charter is `agents/code-reviewer.md`). Fix warranted findings; do not resolve a finding without a fix or a stated reason.
6. **Report.** Write `.fleet/out/report.json`: `status` (`READY` if all acceptance criteria are met and the suite is green, `PARTIAL` otherwise), `verification` (the exact commands you ran), `not_done` (anything remaining), and exactly one `next_action`.

## When you cannot decide

Two materially different implementations both plausible, an acceptance criterion ambiguous, or a rule conflict: write `.fleet/out/decision.json` (see AGENTS.md — question, ≥2 options with stable ids, exactly one recommended), then poll for `.fleet/out/answer-d<n>.json` and proceed with the answer. Never guess through a real fork; never answer your own question.

## Never

- Never merge anything or touch deployment.
- Never weaken a schema, a validation path, or the sanitization gate to make work fit.
- Never claim `READY` with a red suite or an unmet acceptance criterion — report `PARTIAL` honestly instead.
