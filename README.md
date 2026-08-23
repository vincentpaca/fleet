# Fleet

[![Codacy Badge](https://app.codacy.com/project/badge/Grade/771617780d6943a18b5acc2d0125536c)](https://app.codacy.com/gh/vincentpaca/fleet/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)
[![Codacy Badge](https://app.codacy.com/project/badge/Coverage/771617780d6943a18b5acc2d0125536c)](https://app.codacy.com/gh/vincentpaca/fleet/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_coverage)

**Fleet lets you delegate the harness you already use, detach from it, and safely pick it up anywhere.**

If you run something like `/dev-sprint TICKET-123` in Claude Code locally today, Fleet runs that same command on compute you control — your Docker, your cloud account — and hands you back a pull request. You dispatch, close the laptop, answer a question from another machine if the agent gets stuck, and review the result. Same repo, same config, same behavior, without your machine in the loop.

Everything runs in your account with your credentials. There is no hosted service and no third-party control plane.

## Install

```sh
npm install -g github:<org>/fleet
```

That is the whole install: no clone, no build step. It needs Node >= 23.6 (the CLI is TypeScript run via type stripping) and puts `fleet` on your PATH. Fleet is not on the npm registry yet — see [Status](#status).

## What Fleet owns

Fleet is a thin delegation layer. It owns exactly four things:

1. **Dispatch** — package a task and its repo-owned environment contract; refuse work that isn't ready before any model spend.
2. **Remote execution** — run the repo's existing harness on suitable compute, isolated, with only the credentials the job needs.
3. **Continuity** — survive the initiating terminal or laptop disappearing; blocked jobs park at zero cost and resume on answer.
4. **The return path** — stream honest progress, route human decisions to wherever the human is, and deliver a branch, PR, or report with evidence.

Everything else belongs to someone else: the harness owns reasoning, tools, and review behavior; the cloud provider owns compute; GitHub owns source control and CI. Fleet connects them. A proposed feature that isn't one of the four is someone else's layer.

## What Fleet refuses to become

- **Not a coding agent.** Fleet never has its own agent loop. The harness you already trust — Claude Code, Codex, OpenCode — is the agent; Fleet is the pipe. If Fleet ever competes with your harness, it has failed.
- **Not a hosted platform.** No vendor control plane, no relay that sees your code, no account with us. Regulated and paranoid environments are first-class citizens.
- **Not a workspace product or dashboard.** No cloud IDE, no workflow editor, no model picker. The CLI flow must be reliable before any UI exists, and any UI consumes the same event stream the CLI does.
- **Not a merger or deployer.** No code path can merge a PR or deploy. Humans own merges. This is schema-enforced, not a policy.
- **Not configuration you write twice.** The manifest describes the environment; the harness config stays the harness's. Fleet asking you to duplicate what your repo already encodes is a defect.

## Design commitments

- **Concepts invisible, behavior reliable.** Under the hood there is an evidence ladder, a state machine, six dispatch modes, and five schema contracts. You should experience them as: dispatch works, questions reach you, status never lies, the PR says what was verified. The contracts are the spine, not the face.
- **Truth before action.** A job that can't prove readiness doesn't start; a claim that wasn't verified doesn't ship. Reports say `PARTIAL` honestly instead of `READY` optimistically, and the daemon verifies claimed rungs mechanically where it can.
- **Prompt-level permission is not enforcement.** Every rule worth having gets a checkpoint — a schema, a gate, or a test. Until the credential broker lands (Phase 2), Fleet says plainly: sandboxes carry operator credentials, single-operator use only.
- **Humans are load-bearing, not decorative.** The pickup gate before model spend, the decision protocol mid-run, the merge at the end. Agents cannot answer their own questions — the answer API is unreachable with a job's credentials, by construction.
- **One vertical path before breadth.** One harness (Claude Code), one cloud unit proven end to end, then adapters and substrates from demand — never speculatively.

## How it works

1. Your repo describes its environment in `.fleet/manifest.json`: base image or devcontainer, setup script, which gitignored config files to copy in, which env vars and services the job needs, which commands can run, and which agent reviews the work. `fleet setup repo` writes it by interview, with the defaults read out of your checkout.
2. `fleet setup infra` stands the infrastructure up in your cloud account. It is a wizard, not a flag parade: because Fleet authors the infra shape, it asks only what the contract cannot assume — a name, a region, an optional existing VPC — shows you the plan, and applies on an explicit yes. Underneath is one self-contained Terraform module per cloud under `infra/<cloud>/`, AWS first: an ECS cluster that scales from zero, a small daemon that tracks jobs, no publicly reachable ports. `fleet setup infra --destroy` takes it back down.
3. `fleet delegate TICKET-123` builds the sandbox, runs your repo's readiness gate (a script you own; if it fails, the job stops before any model spend), then runs the command headless and streams progress events back.
4. When the agent hits a question it can't answer on its own, the job pauses — hot for a window, then parked at zero cost. You answer with `fleet answer` from any machine, and the job resumes on its existing branch.
5. The job ends as a draft pull request (or a report with downloadable artifacts, for investigation work). A human merges it. Fleet never merges and never deploys.

From a machine that has never seen Fleet, that is the whole path:

```sh
npm install -g github:<org>/fleet
fleet setup repo        # interview → .fleet/manifest.json (fleet init for the placeholder scaffold)
fleet setup infra       # interview → plan → apply → .fleet/infra/aws/fleet-config.json
<fleet-checkout>/images/build.sh --redeploy-daemon    # publish the images, start the daemon on them
fleet connect           # hold the SSM tunnel to the daemon
fleet setup harness     # install the delegate skill into your coding harness
fleet delegate TICKET-123
```

`setup infra` pins the Terraform unit at the exact ref of the Fleet checkout it runs from, which is also how the Terraform reaches you without shipping in the npm package — so run it from a checkout, or point it at one with `--module-source`. Both `setup` commands are interviews on a terminal and driveable headless: every prompt has a flag that pre-supplies it and `--yes` skips the confirmation, so CI and agents run the same code path a human does. With no terminal and a value missing, the command exits naming the flag rather than waiting for input that will never come.

## Using Fleet from your coding harness

Fleet has no UI of its own — your harness is the UI. The session you already talk to dispatches the job, holds the watch, relays a blocked job's question to you through its own ask mechanism, and reports the settle. That behaviour is one skill file, and `fleet setup harness` installs it where your harness looks for it:

```sh
fleet setup harness                      # detects what you have, asks, installs
fleet setup harness --scope project      # this checkout only, and committable
```

Then say *"delegate TICKET-123 to fleet"* in your session. It dispatches, reports the job id, polls quietly, and when the job blocks it asks **you** — the options verbatim, the recommended one marked, nothing auto-answered. Answering resumes the job; the settle report comes back status-first, with its artifacts listed if the mode produced any.

Claude Code, Codex and OpenCode all discover skills as a `<name>/SKILL.md` directory, so there is exactly one canonical file — [`integrations/SKILL.md`](integrations/SKILL.md) — and the per-harness variants are generated from it at install time. Only two things differ per harness: which directory it goes in, and how that harness asks its human. Reruns are idempotent, an edited copy is never overwritten without `--force`, and no variant is ever committed to this repo (the test suite fails a forked copy). A harness Fleet has no convention for yet is a new record in `src/cli/setup-harnesses.ts`, not new code — integration is a skill file over the CLI, permanently ([D8](docs/decisions.md)).

The live end-to-end check — a real session, a real block, a human answering — is [docs/drill.md#the-harness-drill](docs/drill.md#the-harness-drill).

Run `fleet` with no arguments and you get the cockpit: the live board on top with blocked decisions floating up, the selected job's streaming transcript below it, and a command line at the bottom to dispatch from, answer a question, or cancel — one window instead of three. It adopts the daemon tunnel if one is healthy and opens its own if not, so a dead port-forward stops being something you rebuild by hand. Closing it changes nothing about the jobs; watching is a view, never a lifeline.

## Status

Honest, per our own rules:

- **The local loop is real and dogfooded.** Fleet develops itself: tickets on this repo are delegated to Fleet, run headless, and come back as PRs — including most of the features in this README. Process and Docker providers work end to end; park/resume, wall-clock caps, artifacts, and the cockpit are all live and tested.
- **The AWS path is written but has never completed a real job.** An external review identified four concrete substrate defects (daemon reachability, capacity-provider launch, scale-to-zero vs. the daemon's own service, missing daemon image) — tracked as open issues, being fixed before the first live run. The Phase-1 exit scenario will land as a repeatable acceptance test, not a demo.
- **Not on the npm registry yet** — deliberately, until the cloud path is exercised for real. The documented install is straight from the repo (`npm install -g github:<org>/fleet`), which ships exactly what a registry publish would (`test/packaging.test.ts` and `test/packaging-install.test.ts` gate it); the registry name is a later call.

## Using Fleet vs. building Fleet

Users consume three things: the npm package (CLI, daemon, runner, schemas), a Terraform unit by git source (`github.com/<org>/fleet//infra/aws`), and a skill file from `integrations/` for their coding harness — installed by `fleet setup harness`, never copied by hand. Everything else in this repo — `AGENTS.md`, `agents/`, `.claude/`, `.fleet/`, `test/` — is the harness for building Fleet itself and never ships; the boundary is the package manifest's `files` allowlist, enforced by `test/packaging.test.ts`.

## Working on this repo

Start with [AGENTS.md](AGENTS.md) — build/test mechanics, the invariants that break if you're not looking, the delivery standard for commits and PRs. The deeper context: [docs/architecture.md](docs/architecture.md) (how it works), [docs/decisions.md](docs/decisions.md) (why it works that way — settled calls are reopened with a human, not relitigated in code), [docs/roadmap.md](docs/roadmap.md) (phases and exit criteria). Work is tracked as GitHub issues, which reference those docs and must carry acceptance criteria before the pickup gate lets anyone — human or agent — start them.

```sh
npm install
npm test
```

Rules the schemas enforce, because prose rules get ignored: every command names a reviewer; jobs can never hold merge or deploy permission; a question to a human offers real options with exactly one recommended; a final report names exactly one next action; and the suite scans the whole tree for client- or operator-specific content — this is a generic tool and stays that way.

## License

Fleet is **source-available** under the [PolyForm Shield License 1.0.0](LICENSE.md): use it, modify it, self-host it — commercially included — and contribute back. The one thing the license forbids is offering a product or service that competes with Fleet. It is not an OSI open-source license, deliberately; the same terms protect [AutoGPT's platform](https://github.com/Significant-Gravitas/AutoGPT) and [Micro](https://m3o.org/company/licensing.html).

Required Notice: Copyright © 2026 the Fleet maintainers (`github.com/<org>/fleet`)
