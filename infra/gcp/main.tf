# Fleet on GCP (#185): jobs are Cloud Run Job executions, the daemon is a
# micro VM with a separate data disk, operator access is an IAP tunnel. Much
# smaller than the AWS unit by construction — no ASG, no capacity provider, no
# launch template, no shared filesystem, and no daemon container image at all:
# cloud-init installs the daemon from npm at a pinned version and runs it
# under systemd. (The Compute Engine container-startup path — konlet /
# create-with-container — is deprecated and must not come back here.)
#
# No public ingress anywhere: the VM has no external IP (egress rides Cloud
# NAT), the only sources any firewall rule admits are Google's published IAP
# range and the runner jobs' own network tag, and Cloud Run jobs have no
# inbound surface at all.

data "google_client_config" "current" {}

data "google_compute_zones" "available" {
  region = local.region
}

# The subnetwork the daemon VM and the jobs' Direct VPC egress share. Looked
# up by name IN THE DEPLOYMENT REGION on purpose: Direct VPC egress requires
# the job's connected subnet to be in the job's region, so a wrong-region
# subnetwork fails this read instead of failing the first job. Empty
# var.subnetwork falls back to the subnetwork named like the network — the
# shape of the default (auto-mode) VPC, which has one per region.
data "google_compute_subnetwork" "this" {
  name   = var.subnetwork != "" ? var.subnetwork : var.network
  region = local.region
}

locals {
  project = data.google_client_config.current.project
  region  = data.google_client_config.current.region
  zone    = var.daemon_zone != "" ? var.daemon_zone : data.google_compute_zones.available.names[0]

  labels = merge(var.labels, { fleet-module = var.name })

  daemon_tag = "${var.name}-daemon"
  runner_tag = "${var.name}-runner"

  # Image path inside the Artifact Registry repository. images are pushed as
  # <runner_repository_url>:runner — same tag contract as the AWS unit.
  runner_repository_url = "${local.region}-docker.pkg.dev/${local.project}/${google_artifact_registry_repository.runner.repository_id}/runner"
}

# APIs the unit stands on. disable_on_destroy = false: turning a service off
# on teardown would break whatever else in the project uses it.
resource "google_project_service" "services" {
  for_each = toset(concat(
    [
      "artifactregistry.googleapis.com",
      "cloudkms.googleapis.com",
      "compute.googleapis.com",
      "iam.googleapis.com",
      "iap.googleapis.com",
      "run.googleapis.com",
      "secretmanager.googleapis.com",
    ],
    # Only when this deployment actually has an in-account build to run:
    # enabling an API a deployment never calls is surface nobody asked for.
    local.build_images ? ["cloudbuild.googleapis.com"] : [],
  ))

  project            = local.project
  service            = each.value
  disable_on_destroy = false
}

# --- KMS (customer-managed key for state at rest) -----------------------------------
# The GCP twin of infra/aws's aws_kms_key.fleet. The daemon's data disk holds
# every job's event journal, the boot disk holds the rendered daemon env, and
# the registry holds the image jobs run as — all encrypted by default with a
# Google-managed key the operator cannot rotate on their own schedule, audit
# by policy, or revoke. One CMK covers all three so those things are the
# operator's to control (Checkov CKV_GCP_37 / CKV_GCP_38 / CKV_GCP_84).
#
# Destroy stance, matching the AWS unit's 30-day deletion window: the key ring
# is permanent by GCP's own design (rings cannot be deleted), and destroying
# the crypto key only schedules its versions for destruction after
# var.key_destroy_duration — the key is the only way to read a job's history,
# and a fat-fingered destroy should be recoverable for longer than a weekend.

resource "google_kms_key_ring" "fleet" {
  name     = var.name
  location = local.region

  depends_on = [google_project_service.services]
}

resource "google_kms_crypto_key" "fleet" {
  # checkov:skip=CKV_GCP_82: prevent_destroy would wedge `fleet setup infra --destroy`, a supported path — and this lifecycle block lives inside a git-sourced module, so an operator could not override it without forking the unit. What the check guards is already held by construction: a GCP key ring can never be deleted, and destroying this resource only schedules its versions with the destroy_scheduled_duration recovery window below (30 days, the AWS unit's KMS deletion window). Recorded in docs/decisions.md#d18.
  name     = var.name
  key_ring = google_kms_key_ring.fleet.id
  purpose  = "ENCRYPT_DECRYPT"
  labels   = local.labels

  # Rotation, like the AWS key's enable_key_rotation. Existing data stays
  # readable under the version that wrote it; new writes take the new one.
  rotation_period = var.key_rotation_period

  # The recovery window for a destroy: versions sit DESTROY_SCHEDULED for this
  # long and can be restored.
  destroy_scheduled_duration = var.key_destroy_duration
}

