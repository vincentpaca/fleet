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
  description = "CPU units reserved for the daemon container."
  type        = number
  default     = 256
}

variable "daemon_memory" {
  description = "Hard memory limit (MiB) for the daemon container."
  type        = number
  default     = 512
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

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget in USD; notifications fire at 80% actual and 100% forecasted spend."
  type        = number
  default     = 200
}

variable "budget_email" {
  description = "Email address subscribed to budget notifications."
  type        = string
  default     = "ops@example.com"
}
