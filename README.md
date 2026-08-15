# Fleet

Fleet runs coding-agent jobs in containers on your own AWS account. You dispatch a ticket, keep working (or close your laptop), and the job runs remotely, asks you when it's stuck, and finishes as a pull request.

It's built for repos that already use an agent harness: Claude Code with slash commands, agent definitions, and rules. If you run something like `/dev-sprint TICKET-123` locally today, Fleet runs that same command on cloud compute instead. Same repo, same config, same behavior, without your machine in the loop.

Everything runs in your account with your credentials. There is no hosted service and no third-party control plane.

Context lives in this repo: [docs/architecture.md](docs/architecture.md) (how it works), [docs/decisions.md](docs/decisions.md) (why it works that way), [docs/roadmap.md](docs/roadmap.md) (phases and exit criteria). Work is tracked as GitHub issues, which reference those docs.

## How it works

1. Your repo describes its environment in `.fleet/manifest.json`: base image or devcontainer, setup script, which gitignored config files to copy in, which env vars and services the job needs, which commands can run, and which agent reviews the work.
2. A Terraform module sets up the infrastructure in your AWS account: an ECS cluster that scales from zero, a small daemon that tracks jobs, and no publicly reachable ports.
3. `fleet delegate TICKET-123` builds the sandbox, runs your repo's readiness gate (a script you own; if it fails, the job stops before any model spend), then runs the command headless and streams progress events back.
4. When the agent hits a question it can't answer on its own, the job pauses and you get a notification. You answer with `fleet answer`, and the job resumes. Agents cannot answer their own questions; the answer API is only reachable with your credentials.
5. The job ends as a pull request. A human merges it. Fleet never merges and never deploys.

## Status

Early. Only the contracts exist: the schemas below and their tests. The CLI, daemon, and Terraform module are not written yet. You cannot delegate anything today.

## What's in this repo

| File | What it defines |
|---|---|
| `schemas/manifest.schema.json` | The environment description a repo checks in |
| `schemas/work-order.schema.json` | What a dispatch says: job type, scope, permissions, finish line |
| `schemas/events.schema.json` | The progress events a running job emits |
| `schemas/decision-file.schema.json` | How an agent asks a human a question from inside the sandbox |
| `schemas/job-states.json` | The job lifecycle: queued, running, blocked, done, cancelled |

Supporting files:

- `examples/` – a minimal manifest, a full-featured one, and one example work order per job type
- `presets/modes.json` – default permissions and finish line for each of the six job types
- `fixtures/synthetic-history.json` – invented run history used by the round-trip tests
- `src/history-events.mjs` – converts run-history records to event streams and back, losslessly

Rules the schemas enforce, because prose rules get ignored:

- Every command must name a reviewer agent. No reviewer, no job.
- Jobs can never be granted merge or deploy permission.
- A question to a human must offer at least two real options, with exactly one recommended.
- A job's final report must name exactly one next action.
- The test suite scans the whole repo for client- or user-specific content and fails if it finds any. This is a generic tool and stays that way.

## Running the tests

```
npm install
npm test
```

To check compatibility against a real run-history file, point `FLEET_DEMO_HISTORY` at it:

```
FLEET_DEMO_HISTORY=path/to/history.json npm test
```

## Roadmap

- **Phase 1:** Terraform module, daemon, ECS provider, runner, and the CLI (`init`, `doctor`, `delegate`, `status`, `logs`, `attach`, `answer`, `cancel`). Done means: a real ticket goes from `fleet delegate` to a merge-ready PR with the laptop closed mid-job.
- **Phase 2:** credential broker issuing short-lived scoped tokens, network egress restricted to an allowlist, and a kill switch (`fleet stop`) with a drill that proves it works.
- **Phase 3:** a web UI for watching jobs and answering their questions.
- **Later:** managed sandbox providers, parallel batches, overnight runs.