# CMEK is two authorizations, and the second is the one that fails a first
# apply: the *service agent* — not the caller, not the daemon — does the
# encrypting, and it needs cryptoKeyEncrypterDecrypter on the key.
#
# Both agents are addressed by their documented fixed form over the project
# number. The alternative, google_project_service_identity, would force them
# into existence rather than assume it — but that resource is beta-only in
# provider 6.x, and a google-beta provider would need its own configured
# `provider` block: the wizard's generator emits exactly one
# (src/cli/setup.ts renderMainTf), so a second one would go unconfigured and
# silently fall back to the caller's ambient gcloud project — the #138 class
# of bug, traded for a race. What makes the fixed form safe here is the
# dependency: an agent is created when its API is enabled, and every
# reference below waits on google_project_service.services. The residual
# first-apply race on a brand-new project is the same one the subnetwork data
# source has, and the README's bring-up notes tell the operator to rerun.
data "google_project" "current" {
  project_id = local.project

  depends_on = [google_project_service.services]
}

locals {
  compute_agent  = "serviceAccount:service-${data.google_project.current.number}@compute-system.iam.gserviceaccount.com"
  registry_agent = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-artifactregistry.iam.gserviceaccount.com"
}

# Both disks are encrypted by the compute agent; the registry by its own.
# Scoped to this one key — a project-level KMS grant would let either agent
# use every key in the project.
resource "google_kms_crypto_key_iam_member" "compute_agent" {
  crypto_key_id = google_kms_crypto_key.fleet.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.compute_agent
}

resource "google_kms_crypto_key_iam_member" "registry_agent" {
  crypto_key_id = google_kms_crypto_key.fleet.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.registry_agent
}

# --- Identities -----------------------------------------------------------------
# Two service accounts, split the same way the AWS unit splits its roles: the
# daemon holds dispatch powers, the runner holds none — a job container able
# to run or cancel executions defeats the sandbox the same way an agent
# answering its own decision would.

resource "google_service_account" "daemon" {
  account_id   = "${var.name}-daemon"
  display_name = "Fleet daemon"

  depends_on = [google_project_service.services]
}

resource "google_service_account" "runner" {
  account_id   = "${var.name}-runner"
  display_name = "Fleet runner jobs"

  depends_on = [google_project_service.services]
}

# --- Artifact Registry -------------------------------------------------------------

resource "google_artifact_registry_repository" "runner" {
  repository_id = "${var.name}-runner"
  location      = local.region
  format        = "DOCKER"
  description   = "Fleet runner image (:runner tag)"
  labels        = local.labels

  # CMEK: the image is what every job executes as, so the operator holds the
  # key that decrypts it. The grant is a dependency, not a decoration — the
  # repository create fails outright if the registry agent cannot use the key.
  kms_key_name = google_kms_crypto_key.fleet.id

  depends_on = [
    google_project_service.services,
    google_kms_crypto_key_iam_member.registry_agent,
  ]
}

# --- In-account image build (Cloud Build, #189/#185) --------------------------------
# `fleet setup infra` owns image production: one Cloud Build submission that
# clones the PUBLIC Fleet repository at var.source_ref — the same pinned ref the
# module source names, so images and infra can never skew — builds
# images/runner, and pushes it to this deployment's Artifact Registry as
# :runner. No clone and no local Docker on the operator's machine;
# images/build.sh stays the developer/offline path. There is exactly ONE image:
# GCP has no daemon container at all (cloud-init installs the daemon from npm),
# so nothing here builds or pushes a :daemon tag.
#
# Created only when source_ref is set. A module applied from a local path (the
# dogfood shape) has no honest ref to pin, and a build from a floating default
# would re-shape the image silently — the wizard refuses instead and names
# images/build.sh.
#
# Starting a build is the operator's act, not the unit's: `fleet setup infra`
# runs `gcloud builds submit` with the operator's own credentials (the same
# admin-ish credentials the apply used), after the apply and on
# --rebuild-images. No trigger, no webhook, no schedule, and no Fleet runtime
# identity can reach it.

