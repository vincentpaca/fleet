terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "region" {
  description = "AWS region to deploy Fleet into."
  type        = string
  default     = "us-east-1"
}

provider "aws" {
  region = var.region
}

module "fleet" {
  source = "../.."

  project_repos = ["acme-app"]
}

output "cluster_name" {
  value = module.fleet.cluster_name
}

output "runner_repository_url" {
  value = module.fleet.runner_repository_url
}

output "connect_hint" {
  value = module.fleet.connect_hint
}

# The capture every bring-up step starts from:
#   terraform -chdir=<fleet-checkout>/infra/aws/examples/basic output -json fleet_config \
#     > .fleet/infra/aws/fleet-config.json
# Module outputs are not addressable from a root module, so this passthrough is
# what makes that command work at all. test/cloud-agnostic.test.ts requires it.
output "fleet_config" {
  value = module.fleet.fleet_config
}
