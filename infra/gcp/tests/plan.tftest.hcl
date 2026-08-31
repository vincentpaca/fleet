# Plan-level smoke for this unit: the checks `terraform validate` cannot make
# (provider-schema fits, computed pairings, the rendered cloud-init) — the
# same split as infra/aws/tests/plan.tftest.hcl, whose header explains why a
# plan against a mocked provider is the cheapest place to catch what #9 paid
# four applies to find.
#
#   terraform -chdir=infra/gcp init -backend=false -input=false
#   terraform -chdir=infra/gcp test
#
# Needs terraform >= 1.7 for mock_provider. Constraints no plan can reach —
# GCP validates them in the API, not in the provider schema — are pinned in
# test/infra-gcp.test.ts.

mock_provider "google" {
  # Every data source the unit reads needs a default shaped like the real
  # thing: a generated mock is an empty value, and the unit indexes into these.
  mock_data "google_client_config" {
    defaults = {
      project = "mock-project"
      region  = "us-central1"
    }
  }

  mock_data "google_compute_zones" {
    defaults = {
      names = ["us-central1-a", "us-central1-b", "us-central1-c"]
    }
  }

  # The project number both CMEK service-agent emails are built from.
  mock_data "google_project" {
    defaults = {
      number     = "111122223333"
      project_id = "mock-project"
    }
  }

  mock_resource "google_kms_crypto_key" {
    defaults = {
      id = "projects/mock-project/locations/us-central1/keyRings/fleet/cryptoKeys/fleet"
    }
  }

  mock_data "google_compute_subnetwork" {
    defaults = {
      name          = "default"
      id            = "projects/mock-project/regions/us-central1/subnetworks/default"
      self_link     = "https://www.googleapis.com/compute/v1/projects/mock-project/regions/us-central1/subnetworks/default"
      ip_cidr_range = "10.128.0.0/20"
    }
  }

  # The mocked-apply run below needs computed attributes shaped like the real
  # thing: the reserved address lands in the rendered cloud-init, and the
  # service-account emails land in IAM members.
  mock_resource "google_compute_address" {
    defaults = {
      address = "10.128.0.5"
    }
  }

  mock_resource "google_service_account" {
    defaults = {
      email = "mock-sa@mock-project.iam.gserviceaccount.com"
      name  = "projects/mock-project/serviceAccounts/mock-sa@mock-project.iam.gserviceaccount.com"
    }
  }
}

# The in-account image build's config file is written by terraform (the argv
# `ImageBuild.start` builds can only point at a path). Mocked here so a test run
# asserts the bytes without touching the checkout: an unmocked `local` provider
# would write infra/gcp/fleet-cloudbuild.yaml during the apply runs below.
mock_provider "local" {}

variables {
  fleet_version = "0.2.0"
}

