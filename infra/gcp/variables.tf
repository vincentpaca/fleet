variable "name" {
  description = "Name prefix applied to every resource created by this module."
  type        = string
  default     = "fleet"

  # Tighter than the AWS twin: service-account ids ("<name>-daemon",
  # "<name>-runner") max out at 30 characters, and the IAM API rejects longer
  # ones only at apply. The wizard enforces the same bound at the prompt.
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}[a-z0-9]$", var.name)) && !strcontains(var.name, "--")
    error_message = "name must be 3-22 characters of lower-case letters, digits and dashes (no double dash), starting with a letter — \"-daemon\" and \"-runner\" must fit inside the 30-character service-account id limit."
  }
}

variable "labels" {
  description = "Extra labels applied to every labelable resource."
  type        = map(string)
  default     = {}
}

# --- Networking -------------------------------------------------------------

variable "network" {
  description = "VPC network to deploy into. Defaults to the project's default network; org-policied projects without one supply their own (and a subnetwork in the deployment region)."
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "Subnetwork for the daemon VM and the jobs' Direct VPC egress. Must be in the deployment's region — Direct VPC egress requires a region-matched subnet, and the module looks the name up in that region so a wrong-region value fails at plan/apply instead of at the first job. Empty uses the subnetwork named like the network in the region (the default network's shape)."
  type        = string
  default     = ""
}

variable "daemon_zone" {
  description = "Zone for the daemon VM and its data disk. Empty picks the region's first available zone."
  type        = string
  default     = ""
}

# --- Jobs (Cloud Run) ---------------------------------------------------------

variable "job_cpu" {
  description = "vCPUs for a runner job task. Default is the #191 tier (4 vCPU); Cloud Run's ceiling is 8. Pinned on the job resource — executions cannot override it, so the daemon refuses larger manifest requests at dispatch (fleet_config.capacity_tiers)."
  type        = number
  default     = 4

  validation {
    condition     = contains([1, 2, 4, 6, 8], var.job_cpu)
    error_message = "job_cpu must be one of 1, 2, 4, 6, 8 — the vCPU values Cloud Run accepts; anything else fails only at the API."
  }
}

variable "job_memory_gib" {
  description = "Memory (GiB) for a runner job task. Default is the #191 tier (16 GiB); Cloud Run's ceiling is 32. Moves together with job_cpu (the cpu-memory ladder is a precondition on the job resource)."
  type        = number
  default     = 16

  validation {
    condition     = var.job_memory_gib >= 1 && var.job_memory_gib <= 32
    error_message = "job_memory_gib must be between 1 and 32 — Cloud Run's supported range for jobs."
  }
}

variable "job_timeout_seconds" {
  description = "Default task timeout for a runner job execution — the substrate backstop when a manifest declares no wall_clock (Cloud Run would otherwise default to 10 minutes and kill every long job). A manifest wall_clock overrides it per execution (--task-timeout at launch, with margin so the daemon's graceful cancel fires first). Ceiling is Cloud Run's 168h."
  type        = number
  default     = 86400

  validation {
    condition     = var.job_timeout_seconds >= 60 && var.job_timeout_seconds <= 604800
    error_message = "job_timeout_seconds must be between 60 and 604800 (168h, Cloud Run's task-timeout ceiling)."
  }
}

# --- Daemon VM ----------------------------------------------------------------

variable "daemon_machine_type" {
  description = "Machine type for the daemon VM. Default e2-small (~$12/mo): the daemon is light, but every shelled gcloud is a Python process with real memory appetite and several stack during boot reconcile — cloud-init also enables swap. e2-micro (free tier in us-west1/us-central1/us-east1) is the documented frugal option for single-operator use."
  type        = string
  default     = "e2-small"
}

variable "daemon_port" {
  description = "TCP port the daemon binds on the VM. Runner jobs reach it over the VPC at the reserved internal address; operators reach it through the IAP tunnel (see the connect_hint output)."
  type        = number
  default     = 9000

  validation {
    condition     = var.daemon_port > 0 && var.daemon_port <= 65535
    error_message = "daemon_port must be a TCP port (1-65535)."
  }
}

variable "data_disk_gb" {
  description = "Size (GB) of the separate persistent data disk mounted as FLEET_HOME. Separate from the boot disk so fleet upgrade can replace the VM without touching job state."
  type        = number
  default     = 10

  validation {
    condition     = var.data_disk_gb >= 10
    error_message = "data_disk_gb must be at least 10 — GCE's minimum for a pd-balanced disk."
  }
}

