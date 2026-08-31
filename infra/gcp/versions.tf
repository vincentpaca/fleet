terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    # The in-account image build's config file: `ImageBuild.start`
    # (src/cli/setup-units.ts) is synchronous and argv-only, so the cloudbuild
    # config cannot be generated at run time — terraform writes it beside the
    # captured fleet-config.json and the argv points at that path. No provider
    # block is needed anywhere: `local` takes no configuration.
    local = {
      source  = "hashicorp/local"
      version = "~> 2.4"
    }
  }
}
