output "runner_repository_url" {
  description = "Artifact Registry image path for the fleet runner image (push as <url>:runner)."
  value       = local.runner_repository_url
}

output "daemon_instance_name" {
  description = "Name of the daemon VM."
  value       = google_compute_instance.daemon.name
}

output "daemon_internal_ip" {
  description = "Reserved static internal address the daemon advertises to jobs. Survives VM replacement (fleet upgrade)."
  value       = google_compute_address.daemon.address
}

output "connect_hint" {
  description = "Manual IAP tunnel command, the documented fallback for `fleet connect` (which does all of this and reopens the session when it dies). No firewall rule opens a path from outside the IAP range; access is via IAP only."
  value       = <<-EOT
    # `fleet connect` does all of this from fleet_config and holds the session
    # open. This is the fallback for when you want the tunnel without the CLI.

    # Hold the IAP tunnel open in the foreground (Ctrl-C ends it). The daemon
    # HTTP API is then reachable at http://localhost:1${var.daemon_port} on
    # your machine. The local port is deliberately NOT ${var.daemon_port}:
    # local agents commonly squat low ports and accept connections silently —
    # pick any free local port and point fleet-config.json's daemon_url at it.
    gcloud compute start-iap-tunnel ${google_compute_instance.daemon.name} ${var.daemon_port} \
      --local-host-port=localhost:1${var.daemon_port} \
      --zone ${local.zone} --project ${local.project}
  EOT
}

output "fleet_config" {
  description = "The unit's shape, self-described for Fleet's runtime provider. Every infra unit must expose this output (test/cloud-agnostic.test.ts): it is the contract that lets Fleet predict the infrastructure it created instead of discovering it. Defined once as local.fleet_config in main.tf."
  value       = local.fleet_config
}