locals {
  build_images = var.source_ref != ""
}

# The build runs as its own service account rather than the legacy Cloud Build
# one — which new projects no longer get by default, and which carries
# project-wide powers by design. This one can write to exactly one Artifact
# Registry repository and write its own logs.
resource "google_service_account" "image_build" {
  count = local.build_images ? 1 : 0

  account_id   = "${var.name}-build"
  display_name = "Fleet image build"

  depends_on = [google_project_service.services]
}

# Push to THIS deployment's runner repository only, not the project-wide
# roles/artifactregistry.writer a convenience grant would take: the build must
# not be able to write any other repository in the project.
resource "google_artifact_registry_repository_iam_member" "build_pushes_runner" {
  count = local.build_images ? 1 : 0

  project    = local.project
  location   = local.region
  repository = google_artifact_registry_repository.runner.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.image_build[0].email}"
}

# A user-specified build service account must be able to write its own logs, or
# the build fails before its first step. This is the only log grant it needs
# because the config below sets logging = CLOUD_LOGGING_ONLY (no logs bucket).
resource "google_project_iam_member" "build_logs" {
  count = local.build_images ? 1 : 0

  project = local.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.image_build[0].email}"
}

# The operator's StartBuild path: submitting a build that runs as the build
# service account takes both a Cloud Build permission and actAs on that
# account. Empty operator_members relies on the applying identity's own
# project-level grants, exactly like the IAP and secret grants above.
#
# A custom role of three permissions rather than roles/cloudbuild.builds.editor
# (Checkov CKV_GCP_49, and the check has a point): builds.editor also carries
# update, cancel and approve over every build in the project, and Cloud Build's
# predefined roles are the documented route to impersonating whatever service
# account a build config names. These are exactly the two calls the wizard
# makes — submit (create) and poll (get) — plus list, so an operator can find a
# build whose id they lost. The impersonation half is held on the other side:
# actAs is granted below on the ONE build account, never
# roles/iam.serviceAccountUser at project level, which would hand the operator
# the daemon's identity too. Reading a failed build's log needs a log-viewer
# role as well — deliberately not granted here (see README.md).
resource "google_project_iam_custom_role" "image_build_submit" {
  count = local.build_images ? 1 : 0

  role_id     = "${replace(var.name, "-", "_")}_image_build"
  title       = "Fleet image build submitter"
  description = "Submit and read this deployment's one-shot Fleet image build. Least privilege for `fleet setup infra --rebuild-images`."
  permissions = [
    "cloudbuild.builds.create",
    "cloudbuild.builds.get",
    "cloudbuild.builds.list",
  ]
}

resource "google_project_iam_member" "operators_start_builds" {
  for_each = local.build_images ? toset(var.operator_members) : toset([])

  project = local.project
  role    = google_project_iam_custom_role.image_build_submit[0].id
  member  = each.value
}

