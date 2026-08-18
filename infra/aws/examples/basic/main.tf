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
