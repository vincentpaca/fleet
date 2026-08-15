# Roadmap

Work is tracked as GitHub issues; this file holds the phase structure and exit criteria the issues roll up to.

## Phase 1 — first real delegated run (in progress)

**Exit:** a real ticket goes `fleet delegate` from a laptop → the autoscaling group scales from zero → the job blocks on a real decision → the laptop is shut mid-job → the job keeps running → the decision is answered from another machine → a merge-ready PR with green CI exists → the transcript replays from the daemon's event log → the cluster is back at zero instances.

Done so far: the five schema contracts and their tests; daemon (validated event intake, state machine, answer API, restart survival); runner (pickup gate, stream translation, decision loop, settle); CLI (init, lint, delegate `--watch`, status, logs, attach `--answer`, answer, cancel); process/docker/ecs providers; the Terraform module (validates clean); an end-to-end test of the full loop on the process provider; the harness integration skill.

Remaining: see the open `phase-1` issues. The critical path is the git/PR delivery layer — clone onto a job branch, push at creation, WIP commit on park, PR at settle, `gh`-backed verification of the upper rungs.

## Phase 2 — credentials and enforcement

Short-lived scoped tokens from a credential broker (a job's GitHub token cannot merge — physically, not by prompt); per-job egress restricted to the manifest's allowlist; `fleet stop` as a global kill switch with a repeatable drill that proves revocation, container termination, branch retention, and PR-drafting inside a fixed propagation window. Until this phase lands, sandboxes carry operator credentials with open egress: single-operator use only.

## Phase 3 — a UI over the event stream

A web surface that consumes the same events and answer API the CLI uses: live job board (blocked first), decision cards, run history. Zero changes to daemon or runner — if the UI needs a daemon change, the event contract failed.

## Phase 4 — managed sandbox substrates

One provider over a managed microVM substrate, for per-job isolation beyond shared-kernel containers and proof that the manifest ports off AWS. Raw additional IaaS providers only when someone funds one.

## Phase 5 — fleet operations

Parallel batches with a fan-out policy, overnight runs with a morning digest, interactive answers from chat channels, per-job cost reporting. Entry condition: model-spend metering exists, or every batch prints a computed worst-case budget — wall-clock bounds one job, not a batch.
