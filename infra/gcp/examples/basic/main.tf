terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

variable "project" {
  description = "GCP project to deploy Fleet into."
  type        = string
  default     = "my-project"
}

variable "region" {
  description = "GCP region to deploy Fleet into."
  type        = string
  default     = "us-central1"
}

provider "google" {
  project = var.project
  region  = var.region
}

module "fleet" {
  source = "../.."

  # Pin the daemon at an exact ownfleet npm version; `fleet setup infra`
  # supplies the CLI's own version here.
  fleet_version = "0.2.0"
}

output "runner_repository_url" {
  value = module.fleet.runner_repository_url
}

output "connect_hint" {
  value = module.fleet.connect_hint
}

# The capture every bring-up step starts from:
#   terraform -chdir=<fleet-checkout>/infra/gcp/examples/basic output -json fleet_config \
#     > .fleet/infra/gcp/fleet-config.json
# Module outputs are not addressable from a root module, so this passthrough is
# what makes that command work at all. test/cloud-agnostic.test.ts requires it.
output "fleet_config" {
  value = module.fleet.fleet_config
}
