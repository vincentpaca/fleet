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

Fleet is a standalone tool. Knowledge from real deployments informs its design as shapes and invariants; the content stays out, permanently. Enforced mechanically: `test/sanitized.test.mjs` scans the whole tree on every test run, and external-data compatibility is verified by pointing an env var at files outside the repo, never by vendoring them — `FLEET_DEMO_HISTORY` for a real run history, `FLEET_HARNESS_CORPUS` for a captured harness stream. In-repo fixtures for the same shapes are synthetic and generic; only they may be snapshotted.

## D11 — GitHub Issues are the work source for this repo

A delegatable ticket needs an identifier, a readable spec, a machine-checkable readiness state, and a place for results to land. For this repo that is a GitHub issue (id, body with acceptance criteria, `ready` label, PR link-back), with `docs/tasks/<n>-*.md` files for specs too large for an issue body. The pickup gate checks issue readiness via `gh`.

**Amended 2026-08-22 — readiness is checked per mode, not per dispatch.** The gate originally ran the issue check unconditionally, which made `fleet delegate "<prose>" --mode investigate` un-dispatchable on this repo: a legitimate prompt-target job whose deliverable is a report artifact died for not being a ready ticket. A gate should spend strictness proportionally to the authority the mode grants, so `implement`/`followthrough` (edit authority, PR at the end) pay the full check while the read-only modes (`assess`/`investigate`/`review`/`compare`) pass with a note. A missing target still fails everywhere. Naming issues as the work source was never a demand that every dispatch be a ticket, and this repo's gate is the reference implementation others copy.

## D12 — Clouds are self-contained units; core defines requirements, not choices

Fleet is two steps: (1) stand up infrastructure — on any cloud, possibly several; (2) `fleet delegate` against whatever exists, including on repositories that predate Fleet. Core therefore defines *requirements* a cloud unit must satisfy — run containers on demand, host the daemon with durable state, store images, give the operator access without public ingress, scale to zero behind a hard capacity cap — and each cloud satisfies them its own way inside its own unit: `infra/<cloud>/` (module, variables, outputs, README, example) paired with a `src/providers/<name>.ts` implementation and both of their tests. AWS is the first unit, not the architecture; D2's "ECS on EC2" binds only `infra/aws/`. Enforced mechanically: core code cannot import a concrete provider (composition root excepted) and every infra unit must ship complete — `test/cloud-agnostic.test.ts`.

**Amended 2026-08-19 — billing products are out.** The requirement list originally included "carry a cost backstop", which `infra/aws/` satisfied with an AWS Budgets alarm. Removed: that was a feature built from what one cloud makes easy, not from the product. Fleet's cost bounds are structural — scale to zero, the capacity cap, per-job wall-clock — and they are control, not monitoring. A unit-provisioned budget meters the whole account unless cost-allocation tags are activated (its first live alarm attributed 18 days of unrelated account spend to a day-old deployment), and billing alarms are the operator's own regardless of cloud. Per-job spend visibility returns as fleet-native metering (roadmap phase 5), not as billing-product wrappers.

## D13 — Source-available under PolyForm Shield; "open source" is not claimed

