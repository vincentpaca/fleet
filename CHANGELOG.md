# Changelog

Operator-facing release history for `ownfleet`. Each entry is written by the
release playbook (`agents/release.md`), reviewed as a draft release PR, and
shipped by merging it — the publish workflow uses the merged entry, verbatim,
as the GitHub Release body.

## 0.2.1 — 2026-09-05

A fix release that turned into the week Fleet stopped being a one-harness tool.
The headline is small and urgent — every git-wired dispatch was dying before the
harness started — but the same investigation produced an end-to-end test that
now runs four different coding CLIs against a repository that is not this one.

### What's new for you

- **Your dispatches work again.** Any job whose manifest declared a
  `setup.script` died at `git config user.name` with a message naming the
  command and not the cause. The runner stays root through the clone so an
  operator-written setup script can install packages, but the image had handed
  `/workspace` to the job user, and git refuses a repository owned by somebody
  else. If jobs have been failing since late August with a git error that made
  no sense, this is why. **Rebuild your runner image** — the fix is in the
  image, not the CLI.
- **Git failures say what git said.** The settle report kept only the first
  line of an error, and for a spawned command that line is the arguments echoed
  back. It now carries the tool's own first line of stderr, which is the
  difference between "Command failed: git config user.name Vincent Paca" and
  "dubious ownership in repository at '/workspace'".
- **`fleet canary`** dispatches a small read-only job through the normal path
  and tells you whether the deployment can actually run one. Point it at a
  freshly rolled image before you trust it: the git bug above sat undetected
  for three days because nothing exercised a real job after a rebuild.
- **Run a harness Fleet has never heard of.** `FLEET_HARNESS_CMD` names the
  command to spawn and is read before the `harness.cli` check, so any CLI runs
  without a schema entry, an adapter, or a release. Claude Code, Codex,
  OpenCode and omp each now complete a real job against an external repository
  in Fleet's own CI. What you give up is the transcript — the translator speaks
  claude-code's dialect — and the injected output contract, so an override's
  prompt has to say where deliverables go. Delivery itself is unaffected: the
  settle reads the report off disk. See `docs/architecture.md#harnesses` for
  each CLI's working invocation, including which need an API key rather than a
  subscription sign-in.
- **`--destroy` finishes.** Tearing a deployment down stalled on a non-empty
  ECR repository and left half a deployment plus a manual batch-delete before
  you could retry.
- **`fleet doctor` and `fleet resume-push` agree.** Doctor called a retained
  workspace healthy whenever its directory existed, while resume-push discarded
  the record unless a git repository was really there — so doctor recommended
  the command that would throw away the record it had just reported. Both now
  check for a repository, and doctor distinguishes a path that is gone from one
  that is present without a repository in it.
- **The operator token survives a race.** It was written check-then-create, so
  two processes starting together could each mint one and the loser would
  overwrite a token already handed to a cockpit or a tunnel — a working client
  refused with nothing to explain it. It is created exclusively now, and an
  empty token file left by a killed run is claimed rather than returned as the
  token.
- **The daemon stops echoing error text.** A 500 carried the error's message,
  which holds absolute paths and internal state, to a client that may be a
  job's runner rather than you. It is logged instead.
- **The paper airplane in the banner is the real asset**, not a hand-drawn
  pixel grid.

### Upgrade notes

- **Rebuild your runner images.** `images/runner/Dockerfile` changed and the
  `/workspace` ownership fix lives there — a CLI upgrade alone leaves every
  git-wired dispatch broken. `fleet upgrade --rebuild-images`, or
  `images/build.sh --redeploy-daemon` from a checkout.
- **Re-run `terraform apply`.** `infra/aws/main.tf` changed: ECR repositories
  are created with `force_delete` so a teardown is not blocked by pushed
  images. Note the consequence — a change that replaces a repository now
  deletes the images inside it rather than failing loudly. They are rebuildable
  from a pinned ref, which is the standing assumption (D16).
- **Then run `fleet canary`.** It exists because a rolled image that cannot run
  a job is invisible until a real dispatch fails on it.
- No schema changes: existing manifests and stored jobs need nothing.

### Breaking changes

None.

### All merged PRs

- #216: Registries no longer block a teardown
- #219: #218: Runner image chowns /workspace to the job user; root-phase git dies on dubious ownership
- #221: #220: fleet canary: prove the deployment on a live job after an image roll
- #222: Fix the intermittent resume-push failures: workspace validity and temp isolation
- #226: #225: One paper airplane everywhere: the real dart art in the dashboard and help
- #229: #224: End-to-end against a foreign repo, one row per harness
- #231: ci: bump fast-uri from 3.1.5 to 3.1.7 in the npm_and_yarn group across 1 directory
- #232: Cloud lifecycle drill: apply, delegate, destroy
- #233: Check a retained workspace holds a repository, not just a .git entry
- #234: Resolve the open code-scanning alerts
- #235: README: say that a harness without an adapter still runs

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
