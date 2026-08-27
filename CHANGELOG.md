# Changelog

Operator-facing release history for `ownfleet`. Each entry is written by the
release playbook (`agents/release.md`), reviewed as a draft release PR, and
shipped by merging it — the publish workflow uses the merged entry, verbatim,
as the GitHub Release body.

## 0.2.0 — 2026-08-27

The first release cut by the release pipeline. It spans everything merged since
the 0.1.0 hand publish — the week Fleet went from "first live cloud run" to a
deployment that upgrades, verifies, and releases itself.

### What's new for you

- **A dispatch is a target and a prompt.** Modes are gone from the surface: name
  an issue (`fleet delegate 42`), a PR (`fleet delegate pr/7`), or write the ask
  in prose — authority and the finish line follow the shape. `--mode` still
  works, warns, and maps onto the same defaults. Want a prose job to end in a
  PR? Say so in the prompt; the runner notices the PR the agent opened and
  reports the rung honestly.
- **`fleet upgrade`** converges a deployment to your CLI's commit: re-pins the
  Terraform unit, plans, applies on your yes, triggers the in-account image
  rebuild where the source allows, and re-captures the config. **`fleet doctor`
  now detects deployment skew** — images and unit carry a build stamp, and drift
  from your CLI is a named finding with the fix, not a silent gap.
- **`fleet setup infra` builds the images in your account** (a one-shot
  CodeBuild project at the applied ref) — no clone, no local Docker on the
  happy path. `--rebuild-images` re-runs it alone.
- **Auth got humane.** The operator token publishes itself through SSM at boot
  and the CLI fetches it with your AWS credentials — the execute-command dance
  is dead. Subscription seats are first-class: `fleet setup repo` detects a
  seat login and walks the one-paste token setup; doctor reports auth health;
  a job whose credential expires parks with a question instead of dying.
- **Jobs stopped losing work.** The runner checkpoints WIP to the job branch
  every 10 minutes; teardown pushes are bounded so the settle always fits; a
  daemon-initiated cancel now waits for the runner's teardown instead of
  rejecting it mid-flight; cancel settles collect the artifacts already on
  disk; a harness that crashes retries once on its own, keeping the failed
  attempt's branch as evidence (`fleet reclaim` releases a dead job's claim by
  hand).
- **Artifacts are visible.** `fleet status` and the board show `done · N
  artifacts` from the daemon's own index; the settle prints per-file fetch
  commands; `fleet artifacts <job> get --all` pulls everything, sha-verified.
- **The daemon got fast and honest under load.** Terminal jobs leave memory
  (boot no longer re-reads every journal); daemon downtime is no longer billed
  to job clocks; `gh` verification runs off the intake path so a settle can't
  freeze the API; artifact intake dropped its O(N²) walk and torn writes can
  no longer be served as valid.
- **Security hardening from the first live runs:** manifest secrets moved off
  process argv; job-controlled PR references can't inject `gh` flags; the
  worker IMDS hop limit dropped to 1; the daemon container runs as uid 1000 on
  an EFS access point; `setup.sh` runs as root for your prerequisites and the
  agent never does; repo-named daemon targets are refused unless loopback.
- **Workers default to t3.xlarge with the full tier for each job** — 2-vCPU
  boxes starved test suites into their wall-clock budgets. `min_instances`
  offers a warm floor when you want to skip the cold start; workers register
  with SSM so a stuck box has a break-glass path.
- The cockpit no longer freezes on a cold-image delegate; `fleet attach`
  survives overnight tunnel blips; a dev checkout no longer weighs 2.3GB
  (shared Terraform plugin cache).

### Upgrade notes

- `infra/` changed extensively (EFS access point, IMDS hop limit, IAM grants,
  worker tier, CodeBuild project, SSM agent): re-run `terraform apply` for your
  deployment — `fleet upgrade` now drives this.