resource "google_service_account_iam_member" "operators_use_build_sa" {
  for_each = local.build_images ? toset(var.operator_members) : toset([])

  service_account_id = google_service_account.image_build[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value
}

# The build config, written to disk beside this deployment's own
# fleet-config.json and named by fleet_config.image_build_config.
#
# A file, and not an argv fragment, because `gcloud builds submit --config`
# reads the path from the LOCAL filesystem — the git source is fetched
# server-side into /workspace, and gcloud never looks for the config inside it
# (verified in the SDK; see README.md#the---config-question). And terraform
# writes it, not the CLI, because `ImageBuild.start` (src/cli/setup-units.ts)
# is synchronous and argv-only: there is no seam at which the CLI could
# generate one. abspath(path.root), not path.cwd: under `terraform -chdir=…`
# path.cwd is the operator's original directory, which would drop the file
# somewhere the captured path does not point.
resource "local_file" "cloudbuild" {
  count = local.build_images ? 1 : 0

  filename        = "${abspath(path.root)}/${var.name}-cloudbuild.yaml"
  file_permission = "0644"

  # One step, one image. FLEET_BUILD_SHA is the pinned ref itself (#207/#211):
  # the runner logs it at job start, and it is the only identity this build
  # honestly has — Cloud Build's $COMMIT_SHA substitution is not populated for
  # a manual git-source build. yamlencode, not a heredoc: a build config that
  # is invalid YAML fails at `gcloud builds submit`, minutes after the apply.
  content = yamlencode({
    steps = [{
      name = "gcr.io/cloud-builders/docker"
      args = [
        "build",
        "--build-arg", "FLEET_BUILD_SHA=${var.source_ref}",
        "-t", "${local.runner_repository_url}:runner",
        "-f", "images/runner/Dockerfile",
        ".",
      ]
    }]
    # `images` is what pushes: Cloud Build publishes these after the steps
    # succeed, under the service account below.
    images         = ["${local.runner_repository_url}:runner"]
    serviceAccount = "projects/${local.project}/serviceAccounts/${google_service_account.image_build[0].email}"
    timeout        = "${var.image_build_timeout_seconds}s"
    options = {
      # Required with a user-specified service account: the default wants a
      # logs bucket this account has no grant to write.
      logging = "CLOUD_LOGGING_ONLY"
    }
  })
}

# --- Cloud Run job: the task-definition analog ---------------------------------------

resource "google_cloud_run_v2_job" "runner" {
  name     = "${var.name}-runner"
  location = local.region
  labels   = local.labels

  lifecycle {
    # Cloud Run's documented cpu-memory ladder, held at plan: the API rejects
    # a bad pairing only after terraform has started applying. Minimums per
    # cpu (8 vCPU needs >= 4 GiB, 4 needs >= 2) and cpu floors per memory
    # (> 24 GiB needs 8 vCPU, > 16 needs 6, > 8 needs 4, > 4 needs 2).
    precondition {
      condition = (
        var.job_memory_gib >= (var.job_cpu >= 8 ? 4 : var.job_cpu >= 4 ? 2 : 1) &&
        var.job_cpu >= (var.job_memory_gib > 24 ? 8 : var.job_memory_gib > 16 ? 6 : var.job_memory_gib > 8 ? 4 : var.job_memory_gib > 4 ? 2 : 1)
      )
      error_message = "job_cpu=${var.job_cpu} / job_memory_gib=${var.job_memory_gib} is not a pairing Cloud Run accepts — the two move together (see variables.tf)."
    }
  }

  template {
    # One task per execution: a job is one runner.
    task_count  = 1
    parallelism = 1

    template {
      service_account       = google_service_account.runner.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

      # Zero substrate retries: the daemon owns the one auto-retry (#30), and
      # a Cloud-Run-restarted runner would redo a job whose branch and events
      # already exist.
      max_retries = 0

      # The backstop when a manifest declares no wall_clock; a manifest that
      # does rides --task-timeout per execution (src/providers/gcp.ts).
      timeout = "${var.job_timeout_seconds}s"

      containers {
        image = "${local.runner_repository_url}:runner"

        resources {
          limits = {
            cpu    = tostring(var.job_cpu)
            memory = "${var.job_memory_gib}Gi"
          }
        }
      }

      # Direct VPC egress: the job gets an interface on the deployment's
      # subnetwork (region-matched by the data source above) tagged so the
      # daemon firewall rule can name jobs as a source — the tag-referenced
      # twin of the AWS unit's SG-referenced ingress. PRIVATE_RANGES_ONLY:
      # only daemon traffic rides the VPC; the job's internet egress (git,
      # npm, the harness API) takes Cloud Run's own path and never needs the
      # NAT below.
      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"

        network_interfaces {
          network    = var.network
          subnetwork = data.google_compute_subnetwork.this.name
          tags       = [local.runner_tag]
        }
      }
    }
  }

  depends_on = [google_project_service.services]
}

# --- Secret Manager: the operator token (#188) ----------------------------------------
# The unit creates the secret; the daemon adds a version at boot; the CLI
# fetches it with the operator's own gcloud credentials. No version resource
# here — the value is minted by the daemon, never by terraform.

