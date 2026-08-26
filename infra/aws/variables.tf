variable "name" {
  description = "Name prefix applied to every resource created by this module."
  type        = string
  default     = "fleet"
}

variable "tags" {
  description = "Extra tags applied to every taggable resource."
  type        = map(string)
  default     = {}
}

# --- Networking -------------------------------------------------------------

variable "vpc_id" {
  description = "Existing VPC to deploy into. Leave null to have the module create a dedicated VPC."
  type        = string
  default     = null
}

variable "subnet_ids" {
  description = "Subnets for container instances, the daemon task, and EFS mount targets. Required (non-empty) when vpc_id is set; ignored when the module creates its own VPC."
  type        = list(string)
  default     = []
}

variable "vpc_cidr" {
  description = "CIDR block for the module-created VPC (ignored when vpc_id is set)."
  type        = string
  default     = "10.42.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones (and subnets per tier) for the module-created VPC."
  type        = number
  default     = 2

  # Public subnets take cidrsubnet netnums 0..az_count-1 and private subnets
  # take 8..az_count+7 (main.tf): a ninth AZ hands public subnet 8 and private
  # subnet 0 the same CIDR, which AWS rejects only at apply. Constraints that
  # fail at plan, not apply — #9 paid four applies to learn the difference.
  validation {
    condition     = var.az_count >= 1 && var.az_count <= 8
    error_message = "az_count must be between 1 and 8: the module's subnet layout reserves netnums 0-7 for public and 8-15 for private subnets, so a ninth AZ would give a public and a private subnet the same CIDR."
  }
}

variable "enable_nat_gateway" {
  description = "When the module creates the VPC: true places instances in private subnets behind a NAT gateway; false places them in public subnets with public-IP egress. Either way no security group allows inbound traffic from outside the VPC — access is via SSM only."
  type        = bool
  default     = false
}

# --- Compute ----------------------------------------------------------------

variable "instance_type" {
  description = "EC2 instance type for the ECS container instances. Coupled to offered_cpu_units/offered_memory_mib and the runner_cpu/runner_memory task defaults — the five move together (a tier the instance cannot host fails at the runner task definition's precondition). Default is t3.xlarge: 2-vCPU boxes starve suite-heavy harness jobs into their wall-clock budgets (#191), and the Spot price difference is cents per job-hour against a whole re-run when a job times out."
  type        = string
  default     = "t3.xlarge"
}

variable "max_instances" {
  description = "Maximum size of the ECS container-instance auto scaling group (the minimum is min_instances, default 0, so the cluster scales to zero when idle)."
  type        = number
  default     = 4

  validation {
    condition     = var.max_instances >= 1
    error_message = "max_instances must be at least 1: an ASG capped at 0 can never scale out, so every job queues forever."
  }
}

variable "min_instances" {
  description = "Warm capacity floor: container instances the auto scaling group keeps running even when no job is. Default 0 is the scale-to-zero design commitment — idle costs nothing. Raise it to skip the ~3-4 minute cold start (instance boot + image pull) on the first job of a burst: a warm instance already holds the runner image, so warm-start is task start in seconds. Each always-on t3.medium is roughly $30/mo — more than the rest of a Fleet deployment combined."
  type        = number
  default     = 0

  # min_instances <= max_instances needs both variables, so it lives as a
  # precondition on aws_autoscaling_group.instances (main.tf): the module still
  # supports terraform 1.5, and cross-variable validation needs 1.9. This block
  # holds the bound no pairing escapes.
  validation {
    condition     = var.min_instances >= 0
    error_message = "min_instances cannot be negative: it is the ASG's minimum size."
  }
}

variable "on_demand_base_capacity" {
  description = "Number of instances in the auto scaling group that are always launched as on-demand (not spot). Set above zero when you need guaranteed baseline capacity."
  type        = number
  default     = 0

  validation {
    condition     = var.on_demand_base_capacity >= 0
    error_message = "on_demand_base_capacity cannot be negative."
  }
}

variable "on_demand_percentage_above_base" {
  description = "Percentage of additional instances above on_demand_base_capacity that are on-demand; the remainder are spot. 0 = all spot above the base; 100 = all on-demand."
  type        = number
  default     = 0

  validation {
    condition     = var.on_demand_percentage_above_base >= 0 && var.on_demand_percentage_above_base <= 100
    error_message = "on_demand_percentage_above_base is a percentage: it must be between 0 and 100."
  }
}

variable "scaling_cooldown_seconds" {
  description = "Auto scaling group scale-in protection cooldown in seconds. Increase if jobs are terminated mid-run by aggressive scale-in."
  type        = number
  default     = 300
}