# The default shape: the #191 tier on the job, an e2-small daemon with no
# external IP and the cloud-platform scope, IAP-only ingress.
run "default_shape" {
  command = plan

  # The job pins the tier; executions cannot override it. A drifted default
  # here silently starves every job (#191's lesson).
  assert {
    condition = (
      google_cloud_run_v2_job.runner.template[0].template[0].containers[0].resources[0].limits["cpu"] == "4" &&
      google_cloud_run_v2_job.runner.template[0].template[0].containers[0].resources[0].limits["memory"] == "16Gi"
    )
    error_message = "the default job tier must be 4 vCPU / 16Gi (#191) — change it only together with job_cpu/job_memory_gib defaults and fleet_config.capacity_tiers"
  }

  # Zero substrate retries: a Cloud-Run-restarted runner would redo a job
  # whose branch and events already exist. The daemon owns the one retry (#30).
  assert {
    condition     = google_cloud_run_v2_job.runner.template[0].template[0].max_retries == 0
    error_message = "the runner job must have max_retries = 0 — the daemon owns retry, and a substrate retry replays a job"
  }

  # A manifest with no wall_clock must not die at Cloud Run's 10-minute
  # default task timeout.
  assert {
    condition     = google_cloud_run_v2_job.runner.template[0].template[0].timeout == "86400s"
    error_message = "the job's default timeout must be the unit's backstop (job_timeout_seconds), not Cloud Run's 10-minute default"
  }

  # Jobs reach the daemon over the VPC and nothing else: private-ranges-only
  # egress with the runner tag the firewall keys on.
  assert {
    condition = (
      google_cloud_run_v2_job.runner.template[0].template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY" &&
      contains(google_cloud_run_v2_job.runner.template[0].template[0].vpc_access[0].network_interfaces[0].tags, "fleet-runner")
    )
    error_message = "job VPC egress must be PRIVATE_RANGES_ONLY with the fleet-runner network tag — the tag is what the daemon firewall rule admits"
  }

  assert {
    condition     = google_compute_instance.daemon.machine_type == "e2-small"
    error_message = "the daemon VM defaults to e2-small — the documented cost/memory tradeoff; change it only with the swap and memory notes in variables.tf"
  }

  # No external IP on the daemon VM: egress is Cloud NAT, ingress is IAP or
  # the runner tag. An access_config block here is a public address.
  assert {
    condition     = length(google_compute_instance.daemon.network_interface[0].access_config) == 0
    error_message = "the daemon VM must not have an external IP — operator access is IAP-only, egress rides Cloud NAT"
  }

  # cloud-platform access scope: GCE's legacy default scopes silently block
  # Secret Manager regardless of IAM, and the token publish fails with a
  # permission the operator believes they granted.
  assert {
    condition     = contains(google_compute_instance.daemon.service_account[0].scopes, "https://www.googleapis.com/auth/cloud-platform")
    error_message = "the daemon VM needs the cloud-platform access scope, or default GCE scopes silently block Secret Manager regardless of IAM"
  }

  # Shielded VM: the daemon holds the deployment's dispatch identity, so the
  # one host that must not be silently tampered with is this one. All three
  # settings are schema-valid at false, which is exactly why they are pinned.
  assert {
    condition = (
      google_compute_instance.daemon.shielded_instance_config[0].enable_secure_boot == true &&
      google_compute_instance.daemon.shielded_instance_config[0].enable_vtpm == true &&
      google_compute_instance.daemon.shielded_instance_config[0].enable_integrity_monitoring == true
    )
    error_message = "the daemon VM must run as a Shielded VM (secure boot, vTPM, integrity monitoring) — it holds the dispatch identity for the whole deployment"
  }

  # Rotation and the recovery window, in the seconds form the API takes. The
  # 30-day destroy window matches the AWS unit's KMS deletion window, and for
  # the same reason: the key is the only way to read a job's history.
  assert {
    condition = (
      google_kms_crypto_key.fleet.rotation_period == "7776000s" &&
      google_kms_crypto_key.fleet.destroy_scheduled_duration == "2592000s"
    )
    error_message = "the KMS key must rotate (90d) and hold destroyed versions recoverable for 30 days — matching the AWS unit's deletion window"
  }

  # The tunnel rule admits exactly Google's published IAP TCP-forwarding range.
  assert {
    condition     = google_compute_firewall.iap_daemon.source_ranges == toset(["35.235.240.0/20"])
    error_message = "the IAP rule must admit exactly 35.235.240.0/20 — anything wider is public ingress"
  }

  assert {
    condition = (
      contains(google_compute_firewall.jobs_daemon.source_tags, "fleet-runner") &&
      contains(tolist(google_compute_firewall.jobs_daemon.allow)[0].ports, tostring(var.daemon_port))
    )
    error_message = "the jobs rule must admit the runner tag on the daemon port — jobs authenticate with the runner token, the firewall only scopes who can try"
  }

  # fleet_config is the contract every consumer reads (test/cloud-agnostic.ts
  # holds the key list; this holds the values a plan can see).
  assert {
    condition = (
      output.fleet_config.provider == "gcp" &&
      output.fleet_config.region == "us-central1" &&
      output.fleet_config.project == "mock-project" &&
      output.fleet_config.daemon_port == 9000 &&
      output.fleet_config.daemon_zone == "us-central1-a" &&
      output.fleet_config.runner_job == "fleet-runner" &&
      output.fleet_config.daemon_instance == "fleet-daemon"
    )
    error_message = "fleet_config must carry the deployment's own identifiers — a consumer falling back to ambient gcloud config asks a different project the same question"
  }

  # Offered capacity rides fleet_config in the manifest schema's ECS-flavored
  # units, so the daemon's dispatch-time check matches the deployment.
  assert {
    condition     = output.fleet_config.capacity_tiers[0].cpu == 4096 && output.fleet_config.capacity_tiers[0].memory == 16384
    error_message = "fleet_config.capacity_tiers must advertise the job tier in ECS units (cpu*1024, GiB*1024) — the daemon's checkResources reads these"
  }

  assert {
    condition     = strcontains(output.connect_hint, "gcloud compute start-iap-tunnel")
    error_message = "connect_hint must carry the manual IAP tunnel command — the documented fallback when the CLI is not at hand"
  }

  # No source_ref (this file's default): no build exists, and fleet_config says
  # so in nulls rather than in a path to a file nothing wrote. The CLI reads
  # exactly this to decide between starting a build and naming images/build.sh.
  assert {
    condition = (
      length(local_file.cloudbuild) == 0 &&
      length(google_service_account.image_build) == 0 &&
      output.fleet_config.image_build_config == null &&
      output.fleet_config.image_build_source == null &&
      output.fleet_config.image_build_revision == null
    )
    error_message = "an unpinned module source must provision no image build and publish null build keys — a path here sends the wizard at a config file that was never written"
  }

  # An API a deployment never calls is surface nobody asked for.
  assert {
    condition     = !contains(keys(google_project_service.services), "cloudbuild.googleapis.com")
    error_message = "cloudbuild.googleapis.com must be enabled only when this deployment has a build to run"
  }
}