resource "google_secret_manager_secret" "operator_token" {
  secret_id = "${var.name}-operator-token"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

# --- IAM grants (docs/decisions.md#d18) -------------------------------------------

# The daemon executes, cancels and lists executions of the ONE job resource.
resource "google_cloud_run_v2_job_iam_member" "daemon_runs_jobs" {
  name     = google_cloud_run_v2_job.runner.name
  location = local.region
  role     = "roles/run.admin"
  member   = "serviceAccount:${google_service_account.daemon.email}"
}

# Executing a job that runs as the runner SA requires actAs on that SA —
# exactly the PassRole the AWS daemon holds, and exactly this one account.
resource "google_service_account_iam_member" "daemon_uses_runner_sa" {
  service_account_id = google_service_account.runner.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.daemon.email}"
}

# Write-only on the token secret: the daemon publishes at boot and never reads
# it back (its own copy lives at $FLEET_HOME/operator-token).
resource "google_secret_manager_secret_iam_member" "daemon_adds_token" {
  secret_id = google_secret_manager_secret.operator_token.secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.daemon.email}"
}

resource "google_project_iam_member" "daemon_logs" {
  project = local.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.daemon.email}"
}

# The runner writes logs and nothing else. A secretmanager grant arrives with
# the per-job-secrets follow-up, not before; the runner authenticates to the
# daemon with Fleet's own runner token, as everywhere.
resource "google_project_iam_member" "runner_logs" {
  project = local.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.runner.email}"
}

# Operator grants, when the applying identity is not already project-admin.
resource "google_iap_tunnel_instance_iam_member" "operators" {
  for_each = toset(var.operator_members)

  project  = local.project
  zone     = local.zone
  instance = google_compute_instance.daemon.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = each.value
}

