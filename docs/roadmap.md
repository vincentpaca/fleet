# Roadmap

Work is tracked as GitHub issues; this file holds the phase structure and exit criteria the issues roll up to.

## Phase 1 — first real delegated run

**Exit:** a real ticket goes `fleet delegate` from a laptop → the autoscaling group scales from zero → the job blocks on a real decision → the laptop is shut mid-job → the job keeps running → the decision is answered from another machine → a merge-ready PR with green CI exists → the transcript replays from the daemon's event log → the cluster is back at zero instances.

Done so far: the five schema contracts and their tests; daemon (validated event intake, state machine, answer API, restart survival); runner (pickup gate, stream translation, decision loop, park/re-entry, wall-clock caps, artifact collection, settle with PR delivery per the AGENTS.md delivery standard); CLI (init, lint, delegate `--watch`, status, logs, attach `--answer`, answer, cancel, doctor, artifacts, connect, and the cockpit — bare `fleet`: live board, job tail, command line, tunnel adopted or owned); process/docker/ecs providers; two-layer job images with ECR publish; self-describing infra via `fleet_config`; right-sizing; legible event logs; the harness integration skill. All of it dogfooded — this repo's own tickets are implemented by Fleet jobs.

Remaining: see the open `phase-1` issues. The critical path is the AWS substrate: an external review found four concrete defects that prevent the first real cloud job (daemon reachability from runner tasks, capacity-provider launch strategy, scale-to-zero blocked by the daemon's own service, missing daemon image) — those land first, then the operator bring-up (#9), whose exit scenario becomes a repeatable acceptance test.

## Phase 2 — credentials and enforcement

Short-lived scoped tokens from a credential broker (a job's GitHub token cannot merge — physically, not by prompt); per-job egress restricted to the manifest's allowlist; `fleet stop` as a global kill switch with a repeatable drill that proves revocation, container termination, branch retention, and PR-drafting inside a fixed propagation window. Until this phase lands, sandboxes carry operator credentials with open egress: single-operator use only.

## Phase 3 — a UI over the event stream

A web surface that consumes the same events and answer API the CLI uses: live job board (blocked first), decision cards, run history. Zero changes to daemon or runner — if the UI needs a daemon change, the event contract failed.

The cockpit (bare `fleet`) is the first surface built to that rule and cost the daemon nothing: board, decision cards and answers all came out of the existing event stream and answer API. It is the terminal-native answer, not a substitute for the web one — but it is the proof that the contract carries a live surface.

## Phase 4 — managed sandbox substrates

One provider over a managed microVM substrate, for per-job isolation beyond shared-kernel containers and proof that the manifest ports across substrates. Additional cloud units (`infra/<cloud>/` + provider + tests, per `docs/decisions.md#d12`) when someone needs one.

## Phase 5 — fleet operations

Parallel batches with a fan-out policy, overnight runs with a morning digest, interactive answers from chat channels, per-job cost reporting. Entry condition: model-spend metering exists, or every batch prints a computed worst-case budget — wall-clock bounds one job, not a batch.
