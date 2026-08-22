---
name: fleet-delegate
description: Delegate a ticket or task to Fleet — sandboxed remote execution in the project's own cloud account. Use when the user asks to "delegate", "run remotely", "send to fleet", "run this in the background/cloud", or wants long-running agent work off their machine. Requires a repo with .fleet/manifest.json and a reachable Fleet daemon.
---

# Delegating work to Fleet

Fleet runs this repo's own harness commands in a remote container and reports back. You (the local agent) are the interface: you dispatch, you hold the watch, you relay questions to the human, you report the result. Fleet is not an agent and will never answer questions on the human's behalf — that is your job to route, and the human's job to decide.

## Preconditions

1. `.fleet/manifest.json` exists. If not, the human's command is `fleet setup repo` — an interview that reads its defaults out of the checkout, so offer it rather than answering for them; the setup script and pickup gate are theirs to own. `fleet init` is the non-interactive alias and writes placeholders you then help them fill in (that is the path in CI, or when you are asked to draft the manifest yourself).
2. `fleet lint` passes.
3. The daemon is reachable (`fleet status` responds). If it is not, run `fleet doctor` and relay what it says about the tunnel: a cloud daemon is reached through a port-forward, and a dead session is the usual cause. Reopening it is `fleet connect` (foreground) or `fleet connect --detach` — offer that to the human rather than running it unasked. Never stand up infrastructure: if there is no deployment at all, say so and point at `fleet setup infra`, which is the human's wizard and applies only on their explicit yes.

### Which daemon you are talking to

Every `fleet` command resolves one address, highest priority first:

1. `FLEET_DAEMON_URL` in the environment — an explicit override.
2. `.fleet/infra/<provider>/fleet-config.json` under the current directory — its `daemon_url` field, captured by `fleet setup infra`. The first parseable capture carrying a usable `daemon_url` wins.
3. The unix socket at `$FLEET_HOME/daemon.sock` (default `~/.fleet/daemon.sock`) — a daemon running on this machine.

Two consequences worth knowing before you debug anything: the resolution reads the **current working directory**, so running `fleet` from outside the repo can silently mean a different daemon; and a cloud deployment that resolves to the socket has a capture with no `daemon_url`, which is a missing field, not a dead daemon. `fleet doctor` names the address it resolved — read that before concluding anything about reachability, and relay it rather than guessing.

## Dispatch

```
fleet delegate <target> [--mode <assess|implement|investigate|followthrough|review|compare>] [--finish <rung>]
```

- Default mode is `implement`. Use `assess` first when readiness is uncertain — it is read-only and cheap.
- The command prints a job id. Report it to the human immediately with one line about what was dispatched.
- Sync files and env vars are read from the current shell and repo; if `delegate` fails naming a missing var or file, relay that verbatim.

## Hold the watch

Poll rather than block, so you stay responsive:

```
fleet status <jobId>     # state: queued | running | blocked | done | cancelled
fleet logs <jobId> --after <lastSeq>
```

Check every 30–60 seconds while the conversation is otherwise idle. Do not narrate routine progress; surface only state changes.

If your harness supports holding an interactive stream, `fleet attach <jobId>` follows events live. Watching is a view, never a lifeline: if you disconnect, the job continues, parks when blocked too long, and any later session can pick it up.

## When the job blocks

A `decision` event carries: a question, two or more options with stable ids, exactly one recommended, and a note on why the agent cannot decide alone.

1. Present it to the human through whatever question mechanism your harness gives you. The decision schema is shaped to map one-to-one onto it: the `question` is the prompt, each option's `label` is a choice, its `id` is what you post back. Reproduce the options verbatim, mark the recommended one as recommended, and leave free text open — a human whose answer is none of the options must still be able to give it. If your harness has no structured question tool, print the question with the options as a numbered list and end your turn; waiting is the mechanism.
2. NEVER answer yourself, never pick the recommendation silently, never let a timeout choose. This is the one thing Fleet's whole design exists to prevent, and the sandbox cannot reach the answer API to do it for you.
3. Post the human's choice:

```
fleet answer <jobId> --option <id> [--text "supplement"]
fleet answer <jobId> --text "free text answer"
```

4. Resume watching.

## When the job settles

Report the settle event's status-first report to the human, leading with its `status` line, the rung reached vs the target, and its one `next_action` — verbatim, not paraphrased. If the job cancelled (gate failure, wall-clock, stall), say so plainly and quote the reason.

If the settle's `produced[]` contains entries with `type: "file"`, the job delivered artifacts. List them to the human and offer to fetch them:

```
fleet artifacts <jobId>               # list artifact paths and sizes
fleet artifacts <jobId> get <path>    # stream artifact to stdout
fleet artifacts <jobId> get <path> -o <dir>  # save to dir/<filename>
```

## Never

- Never run `fleet cancel` without an explicit instruction.
- Never modify `.fleet/manifest.json` to bypass a failing gate — gates fail for reasons; relay the failure.
- Never treat a parked or stale job as failed; it is waiting for the human, and says so in `fleet status`.
