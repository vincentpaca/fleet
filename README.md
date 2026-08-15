# Fleet

**Fleet is not a service you connect to — it is infrastructure you stand up, in your own account, for your project.**

Bring a repo with a minimal harness (one headless-runnable command + a critic), an AWS account, and your keys. `terraform apply` creates the substrate — an ECS cluster that scales from zero, a small always-on daemon, zero open ports. Your repo carries the contract (`.fleet/manifest.json`). Then `fleet delegate TICKET-1` runs your existing slash command in a disposable container that behaves like your machine — same capability where the manifest declares it, tighter permissions everywhere else — pings you on blockers, hands back a merge-ready PR, and scales back to zero.

Both planes are yours: the compute **and** the control plane. Hosted coding agents run their infra; self-hosted runners keep the vendor's control plane; BYO-cloud platforms keep their platform. Fleet keeps no vendor in the loop, and the contract lives in the repo, so it ports across substrates.

## Phase 0 — contracts (current state)

Five versioned contracts and their exit tests. Phase 1's code must obey these; the tests make disobeying them loud.

| Contract | File | What it pins |
|---|---|---|
| Manifest (environment) | `schemas/manifest.schema.json` | What a sandbox needs to be your environment: setup (devcontainer preferred), workspace/sync, env names (never values), services + scopes, harness + mandatory critic, mandatory pickup gate, limits |
| Work order (dispatch) | `schemas/work-order.schema.json` | What a dispatch says: mode (assess/implement/investigate/followthrough/review/compare), target, truth, authority as capabilities (merge/deploy never grantable in v1), scope fences, finish rung on the 13-rung evidence ladder |
| Events (wire) | `schemas/events.schema.json` | What a runner emits: state/phase/progress/pair/agent/think/log/decision/answer/settle. The required core (state, phase, decision, settle) is CLI-independent |
| Decision file (harness-side) | `schemas/decision-file.schema.json` | How a command raises a human decision from inside the sandbox: write `.fleet/out/decision.json` (question + ≥2 options with stable ids, exactly one recommended — schema-enforced) and end the turn; the runner wraps it into a `decision` event and blocks the job |
| Job states | `schemas/job-states.json` | queued → running → blocked ⇄ running → done (+ cancelled); parked/stale as blocked markers; wall-clock pauses while blocked |

Supporting artifacts — all generic; this repo carries no data from any real deployment:

- `examples/greenfield.manifest.json` — the minimal valid manifest; what `fleet init` scaffolds for a new project (schema-minimality is tested).
- `examples/full.manifest.json` — a full-featured manifest exercising every field.
- `examples/work-orders.json` — one reference work order per mode, collectively exercising every contract field.
- `presets/modes.json` — the six dispatch modes with default authority + finish rung.
- `fixtures/synthetic-history.json` — synthetic run history covering every outcome shape variant.
- `src/history-events.mjs` — lossless converter between run-history records and the event stream. Compatibility with a real deployment's history is verified by pointing `FLEET_DEMO_HISTORY` at its history file; that data never enters this repo.
- `test/sanitized.test.mjs` — the sanitization gate: the tree is scanned for client/operator-specific content on every test run.

## Verify

```
npm install
npm test
```

## Phase 1 — first real delegated run (next)

- `infra/terraform/` — one `terraform apply`: VPC, ECS cluster + capacity provider (ASG min 0), ECR, IAM, the daemon service, SSM-only access, budget alarm.
- `fleet` CLI: `init` (scaffold a manifest; `--existing` for brownfield), `doctor` (build a sandbox, diff it against your local checkout before spending model tokens), `delegate`, `status`, `logs`, `attach`, `answer`, `cancel`.
- Runner: pickup gate → harness CLI headless → structured stream → events → PR → settle, with the evidence rung verified by the daemon, never self-certified.

Exit: one real ticket goes delegate → blocker → laptop shut mid-job → answered from another machine → merge-ready PR → cluster back at zero.
