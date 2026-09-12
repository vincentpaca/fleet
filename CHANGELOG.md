# Changelog

Operator-facing release history for `ownfleet`. Each entry is written by the
release playbook (`agents/release.md`), reviewed as a draft release PR, and
shipped by merging it — the publish workflow uses the merged entry, verbatim,
as the GitHub Release body.

## 0.3.4 — 2026-09-13

One fix, and it matters: 0.3.3's `fleet connect` was broken on every fresh
deployment. If you installed 0.3.3 and your tunnel died seconds after opening,
this release is the cure — and the release process now carries the drill that
would have caught it.

### What's new for you

- **`fleet connect` holds its tunnel on fresh deployments.** The session was
  opened with SSM's remote-host port-forward document pointed at `localhost`,
  which SSM agents in current base images refuse ("Forwarding to IP address
  localhost is forbidden") — so on any deployment whose daemon image was built
  recently, the tunnel died about four seconds after opening and `connect`
  looped reopening it forever. Deployments built from older images kept
  working, which is how it hid. The session now uses the plain port-forward
  document, which targets the task itself and works on both agent generations.
  The tunnel fallback script, the unit's `connect_hint` output, and the drill
  doc all teach the same corrected invocation.
- **Releases are now gated on a fresh-deployment drill.** The suite proves the
  code against itself; before any release PR opens, the candidate must also
  stand up a from-scratch deployment (fresh images), hold a tunnel, and get a
  clean `fleet doctor` through it — precisely the check that would have kept
  the bug above out of 0.3.3. This release is the first one cut under that
  gate.

### Upgrade notes

- Upgrade the CLI (`npm i -g ownfleet`) and reconnect — the fix is entirely
  client-side. No image rebuild and no re-apply is needed to get a working
  tunnel.
- The `infra/` diff touches only the unit's `connect_hint` output text and the
  fallback tunnel script's invocation: a `terraform apply` re-run refreshes
  that hint but changes no deployed resource. Do it with your next planned
  apply; nothing is waiting on it.

### Breaking changes

None.

### All merged PRs

- #272: #271: fleet connect dies every ~4s on fresh deployments: current SSM agents forbid the RemoteHost document at localhost
- #273: Release gate: a fresh-deployment drill before every release PR
- #274: ci: bump codeql-action init and analyze together to 4.37.9

## 0.3.3 — 2026-09-12

The release where the npm install stops being second class: it can stand up
infrastructure, upgrade what it stood up, and prove the whole path — install,
setup, doctor clean — is now executed by the test suite exactly as the README
teaches it.

### What's new for you

- **`npm i -g ownfleet` can now stand up infrastructure.** The setup chain's
  infra offer used to face-plant on an npm install with `cannot tell which
  Fleet terraform module to use`. The CLI now derives the module source from
  its own release: the package's repository at the `v<version>` tag the publish
  pipeline cut. A checkout still pins its own commit, and `--module-source`
  still overrides both.
- **`fleet upgrade` and doctor's skew check work from an npm install.** Both
  used to decline with "#183 will version releases" — a promise that had
  already shipped. The CLI now identifies by its release tag (verified against
  the package's repository, so a prerelease or locally-built package is refused
  by name rather than pinned at a ref nothing can clone): `upgrade` re-pins the
  deployment and rebuilds images at that tag, and `doctor` reports a
  deployment at an older tag as skew, one at the current tag as clean — sha
  pins from a checkout-era deployment compare correctly against a
  version-identified CLI.
- **First contact survives its second step.** `fleet setup repo` writes a
  no-op readiness gate on repos that have none, and `fleet doctor` — the very
  next command the chain points at — rejected it (`gate script missing`).
  Fixed, and the sweep that found it is now a permanent test: the shipped npm
  layout walks `setup repo → doctor` clean in CI.
- **The README carries the agent path, and CI executes it.** One copy-pasteable
  headless sequence — install, the three setups fully flag-driven, connect,
  `fleet doctor` clean — runs in the test suite exactly as written, so a
  documented command that drifts from the CLI fails CI as broken onboarding.
  `fleet setup repo --help` now lists its prompt flags (`--repo`, `--image`,
  `--setup-command`, `--pickup`, `--sync`, `--env-vars`, `--cli`) the way
  `setup infra`'s always did.

### Upgrade notes

- None that touch your deployment: no schema, infra or image changes. A 0.3.2
  deployment works with this CLI unchanged — and for the first time, this CLI
  installed from npm can run `fleet upgrade` to move that deployment forward.

### Breaking changes

None.

### All merged PRs

- #264: #263: The chain offers infra an npm install cannot stand up — and no longer needs to refuse
- #266: #265: First contact fails at step two: doctor rejects the no-op gate setup just wrote
- #267: cli-client's restart test escapes its temp home and hangs on operator machines
- #268: #239: An npm-installed CLI cannot upgrade or skew-check a deployment — #183 landed and the code still waits for it
- #269: #184: Make setup agent friendly

## 0.3.2 — 2026-09-08

The release where onboarding stops lying anywhere: the infra interview joins
the screen the repo interview got, doctor tells the truth about a daemon
nothing can reach, and the last two places still teaching dead commands — the
README and a Dockerfile comment — were caught by the same medicine that cured
the skill: execute what the docs say, pin what the execution proved.

### What's new for you

- **`fleet setup infra` joins the graphical onboarding.** Saying yes at the
  chain's offer opens the same screen the repo interview uses: the deployment's
  shape up top, the questions at the prompt row with their hints dimmed above —
  then the screen closes *before* terraform, because init/plan/apply output
  belongs in scrollback where you can read it, and the apply confirm sits under
  the plan it approves, naming what you're consenting to: `apply this plan to
  aws as "fleet"?`. The composition fits an 80×30 terminal; anything smaller
  (or piped, or CI) gets the plain flow, unchanged.
- **Its questions answer themselves.** `name this deployment [fleet]:` with
  *"every resource it creates is tagged with it, and teardown targets it"*
  above — Enter works on first contact, and on a rerun the default is **the
  name already deployed here**, because a review of this change proved a
  static default would silently rename (and force-recreate) a live deployment
  on a flagless rerun. `AWS region to deploy into` and `existing VPC to reuse`
  (*Enter creates a dedicated VPC*) got the same treatment. A bare
  `fleet setup infra --yes` on first contact now stands up `fleet` instead of
  refusing for a missing `--name`.
- **`fleet doctor` names the daemon and means it.** It prints the address this
  checkout resolves and probes it. The lying case is fixed: a captured
  deployment whose `fleet-config.json` carries no `daemon_url` silently fell
  back to the local socket and doctor said "clean" — now it's a finding naming
  the fallback and the recapture fix. A repo with no deployment yet stays
  clean: that's a note, not a defect, because the setup chain sends first
  contacts to doctor.
- **The README teaches the shipped dispatch.** `fleet delegate 42` (refused
  since 0.3.0) is gone from the front page; examples carry `--prompt` where
  the contract requires it, and the drift gate that guards the installed skill
  now reads the README too — including the shape rule that an identity target
  without `--prompt` is a dead command.
- The runner image's harness-package mapping is pinned data
  (`fixtures/harness-packages.json`): the Dockerfile's install arms, its own
  comment (which still named the nonexistent `opencode` package after the arm
  was fixed), and the manifest's `harness.cli` enum must all agree, so every
  harness the manifest accepts provably has an install arm.

### Upgrade notes

- None that touch your deployment: no schema, infra or image-content changes —
  the one `images/` diff is the corrected comment. A 0.3.1 deployment works
  with this CLI unchanged.
- If a script relied on `fleet setup infra --yes` *failing* without `--name`,
  it now succeeds and applies as `fleet` — pass `--name` to pin one.

### Breaking changes

None.

### All merged PRs

- #257: #256: setup infra joins the graphical onboarding, and its questions answer themselves
- #259: #258: README stops teaching the dispatch the CLI refuses
- #260: #228: Runner image cannot build for opencode: the npm package name is wrong
- #261: #253: fleet doctor reports clean over an unreachable socket daemon

## 0.3.1 — 2026-09-08

Two fixes to first contact, both from watching a real operator meet 0.3.0: the
three setups now form one journey, and the skill Fleet installs into your
coding agent stops teaching commands the CLI refuses.

### What's new for you

- **The setups are connected.** Each one ends by offering the first missing
  piece: `fleet setup repo` with no reachable deployment asks whether to stand
  one up — Enter is a no, and nothing ever falls into terraform by default —
  and a finished `fleet setup infra` offers to install the skill (Enter is a
  yes; it is one reversible file copy, and only offered when a coding agent is
  actually on the machine). Bare `fleet setup` prints where the repo stands —
  manifest, deployment, agent skill — and on a terminal walks you into the
  first missing piece. `--yes`, `--destroy` and `--rebuild-images` never
  chain: a scripted run gets no offers.
- **The "Next" block stops pointing at dead ends.** With no reachable
  deployment it names `fleet setup infra` instead of recommending a
  `fleet delegate` no daemon would receive — and "reachable" is judged by the
  same rule dispatch uses, so a half-captured config that `delegate` would
  skip no longer counts.
- **The installed skill teaches the contract the CLI actually has.** 0.3.0's
  copy predated the delegate rework: it taught `fleet delegate 42` (now
  refused — an issue or PR target needs `--prompt`) and an artifacts `-o`
  flag that never existed (`--out`). Both were found by executing every
  command the skill documents; a new gate now holds every `fleet` line in the
  skill against `fleet --help`, so this class of drift cannot ship again.

### Upgrade notes

- **Re-run `fleet setup harness` wherever the skill is installed.** The 0.3.0
  copy teaches a dispatch the CLI refuses and a flag it doesn't have. An
  unedited install refreshes in place; a hand-edited copy is refused and takes
  `--force` (your edits are not recoverable after it — read the refusal).
- Nothing else: no schema, infra or image changes — a 0.3.0 deployment works
  with this CLI unchanged.

### Breaking changes

None.

### All merged PRs

- #251: #250: Chain the three setups by offer, never by fall-through
- #254: #252: The installed skill teaches a dead delegate contract and a flag that doesn't exist

## 0.3.0 — 2026-09-07

One pull request, two halves of the same idea: Fleet stops speaking for you.
Dispatch runs exactly what you typed, and setup asks its questions in your
words instead of Fleet's.

### What's new for you

- **`fleet delegate` runs what you type, on whatever CLI you use.**
  `fleet delegate "/dev-sprint"` runs `/dev-sprint`;
  `fleet delegate "use the feature-spec skill"` runs that sentence;
  `fleet delegate 69 --prompt "/dev-work #69"` runs it with the issue's gate
  and `Closes #69`. Fleet composes no instruction of its own any more —
  `harness.commands` has no reader left — and a bare `fleet delegate 69` fails
  at the CLI with the line to type, before a container boots. The launch line
  lands correctly on all four supported CLIs (claude-code, codex, opencode,
  omp), with `harness.model` passed to the ones that take one; three of those
  four previously produced no launch plan at all.
- **`fleet setup repo` first contact is a moment.** On a real terminal it opens
  a full-screen hero — the dart bobbing over the wordmark — with what the repo
  says about itself in plain words, one Enter from a written manifest.
  Declining re-asks the plan one row at a time in the same words, on the same
  screen, each hint naming what Fleet does with the answer ("if this command
  fails, the job stops before the agent runs and spends anything"). The receipt
  survives in scrollback, citing the repo file behind every row you didn't
  retype. Pipes, CI, NO_COLOR and small terminals get the plain flow, and no
  escape code ever reaches a pipe.
- **A real terminal gets a real line editor.** Arrow keys edit the answer
  instead of leaking `^[[C` into it, up/down are inert instead of recalling
  the previous answer, and Ctrl-C restores the screen and exits clean — while
  still aborting a running terraform step mid-apply.
- **Detection stopped guessing.** A devcontainer outranks every inference; bun
  repos get `oven/bun:1`; `.tool-versions` and Dockerfile `FROM` join the
  version pins; pnpm and yarn go through corepack, so setup stops dying at
  `pnpm: not found` before any model spend; the pickup gate defaults to a
  check that passes instead of a file that isn't there; and a rerun stops
  clobbering a hand-edited `harness.cli`.
- **Credential questions follow the repo, not your laptop.** Setup asks which
  coding agent drives jobs (default cited from the repo's own harness files),
  and only that agent's credential story follows: a claude-code repo walks
  `claude setup-token` when no shippable credential exists, and a Codex login
  is offered only to a codex-driven repo — never because a login happens to
  sit in your home directory.
- **`infra/aws/tunnel.sh`** keeps the SSM port-forward to the daemon alive: a
  keepalive loop stops Session Manager's idle timeout, and the outer loop
  re-resolves the ECS task and reconnects after a deploy replaces it.

### Upgrade notes

- **Run `fleet upgrade` before dispatching with 0.3.0.** The work order grew an
  optional `prompt` field, and a deployed daemon validates orders against the
  schema baked into its own image — a v0.2.x deployment rejects any order
  carrying one. `fleet upgrade` converges the daemon and rebuilds the runner
  images, whose launch-line composition also moved in this release.
- **`harness.commands` in your manifest is deprecated and unread.** It still
  validates for this one release train so existing manifests don't fail;
  delete the block (or re-run `fleet setup repo`). The follow-up release
  removes it together with the `--mode`/`report` migration window.
- `infra/` gained only `tunnel.sh`, a helper terraform doesn't read — no
  `terraform apply` needed for this release.

### Breaking changes

- **`fleet delegate <issue>` with no `--prompt` no longer dispatches.** A
  number says which work, never what to do about it; the error names the exact
  line to type. Anything scripted around the manifest's `commands[0]` must now
  pass `--prompt`.
- **The new CLI cannot dispatch prompts to an old deployment** — the daemon
  rejects the unknown field at intake (see upgrade notes). Upgrade first.

### All merged PRs

- #247: #240: delegate runs what you type — and setup is worth running (#217)

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