resource "google_secret_manager_secret_iam_member" "operators_read_token" {
  for_each = toset(var.operator_members)

  secret_id = google_secret_manager_secret.operator_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

# --- Firewalls -----------------------------------------------------------------
# Two rules, both tag-targeted at the daemon VM and neither admitting a public
# source: Google's published IAP TCP-forwarding range (the tunnel), and the
# runner jobs' own network tag (Direct VPC egress interfaces carry it). The
# VM has no external IP, so nothing here is reachable from the internet even
# on networks whose pre-existing rules are looser.

resource "google_compute_firewall" "iap_daemon" {
  name    = "${var.name}-iap-daemon"
  network = var.network

  direction = "INGRESS"
  # Google's fixed IAP TCP forwarding source range — the only path operators
  # take in. Port 22 rides the same rule as the break-glass path (IAP SSH to a
  # wedged VM), still IAP-only.
  source_ranges = ["35.235.240.0/20"]
  target_tags   = [local.daemon_tag]

  allow {
    protocol = "tcp"
    ports    = [tostring(var.daemon_port), "22"]
  }

  depends_on = [google_project_service.services]
}

resource "google_compute_firewall" "jobs_daemon" {
  name    = "${var.name}-jobs-daemon"
  network = var.network

  direction   = "INGRESS"
  source_tags = [local.runner_tag]
  target_tags = [local.daemon_tag]

  allow {
    protocol = "tcp"
    ports    = [tostring(var.daemon_port)]
  }

  depends_on = [google_project_service.services]
}

# --- Cloud NAT: egress for the no-external-IP daemon VM ---------------------------
# cloud-init installs Node, the daemon package and the gcloud CLI from the
# internet, and the daemon's gcloud calls need a route out. Scoped to the one
# subnetwork so a shared network's other subnets are untouched. Jobs never use
# it — their VPC egress is PRIVATE_RANGES_ONLY.

resource "google_compute_router" "nat" {
  name    = "${var.name}-nat"
  network = var.network
  region  = local.region

  depends_on = [google_project_service.services]
}

resource "google_compute_router_nat" "nat" {
  name   = "${var.name}-nat"
  router = google_compute_router.nat.name
  region = local.region

  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = data.google_compute_subnetwork.this.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}

# --- Daemon VM -------------------------------------------------------------------

# Reserved static internal address: the daemon's IP is baked into every
# in-flight job's FLEET_DAEMON_URL at launch, so it must survive VM
# replacement during fleet upgrade. A separate resource, like the data disk,
# so replacing the instance touches neither.
resource "google_compute_address" "daemon" {
  name         = "${var.name}-daemon"
  address_type = "INTERNAL"
  purpose      = "GCE_ENDPOINT"
  region       = local.region
  subnetwork   = data.google_compute_subnetwork.this.id

  depends_on = [google_project_service.services]
}

# FLEET_HOME lives on its own persistent disk — real POSIX for the
# append-heavy journals (GCS FUSE is disqualified: no locking, fsync as
# whole-object upload, non-atomic rename; Filestore's price floor is ~10x the
# whole deployment). Separate from the boot disk so daemon upgrades replace
# the VM without touching state.
resource "google_compute_disk" "fleet_home" {
  name   = "${var.name}-home"
  type   = "pd-balanced"
  size   = var.data_disk_gb
  zone   = local.zone
  labels = local.labels

  # CMEK: this disk is every job's event journal — the whole history of what
  # Fleet did in this account — so it is encrypted under the operator's own
  # key rather than a Google-managed one they cannot rotate or revoke.
  disk_encryption_key {
    kms_key_self_link = google_kms_crypto_key.fleet.id
  }

  depends_on = [
    google_project_service.services,
    google_kms_crypto_key_iam_member.compute_agent,
  ]
}

locals {
  # Rendered into /etc/fleet/daemon.env by cloud-init: everything the daemon
  # process needs, including the FLEET_GCP_* config src/providers/gcp.ts
  # reads (there is no SSM-fetch analog — the env file IS the config channel).
  # FLEET_DAEMON_HOST is the reserved address above; setting it explicitly is
  # also what widens the daemon's bind past loopback (src/daemon/main.ts).
  daemon_env = <<-EOT
    FLEET_HOME=/var/lib/fleet
    FLEET_PORT=${var.daemon_port}
    FLEET_PROVIDER=gcp
    FLEET_DAEMON_HOST=${google_compute_address.daemon.address}
    FLEET_GCP_PROJECT=${local.project}
    FLEET_GCP_REGION=${local.region}
    FLEET_GCP_JOB=${google_cloud_run_v2_job.runner.name}
    FLEET_GCP_TOKEN_SECRET=${google_secret_manager_secret.operator_token.secret_id}
    FLEET_GCP_CPU_UNITS=${var.job_cpu * 1024}
    FLEET_GCP_MEMORY_MIB=${var.job_memory_gib * 1024}
  EOT

  # cloud-init (Ubuntu LTS processes the user-data key natively): Node 24 via
  # NodeSource, the gcloud CLI via Google's apt repo, ownfleet pinned at
  # var.fleet_version, the data disk formatted once and mounted as FLEET_HOME,
  # swap (each shelled gcloud is a Python process; several stack during boot
  # reconcile), and a systemd unit running the daemon as a non-root user.
  cloud_init = <<-EOT
    #cloud-config
    write_files:
      - path: /etc/fleet/daemon.env
        permissions: "0600"
        content: |
          ${indent(6, local.daemon_env)}
      - path: /etc/systemd/system/fleet-daemon.service
        content: |
          [Unit]
          Description=Fleet daemon
          Wants=network-online.target
          After=network-online.target var-lib-fleet.mount
          Requires=var-lib-fleet.mount

          [Service]
          User=fleet
          EnvironmentFile=/etc/fleet/daemon.env
          Environment=HOME=/var/lib/fleet
          ExecStart=/usr/bin/node /usr/lib/node_modules/ownfleet/src/daemon/main.ts
          Restart=always
          RestartSec=5

          [Install]
          WantedBy=multi-user.target
    runcmd:
      - test -f /swapfile || (fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab)
      - swapon -a
      - blkid /dev/disk/by-id/google-fleet-home || mkfs.ext4 -m0 /dev/disk/by-id/google-fleet-home
      - mkdir -p /var/lib/fleet
      - echo '/dev/disk/by-id/google-fleet-home /var/lib/fleet ext4 discard,defaults 0 2' >> /etc/fstab
      - systemctl daemon-reload
      - mount -a
      - useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/fleet fleet || true
      - chown fleet:fleet /var/lib/fleet
      - curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
      - apt-get install -y nodejs
      - curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg -o /usr/share/keyrings/cloud.google.gpg
      - echo 'deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' > /etc/apt/sources.list.d/google-cloud-sdk.list
      - apt-get update
      - apt-get install -y google-cloud-cli
      - npm install -g ownfleet@${var.fleet_version}
      - systemctl enable --now fleet-daemon
  EOT
}

resource "google_compute_instance" "daemon" {
  name         = "${var.name}-daemon"
  machine_type = var.daemon_machine_type
  zone         = local.zone
  tags         = [local.daemon_tag]
  labels       = local.labels

  # The boot disk is replaceable; state lives on the data disk. cloud-init
  # re-runs on a fresh instance and its format step is guarded by blkid, so a
  # replacement mounts the existing FLEET_HOME instead of wiping it. The image
  # family is UEFI-enabled, which is what makes the shielded_instance_config
  # below take effect rather than be silently ignored.
  boot_disk {
    kms_key_self_link = google_kms_crypto_key.fleet.id

    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
    }
  }

  # Shielded VM (Checkov CKV_GCP_39). The daemon holds the dispatch identity
  # for the whole deployment, so the one host that must not be silently
  # tampered with is this one: secure boot refuses unsigned kernel code, the
  # vTPM anchors the measurements, and integrity monitoring surfaces a boot
  # sequence that stopped matching its baseline.
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  attached_disk {
    source      = google_compute_disk.fleet_home.id
    device_name = "fleet-home"
  }

  network_interface {
    subnetwork = data.google_compute_subnetwork.this.id
    network_ip = google_compute_address.daemon.address
    # Deliberately no access_config: no external IP. Egress rides the Cloud
    # NAT above; inbound is IAP or the runner tag, nothing else.
  }

  # cloud-platform scope, deliberately: GCE's legacy default scopes silently
  # block Secret Manager regardless of IAM, and the failure reads as a
  # permission the operator already granted. IAM (the bindings above) is the
  # actual boundary; the scope just stops fighting it. Pinned by
  # test/infra-gcp.test.ts.
  service_account {
    email  = google_service_account.daemon.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  metadata = {
    user-data = local.cloud_init
    # Project-wide SSH keys would put anyone holding one on this VM
    # (Checkov CKV_GCP_32), which is the whole IAP-only posture undone by a
    # setting made elsewhere in the project. Break-glass stays
    # `gcloud compute ssh --tunnel-through-iap`, which does not depend on it:
    # it provisions an instance-level key for the caller.
    block-project-ssh-keys = "TRUE"
  }

  allow_stopping_for_update = true

  depends_on = [
    google_project_service.services,
    google_kms_crypto_key_iam_member.compute_agent,
  ]
}

# --- The deployment's self-description --------------------------------------------
# Written EXACTLY ONCE as this local (test/cloud-agnostic.test.ts) and
# published through the fleet_config output operators capture. Unlike AWS
# there is no second publication channel: the daemon's copy of this
# information is the terraform-rendered env file above, same bytes by
# construction because both read the same resources.
locals {
  fleet_config = {
    provider = "gcp"
    # The project and region every gcloud call against this deployment names
    # explicitly — the #138 lesson, GCP edition: a wrong ambient value asks a
    # different project the same question and gets an empty answer.
    project = local.project
    region  = local.region
    # The Cloud Run job `gcloud run jobs execute` runs — the task-definition
    # analog the daemon's launch path names.
    runner_job            = google_cloud_run_v2_job.runner.name
    runner_repository_url = local.runner_repository_url
    # The in-account image build, as `gcloud builds submit` needs to be told it
    # (#189's image_build_project, GCP edition): the local config file this
    # apply wrote, the git source, and the ref. All three are null when the
    # module was applied from an unpinned source — the CLI then starts no build
    # and names images/build.sh instead of inventing a ref.
    image_build_config   = one(local_file.cloudbuild[*].filename)
    image_build_source   = local.build_images ? var.source_repository : null
    image_build_revision = local.build_images ? var.source_ref : null
    # Operator access (D12): `fleet connect` opens an IAP tunnel to this VM
    # in this zone, forwarding daemon_port to localhost.
    daemon_instance = google_compute_instance.daemon.name
    daemon_zone     = local.zone
    daemon_port     = var.daemon_port
    # Where the daemon publishes the operator token at boot (#188) and the
    # CLI fetches it from.
    operator_token_secret = google_secret_manager_secret.operator_token.secret_id
    # Offered capacity in the manifest schema's own units (ECS-flavored: cpu
    # 1024 = 1 vCPU, memory MiB): the daemon rejects oversized manifests at
    # dispatch, and on Cloud Run the tier is pinned on the job resource so an
    # oversized request can never be served.
    capacity_tiers = [{ cpu = var.job_cpu * 1024, memory = var.job_memory_gib * 1024 }]
  }
}
