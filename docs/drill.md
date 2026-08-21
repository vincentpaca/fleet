# The operator-independence drill

The phase-1 exit criterion ([roadmap](roadmap.md#phase-1--first-real-delegated-run-in-progress)), executed as a repeatable acceptance drill. It proves the one claim everything else rests on: **no local process is load-bearing**. A job blocks on a real decision, the dispatching machine disappears, the job parks to zero cost, a *different* machine answers, the job re-enters and delivers a PR, and the cluster returns to zero.

Run it against a live deployment after any change to the daemon, the runner lifecycle, or an infra unit.

## Preconditions

- A deployed infra unit with current images (`images/build.sh --redeploy-daemon`).
- A ticket whose implementation will genuinely block on a human decision — one with open design questions in its body works reliably: the dev playbook forbids guessing through a real fork, so the agent must raise a decision file.
- **Machine A**: the dispatching laptop (repo checkout, cloud credentials).
- **Machine B**: any other machine with credentials for the same account — a second laptop with a checkout, or the cloud console's shell (for AWS, CloudShell ships the Session Manager plugin).

## The drill

1. **Dispatch from machine A.** `fleet connect` (or bare `fleet`), then `fleet delegate <ticket>`; record the job id.
   *Check:* the job reaches `running`; worker capacity scales from zero (`aws autoscaling describe-auto-scaling-groups` shows desired > 0).
2. **Wait for the block.**
   *Check:* state `blocked`; the decision card renders with the schema's question and options.
3. **Shut machine A.** Close the lid. Do not soften this step — no cockpit, no tunnel, no watcher may survive it. Keep it shut past `limits.block_hot` (default 30m) so the job parks.
4. **Verify the park from machine B** — nothing from A can be involved:
   *Check:* the event log shows the WIP push and park; `aws ecs list-tasks` lists only the daemon task; the job branch on origin carries the WIP commit.
5. **Answer from machine B.**
   - Checkout path: recreate the deployment pointer, connect, answer:
     ```sh
     mkdir -p .fleet/infra/aws
     aws ssm get-parameter --name /<name>/fleet-config --query Parameter.Value --output text \
       > .fleet/infra/aws/fleet-config.json
     # add "daemon_url": "http://127.0.0.1:1<port>" (your local port choice) —
     # and, until the deployed unit publishes the daemon-access fields,
     # "daemon_service", "daemon_container_name", "daemon_port".
     fleet connect   # in its own tab
     fleet answer <job> --option <id>
     ```
   - Console-shell path (no checkout): port-forward in one tab, answer with curl in another:
     ```sh
     aws ssm start-session --target "ecs:<cluster>_<task-id>_<runtime-id>" \
       --document-name AWS-StartPortForwardingSessionToRemoteHost \
       --parameters '{"host":["localhost"],"portNumber":["9000"],"localPortNumber":["19000"]}'
     curl -X POST http://127.0.0.1:19000/jobs/<job>/answer \
       -H 'content-type: application/json' -d '{"option":"<id>"}'
     ```
   *Check:* the event log records the answer; the daemon relaunches the job — state `running`, a fresh task id, capacity scaling out again if it had drained.
6. **Let it finish.** Re-entry checks out the job branch (WIP intact) and re-invokes the harness with the answer injected.
   *Check:* settle event, state `done`, a draft PR carrying the branch's work.
7. **Zero.**
   *Check:* worker capacity back at 0 after the idle window (capacity-provider scale-in, typically 15–20m).
8. **Replay and archive.** `fleet logs <job>` from either machine replays the whole transcript from the daemon's event log. Paste it on the tracking issue.

## What this proves — and what it doesn't

Proves: dispatch, scale-from-zero, a real block, park (a waiting job costs nothing), operator mobility (the answer came from a different machine over its own credential path), re-entry, PR delivery, scale-in, replay — with no local liveness dependency anywhere in the chain.

Does not prove: credential scoping or egress control. Sandboxes still carry the operator's own credentials with open egress (roadmap phase 2); single-operator use only until that lands.

## Superseded criteria

The original acceptance included "budget alarm verified to exist". Billing products were removed from infra units on 2026-08-19 (`decisions.md#d12`, amendment): spend is bounded structurally — scale to zero, the capacity cap, per-job wall-clock. Teardown: `fleet setup infra --destroy` removes everything the unit created.
