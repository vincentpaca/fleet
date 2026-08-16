# Working on this repo (agents)

Fleet runs coding-agent jobs in containers on the owner's own AWS. Read `docs/architecture.md` before changing behavior and `docs/decisions.md` before proposing to change a rule — decisions there are settled unless a human reopens them.

## Hard rules

- **Schemas are the source of truth.** Every data shape lives in `schemas/*.json`. Change behavior to match the schema, never the reverse without a human decision. The daemon rejects invalid events; do not "fix" that by loosening validation.
- **TypeScript, erasable syntax only.** Code runs on Node's native type stripping — no build step. No enums, no namespaces, no parameter properties. If `node --test` can't run it directly, it's wrong.
- **Zero new runtime dependencies.** Node builtins plus the existing `ajv`. Shelling out to `git`, `gh`, `docker`, `aws` CLIs is fine.
- **No client, engagement, or operator-specific content — ever.** `test/sanitized.test.mjs` scans the whole tree on every run and fails the suite. Examples use `acme`, `APP-123`, `example.com`.
- **Never implement merge or deploy.** No code path may call a merge or deployment API. Jobs cannot be granted those permissions (schema-enforced); the same applies to you.
- **Honest reporting.** Never claim an evidence rung you didn't verify (`docs/architecture.md#the-finish-line`). "Tests pass" means you ran them and saw the output.

## Verify

```
npm test          # full suite, includes the sanitization gate
node --test test/<area>-*.test.ts   # focused
```

Both must be green before you finish. New behavior gets a test that fails on a plausible bug, not a test that restates the code.

## Layout

- `schemas/` — the five contracts. `src/daemon/` `src/runner/` `src/cli/` `src/providers/` `src/shared/` — see `docs/architecture.md#the-pieces`.
- `docs/` — architecture, decisions, roadmap. Issues reference these; keep anchors stable.
- `agents/` — the CANONICAL command playbooks and agent charters, harness-neutral. Per-harness files (`.claude/commands/*`, `.claude/agents/*`, and any future `.opencode/`/`.codex/` mirrors) are three-line pointers to these and carry no content. Edit canonicals only; `test/harness-mirrors.test.ts` fails on drift.
- `.fleet/` — this repo's own manifest, setup script, and pickup gate (yes, Fleet delegates work on itself).
- `infra/terraform/` — the substrate module. `terraform fmt` clean; do not add resources with ingress rules.

## Raising a question mid-job (sandboxed runs)

When you need a human decision you cannot infer: write `.fleet/out/decision.json` per `schemas/decision-file.schema.json` — a real question, two or more options with stable ids, exactly one `"recommended": true` — then poll for `.fleet/out/answer-d<n>.json` (the runner numbers decisions `d1`, `d2`, … in order) and continue with the answer. Never answer yourself; never proceed past a needed decision on a guess.

## Finishing a job (sandboxed runs)

Before exiting, write `.fleet/out/report.json`: `status` (`READY`/`BLOCKED`/`PARTIAL`/…), what you verified, and exactly one `next_action`. The runner validates it against the settle report schema; an invalid report is dropped, so keep it to the schema.