# The rendered cloud-init: a mocked apply, because the reserved address only
# exists once the mock provider has "created" it. This is the daemon's whole
# configuration channel — a key dropped here is a daemon that boots wrong.
run "cloud_init_carries_the_daemon_contract" {
  command = apply

  # The reserved internal address survives VM replacement; every in-flight
  # job's FLEET_DAEMON_URL points at it. Both values are computed, so the
  # comparison only exists under the mocked apply.
  assert {
    condition     = google_compute_instance.daemon.network_interface[0].network_ip == google_compute_address.daemon.address
    error_message = "the daemon VM must take the reserved internal address — an ephemeral IP strands every in-flight job on fleet upgrade"
  }

  # CMEK on all three at-rest stores (the AWS unit's aws_kms_key.fleet twin):
  # the data disk is every job's event journal, the boot disk holds the
  # rendered daemon env, and the registry holds the image jobs execute as.
  # Computed key id, so this lives here rather than in the plan run above.
  assert {
    condition = (
      google_compute_disk.fleet_home.disk_encryption_key[0].kms_key_self_link == google_kms_crypto_key.fleet.id &&
      google_compute_instance.daemon.boot_disk[0].kms_key_self_link == google_kms_crypto_key.fleet.id &&
      google_artifact_registry_repository.runner.kms_key_name == google_kms_crypto_key.fleet.id
    )
    error_message = "the data disk, the boot disk and the runner registry must all encrypt under the deployment's own KMS key, or the operator cannot rotate, audit or revoke what holds their job history"
  }

  # CMEK is two authorizations, and this is the one that fails a first apply:
  # the service agents, not the caller, do the encrypting. Both are built from
  # the project number, and both are scoped to this one key — a project-level
  # grant would let either agent use every key in the project.
  assert {
    condition = (
      google_kms_crypto_key_iam_member.compute_agent.member == "serviceAccount:service-111122223333@compute-system.iam.gserviceaccount.com" &&
      google_kms_crypto_key_iam_member.registry_agent.member == "serviceAccount:service-111122223333@gcp-sa-artifactregistry.iam.gserviceaccount.com" &&
      google_kms_crypto_key_iam_member.compute_agent.role == "roles/cloudkms.cryptoKeyEncrypterDecrypter" &&
      google_kms_crypto_key_iam_member.registry_agent.role == "roles/cloudkms.cryptoKeyEncrypterDecrypter"
    )
    error_message = "both CMEK service agents must hold cryptoKeyEncrypterDecrypter on this key — without the grant the disks and the repository fail to create at all"
  }

  assert {
    condition = alltrue([
      for needle in [
        "FLEET_PROVIDER=gcp",
        "FLEET_DAEMON_HOST=10.128.0.5",
        "FLEET_PORT=9000",
        "FLEET_HOME=/var/lib/fleet",
        "FLEET_GCP_PROJECT=mock-project",
        "FLEET_GCP_REGION=us-central1",
        "FLEET_GCP_JOB=fleet-runner",
        "FLEET_GCP_TOKEN_SECRET=fleet-operator-token",
        "FLEET_GCP_CPU_UNITS=4096",
        "FLEET_GCP_MEMORY_MIB=16384",
      ] : strcontains(google_compute_instance.daemon.metadata["user-data"], needle)
    ])
    error_message = "cloud-init must render the full daemon env contract (FLEET_* and FLEET_GCP_*) — src/providers/gcp.ts reads exactly these keys"
  }

  # The daemon arrives from npm at the pinned version, runs under systemd as a
  # non-root user, and FLEET_HOME is the separate data disk.
  assert {
    condition = alltrue([
      for needle in [
        "npm install -g ownfleet@0.2.0",
        "ExecStart=/usr/bin/node /usr/lib/node_modules/ownfleet/src/daemon/main.ts",
        "User=fleet",
        "google-fleet-home /var/lib/fleet",
        "google-cloud-cli",
      ] : strcontains(google_compute_instance.daemon.metadata["user-data"], needle)
    ])
    error_message = "cloud-init must install ownfleet at the pinned version, run it under systemd as the fleet user, and mount the data disk as FLEET_HOME"
  }

  # The format step must be guarded: an unguarded mkfs on the surviving data
  # disk is a daemon upgrade that erases every job.
  assert {
    condition     = strcontains(google_compute_instance.daemon.metadata["user-data"], "blkid /dev/disk/by-id/google-fleet-home || mkfs.ext4")
    error_message = "the data-disk format must be blkid-guarded — an unguarded mkfs wipes FLEET_HOME on every VM replacement"
  }

  # Project-wide SSH keys would put anyone holding one on the daemon VM,
  # undoing the IAP-only posture through a setting made elsewhere entirely.
  # It shares the metadata map with the cloud-init above, which is why this
  # lives here: a rewrite that keeps one key and drops the other fails one of
  # these two asserts either way.
  assert {
    condition     = google_compute_instance.daemon.metadata["block-project-ssh-keys"] == "TRUE"
    error_message = "the daemon VM must block project-wide SSH keys, or the IAP-only access story is undone by a project-level setting"
  }
}