variable "offered_cpu_units" {
  description = "Maximum CPU (in ECS units, 1024 = 1 vCPU) that a single runner task may request. Encoded in fleet_config so the daemon can reject oversized manifests at dispatch. Default matches a t3.xlarge (4 vCPU = 4096 units); move it with instance_type."
  type        = number
  default     = 4096

  validation {
    condition     = var.offered_cpu_units > 0
    error_message = "offered_cpu_units must be positive: a zero (or negative) tier makes the daemon reject every manifest that requests cpu."
  }
}

variable "offered_memory_mib" {
  description = "Maximum memory (in MiB) that a single runner task may request. Encoded in fleet_config so the daemon can reject oversized manifests at dispatch. Default leaves ~1 GiB for the ECS agent and OS on a t3.xlarge (16384 MiB total); move it with instance_type."
  type        = number
  default     = 15360

  validation {
    condition     = var.offered_memory_mib > 0
    error_message = "offered_memory_mib must be positive: a zero (or negative) tier makes the daemon reject every manifest that requests memory."
  }
}

# --- Images -----------------------------------------------------------------

variable "source_repository" {
  description = "Public git repository the in-account image build clones to produce the :runner and :daemon images (#189). Defaults to Fleet's canonical repo; `fleet setup infra` overrides it with the repository its module source names, so a fork builds its own code."
  type        = string
  default     = "https://github.com/vincentpaca/fleet.git"

  validation {
    condition     = can(regex("^https://", var.source_repository))
    error_message = "source_repository must be an https git URL — CodeBuild clones a public repository anonymously, which only the https form supports."
  }
}

variable "source_ref" {
  description = "Git ref (tag or commit) of source_repository the image build checks out — the same pinned ref this module was applied from, so images and infra can never skew. `fleet setup infra` supplies it from the generated root module's own module source. Empty (the default) provisions no build project at all: a module applied from a local path has no honest ref to pin, and building from a floating default would skew silently. The developer path (images/build.sh) still works either way."
  type        = string
  default     = ""
}

variable "project_repos" {
  description = "Names of additional ECR repositories to create, one per project image (e.g. [\"acme-app\"])."
  type        = list(string)
  default     = []
}

variable "daemon_image" {
  description = "Container image for the Fleet daemon. Defaults (when empty) to the module-created fleet runner ECR repository with the tag \"daemon\" — push your daemon image there or set this explicitly."
  type        = string
  default     = ""
}

# --- Daemon service ---------------------------------------------------------

variable "daemon_cpu" {
  description = "CPU units for the daemon Fargate task (task-level; must be a valid Fargate CPU value: 256, 512, 1024, 2048, or 4096)."
  type        = number
  default     = 256

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.daemon_cpu)
    error_message = "daemon_cpu must be a Fargate task CPU value: 256, 512, 1024, 2048, or 4096. Fargate rejects anything else at apply."
  }
}

variable "daemon_memory" {
  description = "Memory (MiB) for the daemon Fargate task (task-level; must be a valid Fargate memory value for the chosen CPU — e.g. 512-2048 for CPU=256)."
  type        = number
  default     = 512

  # The full cpu↔memory pairing needs both variables and lives as a
  # precondition on aws_ecs_task_definition.daemon (main.tf): the module still
  # supports terraform 1.5, and cross-variable validation needs 1.9. This block
  # holds the bound no pairing escapes.
  validation {
    condition     = var.daemon_memory >= 512 && var.daemon_memory <= 30720
    error_message = "daemon_memory must be between 512 and 30720 MiB — the range Fargate supports across its task CPU values."
  }
}

variable "daemon_tcp_port" {
  description = "TCP port the daemon binds inside its container. Runner tasks on the same VPC reach the daemon at this port. Exposed to operators via SSM port-forward (see the connect_hint output)."
  type        = number
  default     = 9000
}

variable "runner_cpu" {
  description = "CPU units reserved for a runner container when the manifest requests nothing. Defaults to the full offered tier — one job per instance, so a default job gets the performance the tier advertises instead of a 256-unit sliver; manifests wanting denser packing request less via limits.resources. Must not exceed offered_cpu_units (precondition on the runner task definition)."
  type        = number
  default     = 4096
}

variable "runner_memory" {
  description = "Hard memory limit (MiB) for a runner container when the manifest requests nothing. Defaults to the full offered tier (see runner_cpu); a 1024 MiB default previously ran whole test suites inside a 1 GiB hard cap. Must not exceed offered_memory_mib (precondition on the runner task definition)."
  type        = number
  default     = 15360
}

variable "fleet_home_path" {
  description = "Container path for FLEET_HOME; backed by the EFS volume so job state survives task replacement."
  type        = string
  default     = "/var/lib/fleet"
}

# --- Observability & cost ---------------------------------------------------

variable "log_retention_days" {
  description = "Retention in days for the CloudWatch log groups."
  type        = number
  default     = 30
}

