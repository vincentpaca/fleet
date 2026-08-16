# Working on this repo

Fleet runs coding-agent jobs in containers on the owner's own AWS. `docs/architecture.md` explains the system; `docs/decisions.md` records settled calls — don't relitigate them in code, reopen them with a human.

## Build and test

- Node ≥ 23.6, no build step: `.ts` runs directly via type stripping. **Erasable syntax only** — no enums, no namespaces, no parameter properties. If `node --test` can't run it, it's wrong.
- `npm test` = full suite. Focused: `node --test test/<area>-*.test.ts` (areas: `daemon-`, `runner-`, `cli-`, plus `gate`, `e2e-delegate`, `harness-mirrors`). Optional: `FLEET_DEMO_HISTORY=<path> npm test` round-trips an external history file.
- **Zero new runtime dependencies.** Node builtins + the existing `ajv`. Shelling out to `git`, `gh`, `docker`, `aws` is fine.
- Terraform: `terraform fmt` clean; validate via `examples/basic`; never add a resource with an ingress rule (EFS mount targets are the one SG-referenced exception, documented in `infra/terraform/main.tf`).

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
- **Reuse the existing pattern.** A second convention living beside an existing one (a new helper duplicating `src/shared/`, a hand-rolled validator beside ajv, a second event-rendering path) is a defect even when it works.

## Rules with reasons

- New behavior ships with a test that fails on a plausible bug — not a test that restates the implementation. A check that has never failed proves nothing.
- Don't claim what you didn't run. "Tests pass" means you executed them and saw the output; name the exact commands in your report.
- A rule worth adding is worth a checkpoint (schema, gate, or test) in the same change — or an honest comment that it's prompt-level. This repo's whole thesis is that prose rules don't hold.
- Keep `docs/` anchors stable; GitHub issues link to them.

## Layout

`schemas/` contracts · `src/daemon|runner|cli|providers|shared/` per `docs/architecture.md#the-pieces` · `agents/` canonical playbooks · `.fleet/` this repo's own manifest + pickup gate (Fleet delegates work on itself) · `docs/` architecture, decisions, roadmap · `infra/terraform/` substrate · `fixtures/` executable fixtures + synthetic data.

## Sandboxed runs (when you ARE the delegated job)

- Need a human decision? Write `.fleet/out/decision.json` per `schemas/decision-file.schema.json` (real question, ≥2 options with stable ids, exactly one `"recommended": true`), then poll `.fleet/out/answer-d<n>.json` (runner numbers decisions `d1`, `d2`, …) and continue with the answer. Never guess through a real fork.
- Before exiting, write `.fleet/out/report.json`: `status`, `verification` (exact commands run), `not_done`, and exactly one `next_action`. Invalid reports are dropped by the runner — stay inside the schema. Report `PARTIAL` honestly over `READY` optimistically.
