output "cluster_arn" {
  description = "ARN of the ECS cluster."
  value       = aws_ecs_cluster.this.arn
}

output "cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.this.name
}

output "daemon_service_name" {
  description = "Name of the daemon ECS service."
  value       = aws_ecs_service.daemon.name
}

output "runner_repository_url" {
  description = "ECR repository URL for the fleet runner image."
  value       = aws_ecr_repository.runner.repository_url
}

output "project_repository_urls" {
  description = "Map of project repository name to ECR repository URL."
  value       = { for name, repo in aws_ecr_repository.project : name => repo.repository_url }
}

output "efs_file_system_id" {
  description = "EFS file system backing FLEET_HOME."
  value       = aws_efs_file_system.fleet_home.id
}

output "vpc_id" {
  description = "VPC the module deployed into (created or reused)."
  value       = local.vpc_id
}

output "connect_hint" {
  description = "Manual SSM port-forward commands, the documented fallback for `fleet connect` (which does all of this and reopens the session when it dies). No security-group rule opens an inbound path from the internet; access is via SSM only. Run each line in order."
  value       = <<-EOT
    # `fleet connect` does all of this from fleet_config and holds the session
    # open across SSM timeouts and service deployments. These steps are the
    # fallback for when you want the tunnel without the CLI.

    # 1. Find the running daemon task ARN.
    TASK=$(aws ecs list-tasks \
      --cluster ${aws_ecs_cluster.this.name} \
      --service-name ${aws_ecs_service.daemon.name} \
      --query 'taskArns[0]' --output text)

    # 2. Get the container runtime ID (needed for the SSM target string).
    RUNTIME_ID=$(aws ecs describe-tasks \
      --cluster ${aws_ecs_cluster.this.name} \
      --tasks "$TASK" \
      --query "tasks[0].containers[?name=='${local.daemon_container_name}'].runtimeId" \
      --output text)

    # 3. Open the SSM port-forward session. The daemon HTTP API is then
    #    reachable at http://localhost:1${var.daemon_tcp_port} on your machine.
    #    The SSM target is underscore-separated (its API regex rejects commas).
    #    localPortNumber is deliberately NOT ${var.daemon_tcp_port}: local
    #    agents commonly squat low ports and accept connections silently —
    #    pick any free local port and point fleet-config.json's daemon_url
    #    at it.
    aws ssm start-session \
      --target "ecs:${aws_ecs_cluster.this.name}_$${TASK##*/}_$RUNTIME_ID" \
      --document-name AWS-StartPortForwardingSessionToRemoteHost \
      --parameters '{"host":["localhost"],"portNumber":["${var.daemon_tcp_port}"],"localPortNumber":["1${var.daemon_tcp_port}"]}'
  EOT
}

output "fleet_config" {
  description = "The unit's shape, self-described for Fleet's runtime provider. Every infra unit must expose this output (test/cloud-agnostic.test.ts): it is the contract that lets Fleet predict the infrastructure it created instead of discovering it. Defined once as local.fleet_config in main.tf and published both here and as the SSM parameter the daemon reads at boot — same bytes, never two copies."
  value       = local.fleet_config
}