- `images/` changed (privilege model, build stamps, layer order): rebuild both
  images and roll the daemon — `fleet upgrade --rebuild-images`, or
  `images/build.sh --redeploy-daemon` from a checkout for local-path sources.
- Schemas moved deliberately: `mode` on work orders is optional and ignored
  (removal comes in a later release — regenerate your repo's gate copy before
  the CLI stops writing the compat value); work orders gained per-dispatch
  `limits` overrides that are now actually consumed; manifests without
  `limits` get real defaults (idle 20m, block_hot 30m, decision_timeout 24h);
  two never-consumed report properties were deleted. Existing journals and
  stored orders load unchanged.

### Breaking changes

None. Pre-0.2.0 work orders validate, parked jobs re-enter, and old gate
copies keep working via the compat `mode` field. The `--publish` flag existed
only inside this release's span — no published version ever carried it.

### All merged PRs

- #91: ci: bump hashicorp/setup-terraform from 3.1.2 to 4.0.1
- #92: ci: bump actions/setup-node from 4.4.0 to 7.0.0
- #93: ci: bump actions/checkout from 4.4.0 to 7.0.1
- #164: Fix all Lizard complexity violations detectable without Codacy
- #165: #138: infra/aws pre-live robustness bundle
- #166: #126: Manifest secrets are visible in ps while docker and aws commands run
- #167: #116+#118: daemon downtime stops billing jobs; terminal jobs leave memory
- #168: #128: Two event-rendering switches, two GhRunners, two FleetEvents
- #169: #134+#139: limits get real defaults and overrides; runner settle-path hardening
- #170: #119: Artifact intake: an O(N²) cap walk and torn writes served as valid
- #171: #147: Reconcile orphaned ECS tasks: a timed-out run-task can leave a billing container with no handle
- #172: #117: A synchronous gh network call inside event intake freezes the daemon
- #173: #121: Cockpit delegate with a cold image freezes the terminal until SIGKILL
- #174: #124+#125: one follow loop, CLI polish; refuse untrusted daemon targets (#135)
- #176: #175: Job-controlled report.pr reaches gh argv without a separator
- #177: #67: Warm capacity floor: min_instances so jobs can skip the cold start
- #178: #129: Dead schema properties and test-only code on the SHIP side
- #179: #131: A dev checkout weighs 2.3GB: three copies of the Terraform AWS provider
- #180: #30: Retry policy: harness-exit should not require operator hands
- #182: #181: Docs and comments store temporal state that rots into false claims
- #186: #183: Publish to npm pipeline — claim the ownfleet name
- #192: #36: Remove modes from the surface: dispatch is a target and a prompt
- #193: #191: t3.medium is not a safe worker default: suite-heavy jobs starve on 2 vCPUs
- #194: #187: The reconcile sweep ships without its IAM grant: daemon lacks ecs:ListTasks/DescribeTasks
- #199: README: align install, prerequisites, cost bounds, and operator commands with this week's merges
- #200: #196: setup.sh runs as root, the agent never does
- #201: #195: An artifact job finishes silently: surface deliverables everywhere and fetch them in one command
- #202: #188: The operator token bootstraps through SSM, not through ecs execute-command by hand
- #203: #197+#190: the keepalive outlives quiet harnesses; teardown and checkpoints deliver the work
- #204: #189+#198: the wizard builds the images in your account; workers get a break-glass path
- #206: #205: Subscription-seat auth is a first-class setup path
- #209: #183: Publish to npm pipeline
- #210: #208: Remove --publish: prose delivery is prompt-owned; the runner grades what actually happened
- #211: #207: fleet doctor detects deployment skew (part 1 — the upgrade command follows #183/#189)
- #212: #207: skew compares git::file dogfood pins instead of shrugging
- #213: #207: fleet upgrade converges the deployment to the CLI's commit

## 0.1.0 — 2026-08-26

Published by hand to claim the `ownfleet` registry name (#186); `fleet` and
its near variants were unavailable. No changelog existed before this file —
the release pipeline (#183) starts the record here.
