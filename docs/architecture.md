# Architecture

How Fleet works, component by component. The JSON Schemas in `schemas/` are the source of truth for every data shape; this document explains how they fit together.

## The pieces

```
your machine                      always-on (your AWS)            per job (your AWS)
------------                      --------------------            ------------------
harness session or terminal       daemon (small ECS service)      container
  └─ fleet CLI ── HTTP/SSM ──────►  job registry                    └─ runner
                                    event log (validated intake)        ├─ pickup gate
                                    answer API                          ├─ harness CLI (headless)
                                    provider dispatch ─────────────►    ├─ decision watcher
                                                                        └─ settle
```

- **CLI** (`src/cli/`): thin. Sends requests, renders events, exits. `delegate` is one HTTP call; nothing keeps running on your machine unless you ask it to watch.
- **Daemon** (`src/daemon/`): passive coordinator. Validates every incoming event against the schemas before persisting it, enforces the job state machine, holds the answer API, launches and terminates containers through a provider. It never generates work and never answers questions.
- **Runner** (`src/runner/`): lives inside the job container. Runs the pickup gate, runs the repo's own harness command headless, translates its output stream into events, watches for the decision file, reports the settle honestly.
- **Providers** (`src/providers/`): `launch`/`terminate` against a substrate. `ecs` is the real one (tasks on an autoscaling group that scales from zero); `docker` and `process` exist for development and tests.
- **Infra units** (`infra/<cloud>/`): one self-contained Terraform module per cloud — each satisfies the same requirements (on-demand container execution, daemon hosting with durable state, image registry, operator access with no public ingress, scale to zero behind a hard capacity cap) its own way, and pairs with a `src/providers/` implementation. `infra/aws/` is the first unit: ECS cluster + capacity provider, ECR, IAM, EFS-backed daemon service, SSM-only access. One apply per account. Units provision no billing products — spend is bounded structurally, and billing alarms belong to the operator (`docs/decisions.md#d12`).

## Two-layer job images

Fleet containers use two image layers so the expensive base never rebuilds unnecessarily:

```
Layer 1 — runner base (Fleet publishes)
  fleet-runner:<harness-cli>-<cli_version>
  FROM node:22  +  harness CLI installed globally  +  Fleet runner source
  Built once per CLI release by Fleet maintainers; pushed to the operator's ECR.
  Dockerfile: images/runner/Dockerfile   Build script: images/runner/build.sh

Layer 2 — per-repo job image (per-repo CI or `fleet image build`)
  fleet-job:<hash>  (hash = sha256(base-tag + \0 + setup-inputs)[:16])
  FROM fleet-runner:<cli>-<version>  +  repo setup layer (optional)
  Rebuilt only when the base tag or setup inputs change.
```

**Activation:** only when `manifest.harness.cli_version` is set. Without it the daemon launches whatever `manifest.setup.image` names — existing manifests and simple setups are unaffected.

**Image selection at dispatch:** `fleet delegate` computes the hash and checks locally. If the job image exists it is reused; if not, it builds it from the runner base. The resulting tag is passed to the daemon as an optional `image` field in the POST body; the daemon forwards it to the provider, which uses it in preference to `manifest.setup.image`.

**Hash inputs:** `sha256(runnerBaseTag + "\0" + JSON({script, devcontainer, dockerfile}))[:16]`. Setup-script content is hashed, not just the path. `setup.image` is intentionally excluded — in two-layer mode the runner base *is* the image.

**Workspace materialisation:** the Docker provider passes `FLEET_MANIFEST_JSON`, `FLEET_WORK_ORDER_JSON`, and `FLEET_SYNC_JSON` as base64 env vars. The runner writes these to `FLEET_WORKSPACE` before any file reads. Process-provider jobs already have the files on disk; `materializeWorkspace` is a no-op for them.

