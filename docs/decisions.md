# Decisions

Short records of the calls that shape Fleet, so tickets and code reviews can cite them instead of relitigating them. Newest last.

## D1 — Remote-only; the operator's machine is never the substrate

The point of Fleet is additional compute. A sandbox on your own machine is a background session with extra steps. The Docker provider works against any `DOCKER_HOST` for Fleet's own development loop, but nothing ships, exits, or demos on local containers.

## D2 — ECS on EC2, autoscaling from zero; not Fargate, not Kubernetes

Jobs are ECS tasks; capacity is an autoscaling group with min 0. Fleet contains no instance-lifecycle code — the capacity provider owns it. EC2 launch type rather than Fargate because the planned per-job egress filtering needs control of the AMI and network namespaces, which Fargate does not give. Not EKS because a control plane's worth of complexity buys nothing for a single-team system.

## D3 — TypeScript on Node, no build step

All three components run on Node's native type stripping (erasable syntax only). Every job image already carries Node because the first supported harness CLI is an npm package, so the runner adds no dependency to the sandbox. Escape hatch: the runner alone can become a static binary later — the event schema is the interface, so nothing else would change.

## D4 — Schemas are the source of truth, validated at the edges

Five JSON Schemas own every data shape. The daemon validates every event at intake and rejects rather than coerces; the CLI validates before sending; `fleet lint` runs schema validation with no daemon so target repos can gate their CI on it. A rule that lives only in prose is a suggestion; these are checkpoints.

## D5 — Merge and deploy are never grantable

Not policy — schema: a work order requesting `merge: true` or `deploy: true` is invalid, and the finish rungs `merged`, `deployed`, `runtime-accepted` cannot be targeted. Humans own merges. Deployment is out of scope entirely.

## D6 — The evidence ladder, and never overstating the rung

"Done" collapses too many different states, so jobs report a rung on an explicit ladder and the daemon verifies claims mechanically where it can (recording verified-vs-claimed). `mergeable` is deliberately listed as a weak rung: conflict-free is not merge-ready.

## D7 — Blocked jobs park; watching is a view, never a lifeline

A blocked job stays hot briefly (default 30m), then commits WIP and exits — parked jobs cost nothing. Resume is re-entry (fresh task, job branch, answer injected), not session restore, because agent sessions generally cannot be restored; harness commands must therefore be safe to re-invoke. No watcher is ever required for correctness: events persist, timers proceed, any session re-attaches.

## D8 — Harnesses are Fleet's UI; Fleet is never a harness

The sandboxed agent raises decisions through the decision file; the local agent (or a terminal) renders and answers them; Fleet is the pipe between two harnesses, not a third one. The decision schema intentionally maps one-to-one onto the question mechanisms coding harnesses already have. Integration with a new harness is a skill/instruction file over the CLI, not code.

## D9 — Notifications are three optional tiers, and none is required

The dispatching session holds the wait when present; `--watch`/`--answer` serve a terminal; `FLEET_NOTIFY_WEBHOOK` pings any webhook-compatible sink; and with nothing configured, `fleet status` lists blocked jobs first. The pull loop is the floor and it always works.

## D10 — This repo carries zero client, engagement, or operator-specific content

Fleet is a standalone tool. Knowledge from real deployments informs its design as shapes and invariants; the content stays out, permanently. Enforced mechanically: `test/sanitized.test.mjs` scans the whole tree on every test run, and external-data compatibility is verified by pointing `FLEET_DEMO_HISTORY` at files outside the repo, never by vendoring them.

## D11 — GitHub Issues are the work source for this repo

A delegatable ticket needs an identifier, a readable spec, a machine-checkable readiness state, and a place for results to land. For this repo that is a GitHub issue (id, body with acceptance criteria, `ready` label, PR link-back), with `docs/tasks/<n>-*.md` files for specs too large for an issue body. The pickup gate checks issue readiness via `gh`.

## D12 — Clouds are self-contained units; core defines requirements, not choices

Fleet is two steps: (1) stand up infrastructure — on any cloud, possibly several; (2) `fleet delegate` against whatever exists, including on repositories that predate Fleet. Core therefore defines *requirements* a cloud unit must satisfy — run containers on demand, host the daemon with durable state, store images, give the operator access without public ingress, scale to zero behind a hard capacity cap — and each cloud satisfies them its own way inside its own unit: `infra/<cloud>/` (module, variables, outputs, README, example) paired with a `src/providers/<name>.ts` implementation and both of their tests. AWS is the first unit, not the architecture; D2's "ECS on EC2" binds only `infra/aws/`. Enforced mechanically: core code cannot import a concrete provider (composition root excepted) and every infra unit must ship complete — `test/cloud-agnostic.test.ts`.

**Amended 2026-08-19 — billing products are out.** The requirement list originally included "carry a cost backstop", which `infra/aws/` satisfied with an AWS Budgets alarm. Removed: that was a feature built from what one cloud makes easy, not from the product. Fleet's cost bounds are structural — scale to zero, the capacity cap, per-job wall-clock — and they are control, not monitoring. A unit-provisioned budget meters the whole account unless cost-allocation tags are activated (its first live alarm attributed 18 days of unrelated account spend to a day-old deployment), and billing alarms are the operator's own regardless of cloud. Per-job spend visibility returns as fleet-native metering (roadmap phase 5), not as billing-product wrappers.

## D13 — Source-available under PolyForm Shield; "open source" is not claimed

Fleet's license must let anyone use, modify, and self-host it — commercially included, because adoption is the point — while making the one feared act impossible: someone offering Fleet itself as a competing product or managed service. That is PolyForm Shield 1.0.0 (`LICENSE.md`), professionally drafted, SPDX-listed, permanent (no delayed conversion), and precedented in this exact product category (AutoGPT's platform, Micro). Alternatives considered: MIT/Apache (no protection), AGPL (permits commercialization, scares legitimate adopters' legal teams), FSL/BUSL (protection expires by design), n8n-style sustainable-use (blocks more than necessary). Because OSI open source definitionally forbids use restrictions, Fleet says "source-available", never "open source" — overclaiming invites the community's justified correction. Relicensing toward permissive stays cheap only while contributions are few; revisit before accepting substantial outside work.