# The in-account image build (#189/#185). A mocked apply, not a plan: the build
# config's bytes interpolate the build service account's computed email, which
# is unknown until the mock provider has "created" it.
run "a_pinned_source_builds_one_runner_image_under_its_own_account" {
  command = apply

  variables {
    source_repository = "https://github.com/fleet-test/fleet.git"
    source_ref        = "v9"
    operator_members  = ["user:operator@fleet-test.invalid"]
  }

  # The path the wizard's argv points at: absolute (the CLI runs gcloud from the
  # project root, not from the deployment directory) and beside this root
  # module, which is where the capture that names it also lands.
  assert {
    condition = (
      output.fleet_config.image_build_config == local_file.cloudbuild[0].filename &&
      startswith(output.fleet_config.image_build_config, "/") &&
      endswith(output.fleet_config.image_build_config, "/fleet-cloudbuild.yaml")
    )
    error_message = "fleet_config.image_build_config must be the absolute path of the config this apply wrote — a relative path resolves against the operator's cwd, not the deployment directory"
  }

  # The git source and ref the wizard passes to `gcloud builds submit`: the same
  # ref the module source pins, so images and infra cannot skew.
  assert {
    condition = (
      output.fleet_config.image_build_source == "https://github.com/fleet-test/fleet.git" &&
      output.fleet_config.image_build_revision == "v9"
    )
    error_message = "fleet_config must republish source_repository/source_ref for the build argv — a build from a floating ref re-shapes the image silently"
  }

  # ONE image. GCP has no daemon container at all, so a :daemon tag here would
  # be an image nothing on this cloud ever runs.
  assert {
    condition = (
      strcontains(local_file.cloudbuild[0].content, "images/runner/Dockerfile") &&
      !strcontains(local_file.cloudbuild[0].content, "images/daemon/Dockerfile") &&
      !strcontains(local_file.cloudbuild[0].content, ":daemon")
    )
    error_message = "the build config must build images/runner and only that — on GCP the daemon is an npm install, so a :daemon tag has no consumer"
  }

  # It pushes to this deployment's own repository, at the tag the Cloud Run job
  # pins, stamped with the ref it checked out (#207/#211).
  assert {
    condition = alltrue([
      for needle in [
        "${local.runner_repository_url}:runner",
        "FLEET_BUILD_SHA=v9",
        "CLOUD_LOGGING_ONLY",
        "1800s",
        google_service_account.image_build[0].email,
      ] : strcontains(local_file.cloudbuild[0].content, needle)
    ])
    error_message = "the build config must push <runner_repository_url>:runner, carry the build stamp, run as the build service account, and set logging + a timeout Cloud Build's 10-minute default would not survive"
  }

  # The push grant is repository-scoped: a project-wide artifactregistry.writer
  # would let the build write every repository in the project.
  assert {
    condition = (
      google_artifact_registry_repository_iam_member.build_pushes_runner[0].role == "roles/artifactregistry.writer" &&
      google_artifact_registry_repository_iam_member.build_pushes_runner[0].repository == google_artifact_registry_repository.runner.name &&
      google_artifact_registry_repository_iam_member.build_pushes_runner[0].member == "serviceAccount:${google_service_account.image_build[0].email}"
    )
    error_message = "the build service account must hold artifactregistry.writer on this deployment's runner repository and nothing wider"
  }

  # The operator's StartBuild path: a custom role of exactly the calls the
  # wizard makes, plus actAs on the build account only — never
  # roles/cloudbuild.builds.editor (update/cancel/approve over every build in
  # the project) and never serviceAccountUser at project level, which would
  # hand the operator the daemon's identity too.
  assert {
    condition = (
      google_project_iam_custom_role.image_build_submit[0].permissions == toset([
        "cloudbuild.builds.create", "cloudbuild.builds.get", "cloudbuild.builds.list",
      ]) &&
      google_project_iam_member.operators_start_builds["user:operator@fleet-test.invalid"].role == google_project_iam_custom_role.image_build_submit[0].id &&
      google_service_account_iam_member.operators_use_build_sa["user:operator@fleet-test.invalid"].service_account_id == google_service_account.image_build[0].name
    )
    error_message = "operator_members must be able to submit and poll the build through the unit's custom role, and act as the build service account — that one account, nothing wider"
  }

  assert {
    condition     = contains(keys(google_project_service.services), "cloudbuild.googleapis.com")
    error_message = "a deployment with an in-account build must enable cloudbuild.googleapis.com, or the first submit fails on a disabled API"
  }
}