Fleet's license must let anyone use, modify, and self-host it — commercially included, because adoption is the point — while making the one feared act impossible: someone offering Fleet itself as a competing product or managed service. That is PolyForm Shield 1.0.0 (`LICENSE.md`), professionally drafted, SPDX-listed, permanent (no delayed conversion), and precedented in this exact product category (AutoGPT's platform, Micro). Alternatives considered: MIT/Apache (no protection), AGPL (permits commercialization, scares legitimate adopters' legal teams), FSL/BUSL (protection expires by design), n8n-style sustainable-use (blocks more than necessary). Because OSI open source definitionally forbids use restrictions, Fleet says "source-available", never "open source" — overclaiming invites the community's justified correction. Relicensing toward permissive stays cheap only while contributions are few; revisit before accepting substantial outside work.

## D14 — Files crossing the runner↔daemon boundary are the operator's own

Four CodeQL alerts describe Fleet's central mechanism as a vulnerability, and they will keep doing so, so the answer belongs here rather than in four dismissal comments.

`js/file-access-to-http` flags `src/cli/client.ts` and `src/runner/artifacts.ts` for reading a file and putting it in an HTTP request. `js/http-to-file-access` flags `src/runner/decisions.ts` for taking an HTTP response and writing it to disk. Those queries look for a file whose content an attacker chose reaching a network call, and for a response from a host an attacker chose landing on a filesystem — server-side request forgery and remote file write. Fleet's job is to carry the operator's own repository files from the operator's own sandbox to the operator's own coordinator, over a unix socket or a tunnel the operator opened. There is no untrusted source and no attacker-chosen sink; the flow the queries found is real and is the product.

Accepting that is not the same as accepting the boundary is unguarded. What actually protects it, and where each control is tested:

- Synced paths that resolve outside the workspace root are dropped, in `materializeWorkspace` and in `ProcessProvider.prepareWorkspace`. A work order cannot write into the container's filesystem at large.
- The runner's token authorizes `/internal/*` for its own job and nothing else. The answer API is unreachable with it, which is the invariant the whole design exists for.
- The daemon validates every event against `schemas/` at intake and rejects rather than coerces.
- Artifacts are the files the collector walked out of `.fleet/out/artifacts/`, sized by the bytes read, under a per-file and a total cap.

This decision expires if any of four things changes: the daemon becomes reachable from outside the operator's own network path; artifact paths start coming from a work order or an event instead of the directory walk; the answer written to `.fleet/out/` starts being consumed as anything but data; or a job's files start arriving from a source the operator did not name. Any of those makes the queries right and this entry wrong.

## D15 — The event journal is the single source of truth; job.json is a reconciled snapshot

Per job, `events.jsonl` is authoritative. `job.json` exists for fast boot and O(1) listing — at load it is verified against the journal's tail and repaired by replaying the same effects function intake uses, and every repair is logged loudly. Intake appends to the journal before recording any derived state, and writes the snapshot exactly once per event — never mid-intake; the write-count test is the checkpoint. The runner's claimed seq is stored on the event, making intake idempotent by content: a retried seq whose payload matches the stored event is acknowledged as a duplicate; a reused seq with different content is rejected. Dedup means "I already have exactly this," never "I'll ignore whatever this is."

Full event sourcing — `job.json` as a disposable cache rebuilt by replay — was considered and rejected: boot must not read settled jobs' journals (that cost grows with lifetime usage), so a trusted snapshot must exist; once it exists, reconciliation, not disposal, is the honest contract.

One function derives the record, and it is the one intake calls — a second derivation path for the reconciler would drift from the first, which is the failure this entry exists to prevent. Its *outward* effects do not replay: webhook notifications, the `gh` rung check and the container reap run on intake only. Replaying them means paging the operator again for every historic decision on every restart, blocking boot on a synchronous subprocess, and terminating containers from a constructor. Wall-clock accounting also does not replay — it reads the daemon clock, so a replay would collapse every recorded segment to zero and hand a job a fresh budget; the snapshot's value stands, and that is the accepted cost of the journal not carrying it.

Per job, that snapshot is two files. `job.json` is the hot record, rewritten once per event; `launch.json` holds the write-once launch data — the manifest, the synced-file map, the work order — which is most of the bytes and none of the change. Keeping them together made every event re-serialise a manifest, which on EFS is a per-event network round trip sized by data that never moves.

Two files means two failure modes the single file did not have, and both are handled by a version marker (`launchSplit`) that every post-split write stamps into `job.json`. A job created before the split carries its launch fields inside `job.json` and has no marker: the loader migrates it, writing `launch.json` from what it read. That write is not optional — `job.json` is rewritten on the job's very next event *without* those fields, so a legacy job that is read but not migrated has its launch half in neither file from then on. A missing `launch.json` next to a *marked* `job.json` is the other mode: the two tmp+renames are not ordered against each other, so a host crash can persist one and lose the other (this entry accepts no fsync, below). That is corruption, and the marker is what tells it apart from a legacy job — guessing "legacy" would silently serve a job with no work order.

A lost launch half is logged and recorded as a `log` event in the job's own journal, not treated as fatal: the journal is intact, so the job serves its history and still settles, and taking a live job out because its write-once half is torn would be the boot crash-loop this entry exists to prevent. It cannot be re-launched after parking, and the journal note is what says so — stderr on a container host is not somewhere an operator looks.

The launch file's fields are read by name, never spread wholesale into the record. It is merged over the card, so anything that parses would otherwise be persisted and served: an array injects index keys, and an object carrying `state` or `runnerToken` overrides the card. On the process provider the job runs as the same user with access to `$FLEET_HOME`, which would make that a job editing its own control record — the one thing the `/internal`-only runner token exists to prevent.

Boot is tolerant of torn files (issue #112): a truncated final NDJSON line is dropped, a job whose `job.json` or journal cannot be read whole is quarantined (renamed once to `<id>.corrupt`, never loaded again), and the daemon loads the rest.

A single-writer lock (`daemon.lock`) is claimed before the registry opens the home — loading quarantines dirs and reconciliation rewrites `job.json`, so a lock taken any later would refuse only after writing into a home it does not own. **Liveness is a heartbeat, not a PID.** The daemon runs as PID 1 of its Fargate task with `FLEET_HOME` on EFS: after a crash the lockfile holds `1`, and the replacement task asking "is PID 1 alive?" is asking about itself, so a PID check turns one crash into a permanent refusal to boot — the exact failure #112 exists to remove. The holder refreshes `updatedAt` every 5s; a lock not refreshed for 15s is a corpse and is reclaimed loudly. A contender that starts inside that window refuses and is restarted by its supervisor: bounded, never permanent.

**No fsync, and the loss window is accepted rather than closed.** Neither the journal append nor the `job.json` rename fsyncs the file or its directory. A process-only crash loses nothing — the data is in the kernel once the synchronous write returns — and EFS/NFS flushes on close, which covers the deployment above. What remains exposed is a *host* crash (power loss, kernel panic) on a local or process-provider home: events the daemon already 200-acked can vanish, and the runner's seq bookkeeping accepts the gap silently. That is accepted because the fix costs an fsync per event on the hot path for a fault class this deployment does not have, and because append-before-seq already turned the far likelier failure — a daemon crash mid-intake — from a lost event into a deduped retry. This clause is the decision; it expires the moment a durability claim is made to an operator about a non-EFS home.
