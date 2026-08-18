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
}

variable "enable_nat_gateway" {
  description = "When the module creates the VPC: true places instances in private subnets behind a NAT gateway; false places them in public subnets with public-IP egress. Either way no security group allows inbound traffic from outside the VPC — access is via SSM only."
  type        = bool
  default     = false
}

# --- Compute ----------------------------------------------------------------

variable "instance_type" {
  description = "EC2 instance type for the ECS container instances."
  type        = string
  default     = "t3.medium"
}

variable "max_instances" {
  description = "Maximum size of the ECS container-instance auto scaling group (minimum is always 0 so the cluster scales to zero when idle)."
  type        = number
  default     = 4
}

variable "on_demand_base_capacity" {
  description = "Number of instances in the auto scaling group that are always launched as on-demand (not spot). Set above zero when you need guaranteed baseline capacity."
  type        = number
  default     = 0
}

variable "on_demand_percentage_above_base" {
  description = "Percentage of additional instances above on_demand_base_capacity that are on-demand; the remainder are spot. 0 = all spot above the base; 100 = all on-demand."
  type        = number
  default     = 0
}

variable "scaling_cooldown_seconds" {
  description = "Auto scaling group scale-in protection cooldown in seconds. Increase if jobs are terminated mid-run by aggressive scale-in."
  type        = number
  default     = 300
}

variable "offered_cpu_units" {
  description = "Maximum CPU (in ECS units, 1024 = 1 vCPU) that a single runner task may request. Encoded in fleet_config so the daemon can reject oversized manifests at dispatch. Default matches a t3.medium (2 vCPU = 2048 units)."
  type        = number
  default     = 2048
}

variable "offered_memory_mib" {
  description = "Maximum memory (in MiB) that a single runner task may request. Encoded in fleet_config so the daemon can reject oversized manifests at dispatch. Default leaves ~512 MiB for the ECS agent and OS on a t3.medium (4096 MiB total)."
  type        = number
  default     = 3584
}

# --- Images -----------------------------------------------------------------

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
}

variable "daemon_memory" {
  description = "Memory (MiB) for the daemon Fargate task (task-level; must be a valid Fargate memory value for the chosen CPU — e.g. 512-2048 for CPU=256)."
  type        = number
  default     = 512
}

variable "daemon_tcp_port" {
  description = "TCP port the daemon binds inside its container. Runner tasks on the same VPC reach the daemon at this port. Exposed to operators via SSM port-forward (see the connect_hint output)."
  type        = number
  default     = 9000
}

variable "runner_cpu" {
  description = "CPU units reserved for a runner container."
  type        = number
  default     = 256
}

variable "runner_memory" {
  description = "Hard memory limit (MiB) for a runner container."
  type        = number
  default     = 1024
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

