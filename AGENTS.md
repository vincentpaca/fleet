# Working on this repo

Fleet runs coding-agent jobs in containers in the owner's own cloud. `docs/architecture.md` explains the system; `docs/decisions.md` records settled calls — don't relitigate them in code, reopen them with a human.

## Build and test

- Node ≥ 23.6, no build step: `.ts` runs directly via type stripping. **Erasable syntax only** — no enums, no namespaces, no parameter properties. If `node --test` can't run it, it's wrong.
- `npm test` = full suite. Focused: `node --test test/<area>-*.test.ts` (areas: `daemon-`, `runner-`, `cli-`, plus `gate`, `e2e-delegate`, `harness-mirrors`, `cloud-agnostic`, `infra-aws`, `packaging`, `sanitized`, `analyzer-scope`, `complexity`). Optional: `FLEET_DEMO_HISTORY=<path> npm test` round-trips an external history file. `FLEET_HARNESS_CORPUS=<path> npm test` replays a captured real harness stream through the translator. Both point outside the repo — external data is never vendored (`docs/decisions.md#d10`).
- **`pip install lizard` before you push.** Every Codacy issue this repo's code has ever had came from Lizard (a function over 50 lines or complexity 10), and Codacy only reports it on a pull request — so without lizard installed you find out by pushing and waiting. `test/complexity.test.ts` runs it against a pinned baseline of the 27 functions already over the line; it skips silently when lizard is absent, which makes it a check you can accidentally not have.
- **Zero new runtime dependencies.** Node builtins + the existing `ajv`/`ajv-formats`. Shelling out to `git`, `gh`, `docker`, `aws` is fine.
- Terraform: `terraform fmt` clean; validate via the unit's `examples/basic`; no inbound from outside the VPC — intra-VPC SG-referenced ingress is allowed where documented inline (`infra/aws/main.tf`), enforced by `test/infra-aws.test.ts`.
- **Every infra change runs the plan smoke by hand** — `terraform -chdir=infra/<cloud> init -backend=false && terraform -chdir=infra/<cloud> test` (terraform ≥ 1.7, no credentials: the unit's `tests/*.tftest.hcl` mock the provider). fmt and validate pass values the provider rejects at plan; #9 paid for four applies to find that out. CI's terraform job runs it too (`.github/workflows/tests.yml`, #48), but run it locally first — finding out from a pushed PR is the slow loop. API-only constraints, which no plan reaches, are pinned in `test/infra-aws.test.ts`.

## Invariants that break if you're not looking

- **Schemas own every data shape** (`schemas/*.json`). Behavior bends to schema. The daemon rejects invalid events at intake — never loosen validation or coerce input to make a test pass; fix the producer.
- **Event `seq`:** the runner claims a monotonic per-job seq; the daemon validates it, then re-stamps the authoritative log seq. Consumers (`?after=`, replay) use daemon seqs. The runner never reads seqs back.
- **State machine loads from `schemas/job-states.json`** (`src/daemon/state.ts`). Never hardcode a transition; `parked`/`stale` are markers on `blocked`, not states.
- **The runner token authorizes only `/internal/*` for its own job.** The answer API must never become reachable with it — an agent answering its own question is the one bug this whole design exists to prevent.
- **No code path may merge a PR or deploy.** Also schema-enforced on work orders; keep it enforced in code.
- **HTTP over the unix socket:** `fetch` can't do unix sockets — use `src/shared/http.ts` (pooling deliberately disabled).
- **`node --test` collects every file under `test/`.** Helpers there must export-only (no top-level effects); executable fixtures live in `fixtures/` (we shipped this bug once — see git history).
- **Tests own their state:** point `FLEET_HOME` at a temp dir; never touch `~/.fleet`; mock daemons are in-test HTTP servers on port 0.
- **`test/sanitized.test.mjs` scans the whole tree** and fails on client/operator-specific strings. Examples are `acme`, `APP-123`, `example.com`. External data is referenced by env pointer, never vendored.
- **`agents/` is canonical; `.claude/**` files are three-line pointers.** Edit canonicals only; `test/harness-mirrors.test.ts` fails a mirror that grows content or a canonical that leaks harness dialect (`$ARGUMENTS`).
- **A static-analysis finding resolves into git, not into a UI click.** Three endings: a code change; a scoped exclusion in `.github/codeql/codeql-config.yml` or `.codacy.yaml`; a threat-model call written into `docs/decisions.md` that the dismissal cites.
- **Widening an analyzer exclusion is a human's call.** Silencing the scanner is the cheapest route to a green check. `test/analyzer-scope.test.ts` fails if either exclusion list reaches past the build harness, so the move costs a visible diff.
- **Reuse the existing pattern.** A second convention living beside an existing one (a new helper duplicating `src/shared/`, a hand-rolled validator beside ajv, a second event-rendering path) is a defect even when it works.

## Rules with reasons

- New behavior ships with a test that fails on a plausible bug — not a test that restates the implementation. A check that has never failed proves nothing.
- Don't claim what you didn't run. "Tests pass" means you executed them and saw the output; name the exact commands in your report.
- A rule worth adding is worth a checkpoint (schema, gate, or test) in the same change — or an honest comment that it's prompt-level. This repo's whole thesis is that prose rules don't hold.
- Keep `docs/` anchors stable; GitHub issues link to them.

## Delivery standard

- **Branches:** `fleet/<issue>-<job>` (runner-owned); `<area>/<slug>` for hand work.
- **Commits:** imperative subject ≤72 chars naming the change; body says why and what a reviewer must know. Nothing else.
- **PRs:** title `#<issue>: <issue title>` — never a bare number. Body sections, in order: `## Problem` (one line + `Closes #<n>`), `## Status` (the report's `status` and rung, honestly), `## Verification` (exact commands run and their results), `## Not done` (gaps, or "nothing"). The diff speaks for the change itself.
- **Draft until a human reviews.** The runner composes PR text from the settle report (`composeDraftPrText` in `src/runner/git.ts`); hand-opened PRs follow the same shape. A report too thin to fill these sections is not ready to open one.

## Repository map

This repo is two things, and every path belongs to exactly one. **SHIP** = what users consume (the npm package via the `files` allowlist, the Terraform unit via git subdirectory source, the skill file). **BUILD** = the harness for developing Fleet itself — users never see it. `test/packaging.test.ts` enforces the boundary against `npm pack`.

| Path | Side | What it is |
|---|---|---|
| `schemas/` | SHIP | The five contracts — source of truth for every data shape |
| `src/cli/` `src/daemon/` `src/runner/` `src/providers/` `src/shared/` | SHIP | The product: CLI, coordinator, in-sandbox runner, cloud providers, helpers (`docs/architecture.md#the-pieces`) |
| `src/validate.mjs` `src/history-events.mjs` | SHIP | Schema validators; history⇄events converter |
| `presets/` | SHIP | The six dispatch-mode defaults |
| `examples/` | SHIP | Reference manifests and work orders — generic, always |
| `integrations/` | SHIP | Skill files users copy into their coding harness |
| `images/` | SHIP | Runner base Dockerfile + build script; consumed via git source, not npm (`docs/architecture.md#two-layer-job-images`) |
| `infra/<cloud>/` | SHIP | One self-contained Terraform unit per cloud (`docs/decisions.md#d12`); consumed by git source, not npm |
| `docs/` | SHIP | Architecture, decisions, roadmap — issues link here; keep anchors stable |
| `AGENTS.md` `CLAUDE.md` `agents/` `.claude/` | BUILD | This repo's own harness: rules, canonical playbooks, per-harness pointers |
| `.fleet/` | BUILD | This repo as a Fleet target: manifest, setup script, issue-readiness gate |
| `test/` `fixtures/` | BUILD | The suite (incl. sanitization, mirror-drift, cloud-agnostic, packaging gates); executable fixtures + synthetic data |


## Sandboxed runs (when you ARE the delegated job)

- Need a human decision? Write `.fleet/out/decision.json` per `schemas/decision-file.schema.json` (real question, ≥2 options with stable ids, exactly one `"recommended": true`), then poll `.fleet/out/answer-d<n>.json` (runner numbers decisions `d1`, `d2`, …) and continue with the answer. Never guess through a real fork.
- Before exiting, write `.fleet/out/report.json`: `status`, `verification` (exact commands run), `not_done`, and exactly one `next_action`. Invalid reports are dropped by the runner — stay inside the schema. Report `PARTIAL` honestly over `READY` optimistically.