**Auth note:** API keys (`ANTHROPIC_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, …) are never baked into an image layer — they enter the container only at start via `-e` flags. This is enforced in the Dockerfile (no `ARG`/`ENV` for secrets) and verified in `test/cli-image.test.ts`. Delegated jobs bill via the operator's own API key, which is never stored in or transmitted through the image.

## The contracts

| Contract | Schema | Consumed by |
|---|---|---|
| Manifest — what a sandbox needs to be this repo's environment | `schemas/manifest.schema.json` | CLI (lint, delegate), daemon (dispatch validation), runner (gate, harness command) |
| Work order — what one dispatch says: mode, target, permissions, finish line | `schemas/work-order.schema.json` | CLI (built from `presets/modes.json` + flags), daemon |
| Events — what a running job emits | `schemas/events.schema.json` | runner (emits), daemon (validates at intake), CLI and any UI (render) |
| Decision file — how a sandboxed agent asks a human a question | `schemas/decision-file.schema.json` | the repo's harness commands (write it), runner (validates, forwards) |
| Job states | `schemas/job-states.json` | daemon (enforces transitions) |

Two rules make the contracts real rather than decorative: the daemon validates **every** event at intake and rejects rather than coerces, and the CLI validates manifests and work orders **before** any request is sent (`fleet lint` runs with no daemon at all, so target repos can gate their own CI on it).

## Job lifecycle

States: `queued → running → blocked ⇄ running → done`, plus `cancelled` from anywhere non-terminal. Provisioning and container start happen under `queued`.

Blocked has a cost model, not just a state:

1. **Hot** — the container idles waiting for an answer, up to `limits.block_hot` (default 30m). Cheap resume.
2. **Parked** — on expiry the runner commits work-in-progress to the job branch and the task exits. A parked job consumes nothing. Marker `parked` on the blocked state.
3. **Stale** — unanswered past `limits.decision_timeout` (default 24h). Marker `stale`; surfaced first in `fleet status`; never auto-answered.

Resume is **re-entry, not session restore**: answering a parked job starts a fresh task that checks out the job branch and re-invokes the command with the answer injected. This requires harness commands to be status-driven (safe to re-invoke), which is a documented requirement on target repos.

The wall-clock limit meters agent runtime only — it pauses while blocked. Expiry means SIGTERM, a grace window, a settle with partial outcome, state `cancelled`, branch retained.

**When the work push fails, the workspace stays.** Workspaces are otherwise as disposable as containers, because evidence lives in the pushed branch and the event log. A failed push is the one case where that is false: the directory is the only copy of the work. So the runner leaves a retain request in the (git-excluded) out/ channel, the provider keeps the directory instead of deleting it and registers the path under `$FLEET_HOME/retained/<jobId>.json`, and the settle notes carry the path into the transcript. `fleet doctor` reports every retained workspace as a finding so none leaks silently; `fleet resume-push <job>` retries the push from it — reusing the runner's own push path — and removes the directory and the record only once `origin/<job-branch>` provably contains that workspace's HEAD. A push outcome alone is never enough (a branch can be ahead of base with somebody else's commit), and every failure path leaves both directory and record untouched. `FLEET_KEEP_WORKSPACE=1` remains a separate, unconditional debugging override: it keeps the directory whether or not a push failed, and registers nothing on its own.

Host-side recovery is the process provider's story, because that is the provider whose workspaces are host directories. Container-based providers keep the failed job's workspace inside its stopped container or task, where `resume-push` cannot reach it — recovery there is by hand (`docker start`/`exec`, or the task's logs), and a cancel or wall-clock backstop that calls `terminate` removes the container along with it.

## Decisions and answers

A sandboxed agent cannot ask its own model to guess policy. When it hits a question only a human can answer, its command writes `.fleet/out/decision.json` — question, two or more options with stable ids, exactly one recommended (schema-enforced) — and ends its turn. The runner validates the file, emits a `decision` event, and the job blocks.

Answers travel one path only: the daemon's operator-authenticated answer API. The runner's per-job token cannot call it; the container has no credentials for it. An agent can never resolve its own blocker — by construction, not by prompt.

Who holds the wait, in order of preference:

1. **The dispatching harness session.** `integrations/SKILL.md` teaches any coding harness to dispatch, poll, relay the decision to the human through its own question mechanism (options verbatim, recommendation marked, never auto-answered), post the answer, and report the settle. The decision schema maps one-to-one onto every harness's ask tool — same contract on both ends of the pipe.
2. **A terminal.** `fleet delegate --watch` or `fleet attach --answer` prompt on stdin.
3. **Nobody.** A webhook ping if `FLEET_NOTIFY_WEBHOOK` is set; otherwise pull via `fleet status`, which lists blocked jobs first.

Invariant across all three: **watching is a view, never a lifeline.** Disconnecting a watcher changes nothing — events are persisted, hot→park→stale proceeds, any session on any machine re-attaches later.

## The finish line

A work order names a target rung on the evidence ladder (`schemas/work-order.schema.json`, `$defs.rung`): inspected → implemented → focused-green → static-green → pushed → pr-open → ci-green → reviews-clear → mergeable → merge-ready → merged → deployed → runtime-accepted. The runner reports the rung actually reached; the daemon verifies claims mechanically where it can and records verified-vs-claimed. `merged` is always a human act. `deployed` and `runtime-accepted` exist on the ladder but cannot be targeted: Fleet never merges and never deploys, and jobs can never be granted those permissions (schema-invalid to request).


## The delivery model

What a job hands back is decided by where its delivery contract lives — three sources, ranked:

1. **The command owns it (the ideal).** A repo's harness command ends in a defined delivery: a draft PR, or an external-system update (wiki page, tracker ticket) performed with the manifest's service credentials. Versioned, gated, critic-reviewed; this is why Fleet expects repos to bring a harness.
2. **The prompt owns it (supported, degraded).** A detailed dispatch can carry the workflow inline ("do X, then open a PR"). Mechanically identical, but it is a prompt-level contract — no reusable gate, no wired critic, re-typed per dispatch. Right for one-offs; an ad-hoc prompt that worked twice should be promoted into a command.
3. **Nobody owns it.** Then the delivery is the evidence itself — and that is not a fallback but the universal floor: every job delivers its transcript, its settle report, and its artifacts (`.fleet/out/artifacts/`, listed in `produced[]`). Stronger deliveries stack on top of the floor, never replace it.

Vagueness changes the **mode**, not the mechanism: an open-ended request is an honest `assess`/`investigate` dispatch whose deliverable is the report artifact, while a vague `implement` dispatch should die at the pickup gate — implement-mode readiness requires acceptance criteria. The layering underneath: **capability** comes from the manifest (env, services; enforced physically from the credentials phase on), the **contract** comes from the command or the prompt, and the **evidence** comes from Fleet regardless.

## Security model, current honesty

- Runner endpoints authenticate with a random per-job token valid only for that job; the token authorizes posting events and polling for answers, nothing else.
- Operator endpoints trust the unix socket's permissions locally, and the operator's own AWS identity via SSM port-forwarding remotely. Zero open ports.
- What is **not** yet enforced: credentials injected into the sandbox are the operator's own (they can do whatever the operator can), and egress is unrestricted. Both are the next phase's work (short-lived scoped tokens from a broker; per-job egress allowlisting; an exercisable kill switch). Until then, treat Fleet as single-operator infrastructure.

## What Fleet is not

- **Not a coding harness.** The agent loop inside the sandbox is whatever the repo already uses; the agent loop outside is whatever you already sit in. Fleet is the pipe between them.
- **Not a hosted service.** Everything runs in your account; there is no vendor control plane.
- **Not an autonomy engine.** Human gates are load-bearing: the pickup gate before model spend, the decision protocol mid-run, the human merge at the end.
