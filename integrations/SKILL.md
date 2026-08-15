---
name: fleet-delegate
description: Delegate a ticket or task to Fleet — sandboxed remote execution in the project's own cloud account. Use when the user asks to "delegate", "run remotely", "send to fleet", "run this in the background/cloud", or wants long-running agent work off their machine. Requires a repo with .fleet/manifest.json and a reachable Fleet daemon.
---

# Delegating work to Fleet

Fleet runs this repo's own harness commands in a remote container and reports back. You (the local agent) are the interface: you dispatch, you hold the watch, you relay questions to the human, you report the result. Fleet is not an agent and will never answer questions on the human's behalf — that is your job to route, and the human's job to decide.

## Preconditions

1. `.fleet/manifest.json` exists (if not: run `fleet init`, then help the human fill in the placeholders — the setup script and pickup gate are theirs to own).
2. `fleet lint` passes.
3. The daemon is reachable (`fleet status` responds). If not, stop and tell the human; do not try to stand up infrastructure unasked.

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

1. Present it to the human using your question mechanism (ask tool, structured options — whatever your harness provides). Reproduce the options verbatim, mark the recommended one, allow free text.
2. NEVER answer yourself, never pick the recommendation silently, never let a timeout choose.
3. Post the human's choice:

```
fleet answer <jobId> --option <id> [--text "supplement"]
fleet answer <jobId> --text "free text answer"
```

4. Resume watching.

## When the job settles

Report the settle event's status-first report to the human, leading with its `status` line, the rung reached vs the target, and its one `next_action` — verbatim, not paraphrased. If the job cancelled (gate failure, wall-clock), say so plainly and quote the reason.

## Never

- Never run `fleet cancel` without an explicit instruction.
- Never modify `.fleet/manifest.json` to bypass a failing gate — gates fail for reasons; relay the failure.
- Never treat a parked or stale job as failed; it is waiting for the human, and says so in `fleet status`.