# --- variable validation ------------------------------------------------------
# Constraints that fail at plan, not apply (#9's lesson).

run "a_cpu_value_cloud_run_rejects_fails_at_plan" {
  command = plan

  variables {
    job_cpu = 3
  }

  expect_failures = [var.job_cpu]
}

run "memory_beyond_the_ceiling_fails_at_plan" {
  command = plan

  variables {
    job_memory_gib = 64
  }

  expect_failures = [var.job_memory_gib]
}

# 16 GiB is valid — for 4 vCPU and up. With 1 vCPU it is a pairing only the
# cross-variable precondition on the job resource can see.
run "the_cpu_memory_ladder_is_held_by_the_precondition" {
  command = plan

  variables {
    job_cpu        = 1
    job_memory_gib = 16
  }

  expect_failures = [google_cloud_run_v2_job.runner]
}

run "a_timeout_past_the_168h_ceiling_fails_at_plan" {
  command = plan

  variables {
    job_timeout_seconds = 700000
  }

  expect_failures = [var.job_timeout_seconds]
}

run "a_name_too_long_for_service_account_ids_fails_at_plan" {
  command = plan

  variables {
    name = "a-very-long-deployment-name"
  }

  expect_failures = [var.name]
}

run "an_unpinned_fleet_version_fails_at_plan" {
  command = plan

  variables {
    fleet_version = "latest"
  }

  expect_failures = [var.fleet_version]
}
