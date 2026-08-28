# Fleet on GCP

One self-contained Terraform unit (docs/decisions.md#d12): jobs run as **Cloud Run Job executions**, the daemon runs on a **micro VM with a separate data disk**, and operator access is an **IAP tunnel**. No public ingress anywhere: the VM has no external IP, the only firewall sources are Google's published IAP range and the runner jobs' own network tag, and Cloud Run jobs expose nothing inbound.

What the unit creates:

- **`google_cloud_run_v2_job`** — the task-definition analog. It pins the runner image (`<runner_repository_url>:runner`) and the resource tier (default 4 vCPU / 16 GiB, the #191 tier; Cloud Run's ceiling is 8 vCPU / 32 GiB). The daemon launches a job with `gcloud run jobs execute --async`; per-job env rides `--update-env-vars`, the manifest's `wall_clock` rides `--task-timeout`. `max_retries = 0` — the daemon owns retry. Billing is per-second while an execution runs; scale-to-zero is inherent, so there is no warm-floor machinery and no Spot tier (Cloud Run has neither; see docs/decisions.md#d18).
- **The daemon VM** — default `e2-small` (~$12/mo; `e2-micro` is the free-tier frugal option in us-west1/us-central1/us-east1 for single-operator use, set `daemon_machine_type`). cloud-init installs Node 24, the gcloud CLI, and `ownfleet` from npm at the exact `fleet_version` you pass, then runs the daemon under systemd as a non-root user. **There is no GCP daemon image** — the daemon is an npm install, and the deprecated Compute Engine container-startup path (konlet / `create-with-container`) is deliberately not used.
- **A separate data disk** mounted as `FLEET_HOME` — real POSIX for the append-heavy journals (GCS FUSE and Filestore were both disqualified; see the issue record). The boot disk is replaceable; the data disk and the **reserved static internal address** both outlive the instance, which is what lets `fleet upgrade` replace the VM under in-flight jobs — every launched job's `FLEET_DAEMON_URL` points at that address.
- **Cloud NAT** (scoped to the one subnetwork) — the VM's only egress path, since it has no external IP. Jobs never use it: their VPC egress is `PRIVATE_RANGES_ONLY`, so their internet traffic (git, npm, the harness API) takes Cloud Run's own path.
- **Artifact Registry** repository for the runner image, **Secret Manager** secret the daemon publishes the operator token into at boot (#188), and the IAM split: the daemon's service account can execute/cancel/list executions of the one job, act as the runner's service account, add token versions, and write logs; the runner's service account can write logs and nothing else. The VM carries the `cloud-platform` access scope — GCE's legacy default scopes silently block Secret Manager regardless of IAM.

## Bring-up

`fleet setup infra --provider gcp` is the supported path: it interviews (name, project, region, optional network+subnetwork, daemon version), generates `.fleet/infra/gcp/main.tf` against this unit at a pinned ref, plans, applies on an explicit yes, and captures `fleet_config`.

By hand, from a checkout:

```sh
terraform -chdir=infra/gcp/examples/basic init
terraform -chdir=infra/gcp/examples/basic apply -var project=<your-project> -var region=<region>

# The capture every other command resolves the deployment from:
mkdir -p .fleet/infra/gcp
terraform -chdir=<fleet-checkout>/infra/gcp/examples/basic output -json fleet_config \
  > .fleet/infra/gcp/fleet-config.json
```

Then push the runner image (the in-account Cloud Build path is the #185 follow-up; until it lands this is a checkout + Docker step):

```sh
gcloud auth configure-docker <region>-docker.pkg.dev
docker build -f images/runner/Dockerfile -t "$(terraform -chdir=infra/gcp/examples/basic output -raw runner_repository_url):runner" .
docker push "$(terraform -chdir=infra/gcp/examples/basic output -raw runner_repository_url):runner"
```

Notes:

- The unit enables the APIs it needs (`run`, `compute`, `artifactregistry`, `secretmanager`, `iap`, `iam`) with `disable_on_destroy = false`. On a **fresh project** the subnetwork data source can race the compute API's first enablement — if the first apply fails there, run it again (or `gcloud services enable compute.googleapis.com` first).
- On the **default network**, the unit uses the region's `default` subnetwork. On a custom network, pass `network` and a `subnetwork` **in the deployment region** — Direct VPC egress requires a region-matched subnet, and the unit looks the name up in that region so a wrong-region value fails before the first job does.
- The default network's pre-created rules (`default-allow-ssh` etc.) target instances with reachable addresses; the daemon VM has no external IP, so nothing here is internet-reachable regardless.

## Operator access

`fleet connect` opens and supervises the IAP tunnel from `fleet_config` (`project`, `daemon_instance`, `daemon_zone`, `daemon_port`). The manual fallback is the `connect_hint` output. Operators need `roles/iap.tunnelResourceAccessor` on the VM and read access on the token secret — pass `operator_members` to have the unit grant both, or rely on project-level roles you already hold.

Break-glass into the VM itself (no external IP, so plain SSH cannot reach it):

```sh
gcloud compute ssh <name>-daemon --zone <zone> --tunnel-through-iap
journalctl -u fleet-daemon -f     # the daemon's boot lines and errors
```

## Upgrading

`fleet upgrade` re-pins and re-applies the unit; moving `fleet_version` replaces the VM. In-flight jobs survive because the reserved internal address and the data disk both outlive the instance — parked-job answers during the replacement window wait, the same class of gap as the AWS daemon roll (docs/decisions.md#d18). cloud-init's data-disk format step is `blkid`-guarded, so a replacement VM mounts the existing `FLEET_HOME` instead of wiping it.

## The plan smoke

Every infra change runs it by hand (terraform >= 1.7; no credentials — `tests/plan.tftest.hcl` mocks the provider):

```sh
terraform -chdir=infra/gcp init -backend=false
terraform -chdir=infra/gcp test
```

Set `TF_PLUGIN_CACHE_DIR` first — see `infra/aws/README.md#shared-provider-plugin-cache`; the Google provider is another few hundred MB per uncached `.terraform/`. API-only constraints no plan reaches are pinned in `test/infra-gcp.test.ts`.
