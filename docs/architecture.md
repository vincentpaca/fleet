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
- **Terraform** (`infra/terraform/`): the substrate itself — cluster, capacity provider, ECR, IAM, the daemon service, SSM-only access, a budget alarm. One apply per AWS account.

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

## Security model, current honesty

- Runner endpoints authenticate with a random per-job token valid only for that job; the token authorizes posting events and polling for answers, nothing else.
- Operator endpoints trust the unix socket's permissions locally, and the operator's own AWS identity via SSM port-forwarding remotely. Zero open ports.
- What is **not** yet enforced: credentials injected into the sandbox are the operator's own (they can do whatever the operator can), and egress is unrestricted. Both are the next phase's work (short-lived scoped tokens from a broker; per-job egress allowlisting; an exercisable kill switch). Until then, treat Fleet as single-operator infrastructure.

## What Fleet is not

- **Not a coding harness.** The agent loop inside the sandbox is whatever the repo already uses; the agent loop outside is whatever you already sit in. Fleet is the pipe between them.
- **Not a hosted service.** Everything runs in your account; there is no vendor control plane.
- **Not an autonomy engine.** Human gates are load-bearing: the pickup gate before model spend, the decision protocol mid-run, the human merge at the end.
