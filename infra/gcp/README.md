# Fleet on GCP

One self-contained Terraform unit (docs/decisions.md#d12): jobs run as **Cloud Run Job executions**, the daemon runs on a **micro VM with a separate data disk**, and operator access is an **IAP tunnel**. No public ingress anywhere: the VM has no external IP, the only firewall sources are Google's published IAP range and the runner jobs' own network tag, and Cloud Run jobs expose nothing inbound.

What the unit creates:

- **`google_cloud_run_v2_job`** — the task-definition analog. It pins the runner image (`<runner_repository_url>:runner`) and the resource tier (default 4 vCPU / 16 GiB, the #191 tier; Cloud Run's ceiling is 8 vCPU / 32 GiB). The daemon launches a job with `gcloud run jobs execute --async`; per-job env rides `--update-env-vars`, the manifest's `wall_clock` rides `--task-timeout`. `max_retries = 0` — the daemon owns retry. Billing is per-second while an execution runs; scale-to-zero is inherent, so there is no warm-floor machinery and no Spot tier (Cloud Run has neither; see docs/decisions.md#d18).
- **The daemon VM** — default `e2-small` (~$12/mo; `e2-micro` is the free-tier frugal option in us-west1/us-central1/us-east1 for single-operator use, set `daemon_machine_type`). cloud-init installs Node 24, the gcloud CLI, and `ownfleet` from npm at the exact `fleet_version` you pass, then runs the daemon under systemd as a non-root user. **There is no GCP daemon image** — the daemon is an npm install, and the deprecated Compute Engine container-startup path (konlet / `create-with-container`) is deliberately not used.
- **A separate data disk** mounted as `FLEET_HOME` — real POSIX for the append-heavy journals (GCS FUSE and Filestore were both disqualified; see the issue record). The boot disk is replaceable; the data disk and the **reserved static internal address** both outlive the instance, which is what lets `fleet upgrade` replace the VM under in-flight jobs — every launched job's `FLEET_DAEMON_URL` points at that address.
- **Cloud NAT** (scoped to the one subnetwork) — the VM's only egress path, since it has no external IP. Jobs never use it: their VPC egress is `PRIVATE_RANGES_ONLY`, so their internet traffic (git, npm, the harness API) takes Cloud Run's own path.
- **A one-shot Cloud Build** (only when the module source is pinned to a git ref, which `fleet setup infra` always does) that clones the **public** Fleet repository at **exactly that ref** (`source_repository` / `source_ref`), builds `images/runner` inside your project, and pushes it as `<runner_repository_url>:runner` — the tag the Cloud Run job pins. One image, because this cloud has no daemon image. It runs as its own service account, which can write to that one Artifact Registry repository and write its own logs; see [Images](#images) below.
- **Artifact Registry** repository for the runner image, **Secret Manager** secret the daemon publishes the operator token into at boot (#188), and the IAM split: the daemon's service account can execute/cancel/list executions of the one job, act as the runner's service account, add token versions, and write logs; the runner's service account can write logs and nothing else. The VM carries the `cloud-platform` access scope — GCE's legacy default scopes silently block Secret Manager regardless of IAM.
- **A customer-managed KMS key** (the `aws_kms_key.fleet` twin) encrypting the daemon's data disk, its boot disk, and the registry — so the operator can rotate, audit and revoke what holds their job history rather than relying on a Google-managed key. Rotates every 90 days; a destroyed version stays recoverable for 30 days (`key_rotation_period`, `key_destroy_duration`). The daemon VM also runs as a **Shielded VM** and blocks project-wide SSH keys.

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

Notes:

- The unit enables the APIs it needs (`run`, `compute`, `artifactregistry`, `cloudkms`, `secretmanager`, `iap`, `iam`) with `disable_on_destroy = false`. On a **fresh project** the subnetwork data source and the two CMEK service agents can race their APIs' first enablement — if the first apply fails on either, run it again (or `gcloud services enable compute.googleapis.com artifactregistry.googleapis.com` first). The agents are `service-<PROJECT_NUMBER>@compute-system.iam.gserviceaccount.com` and `service-<PROJECT_NUMBER>@gcp-sa-artifactregistry.iam.gserviceaccount.com`; each is created when its API is enabled, and each needs `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the key — the unit grants both (see `docs/decisions.md#d18` for why they are named rather than created).
- On the **default network**, the unit uses the region's `default` subnetwork. On a custom network, pass `network` and a `subnetwork` **in the deployment region** — Direct VPC egress requires a region-matched subnet, and the unit looks the name up in that region so a wrong-region value fails before the first job does.
- The default network's pre-created rules (`default-allow-ssh` etc.) target instances with reachable addresses; the daemon VM has no external IP, so nothing here is internet-reachable regardless.

## Images

**The wizard already built the runner image.** When the module source is pinned to a git ref, the unit writes a Cloud Build config (`<name>-cloudbuild.yaml`, beside the captured `fleet-config.json`) and publishes what starting a build needs through `fleet_config`: `image_build_config`, `image_build_source`, `image_build_revision`. `fleet setup infra` submits that build right after the apply and waits with progress, so images and infrastructure can never skew and there is no clone, no local Docker, and no TLS-intercepting proxy in the path:

```sh
gcloud builds submit <image_build_source> --git-source-revision <image_build_revision> \
  --config <image_build_config> --project <project> --region <region> --async --format='value(id)'
```

Rebuild after an upgrade (`fleet upgrade` does it for you at the ref it just re-pinned):

```sh
fleet setup infra --provider gcp --rebuild-images
```

There is **nothing to roll** afterwards: a job reads the `:runner` tag when it executes, so the next dispatched job runs the new image, and the daemon is not an image at all — it moves when `fleet upgrade` replaces the VM at a new `fleet_version`.

The build runs as `<name>-build@…`, whose only grants are `roles/artifactregistry.writer` **on this deployment's runner repository** and `roles/logging.logWriter`. *Starting* a build is the operator's act, with the operator's own credentials: `operator_members` receive a custom role of exactly `cloudbuild.builds.create` / `.get` / `.list` (not `roles/cloudbuild.builds.editor`, which carries update, cancel and approve over every build in the project) plus `roles/iam.serviceAccountUser` on that one build account. Reading a **failed** build's log with `gcloud builds log <id> --region <region>` reads Cloud Logging, which needs a log-viewer role as well — deliberately not granted here, since project-wide log read is a wider ask than starting a build; project owners already have it, and the Cloud Build console page works either way.

A module applied from a **local path** pins no ref, so it provisions no build — there is no honest ref to build from, and the wizard says so and names the developer path instead of building from a floating default:

```sh
<fleet-checkout>/images/build.sh --runner --push     # gcloud auth configure-docker, then :runner
```

### The `--config` question

`gcloud builds submit <git-url> --config <path>` reads the config **from the local filesystem**, not from the git source. Verified in the gcloud SDK rather than assumed: `command_lib/builds/submit_util.py` loads the config with `api_lib/cloudbuild/config.LoadCloudbuildConfigFromPath`, which is `files.FileReader(path)` and raises `MissingFileError` when the path does not exist — and it does so in `_SetBuildSteps`, before `SetSource` has looked at the source at all. `SetSource`'s `http://`/`https://` branch only fills in `source.gitSource = {url, dir, revision}` for the server to fetch. Two consequences the unit is built on:

- The config **must** exist locally (the flag even defaults to `./cloudbuild.yaml`), which is why terraform writes it beside the deployment rather than relying on the pinned ref carrying one. `ImageBuild.start` in `src/cli/setup-units.ts` is synchronous and argv-only, so the CLI has no seam at which it could generate one.
- The config **must not** declare a `source` of its own: gcloud rejects that outright unless `--no-source` is passed. The repository and ref therefore ride the command line. Pinned by `test/infra-gcp.test.ts`.

The path in `fleet_config` is absolute (`abspath(path.root)` — not `path.cwd`, which under `terraform -chdir=…` is the operator's original directory). It is written by the apply, so moving the project directory means re-running `fleet setup infra` (or `fleet upgrade`) to re-capture it, exactly as for every other captured value.

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