variable "fleet_version" {
  description = "Exact ownfleet npm version cloud-init installs on the daemon VM. No default: an unpinned daemon would skew from the CLI silently — `fleet setup infra` supplies the CLI's own version, and `fleet upgrade` moves it by replacing the VM (the reserved internal address and the data disk both survive)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+", var.fleet_version))
    error_message = "fleet_version must be an exact npm version (like 0.2.0) — a tag or range would install something the operator never saw."
  }
}

# --- Encryption -----------------------------------------------------------------

variable "key_rotation_period" {
  description = "How often the deployment's KMS key rotates, as the seconds duration Cloud KMS itself takes. Default 7776000s is 90 days — the ceiling CIS and Checkov's CKV_GCP_43 hold keys to. Data already written stays readable under the version that wrote it; new writes take the new version. Expressed in the API's own unit rather than days-times-arithmetic so the value is greppable and readable by policy scanners, which cannot evaluate an interpolated product."
  type        = string
  default     = "7776000s"

  validation {
    condition     = can(regex("^[0-9]+s$", var.key_rotation_period)) && tonumber(trimsuffix(var.key_rotation_period, "s")) <= 7776000
    error_message = "key_rotation_period must be a seconds duration like \"7776000s\", and no longer than 7776000s (90 days) — beyond that the key stops meeting the rotation baseline the unit claims."
  }
}

variable "key_destroy_duration" {
  description = "Recovery window for a destroyed key version: it sits DESTROY_SCHEDULED this long and can be restored. Default 2592000s is 30 days, matching the AWS unit's KMS deletion window and for the same reason — the key is the only way to read a job's history, and a fat-fingered destroy should be recoverable for longer than a weekend."
  type        = string
  default     = "2592000s"

  validation {
    condition     = can(regex("^[0-9]+s$", var.key_destroy_duration)) && tonumber(trimsuffix(var.key_destroy_duration, "s")) >= 86400
    error_message = "key_destroy_duration must be a seconds duration like \"2592000s\", and at least 86400s (24h) — Cloud KMS's own floor, and anything shorter is not a recovery window."
  }
}

# --- Images (in-account Cloud Build) --------------------------------------------

variable "source_repository" {
  description = "Public git repository the in-account image build clones to produce the :runner image (#189/#185). Defaults to Fleet's canonical repo; `fleet setup infra` overrides it with the repository its module source names, so a fork builds its own code. There is no :daemon image on GCP — the daemon is an npm install on the VM."
  type        = string
  default     = "https://github.com/vincentpaca/fleet.git"

  validation {
    condition     = can(regex("^https://", var.source_repository))
    error_message = "source_repository must be an https git URL — `gcloud builds submit` takes a git source as an http(s) URL, and Cloud Build clones a public repository over it anonymously."
  }
}

variable "source_ref" {
  description = "Git ref (tag or commit) of source_repository the image build checks out — the same pinned ref this module was applied from, so images and infra can never skew. `fleet setup infra` supplies it from the generated root module's own module source. Empty (the default) provisions no build at all: a module applied from a local path has no honest ref to pin, and building from a floating default would skew silently. The developer path (images/build.sh --runner --push) still works either way."
  type        = string
  default     = ""
}

variable "image_build_timeout_seconds" {
  description = "Wall-clock ceiling for one in-account image build, as the seconds duration Cloud Build takes. Default 1800s is 30 minutes, matching the AWS unit's CodeBuild timeout; Cloud Build's own default is 10 minutes, which a cold runner-image build does not reliably finish inside."
  type        = number
  default     = 1800

  validation {
    condition     = var.image_build_timeout_seconds >= 60 && var.image_build_timeout_seconds <= 86400
    error_message = "image_build_timeout_seconds must be between 60 and 86400 (24h, Cloud Build's own ceiling)."
  }
}

# --- Operator access ------------------------------------------------------------

variable "operator_members" {
  description = "IAM members (user:..., group:...) granted operator access: roles/iap.tunnelResourceAccessor on the daemon VM, read access on the operator-token secret, and — when an in-account image build exists — permission to start it (roles/cloudbuild.builds.editor plus actAs on the build service account). Empty relies on the applying identity's own project-level grants."
  type        = list(string)
  default     = []
}
