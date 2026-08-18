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
  description = "SSM port-forward command to tunnel the daemon HTTP port to localhost. No security-group rule opens an inbound path from the internet; access is via SSM only. Run each line in order."
  value       = <<-EOT
    # 1. Find the running daemon task ARN.
    TASK=$(aws ecs list-tasks \
      --cluster ${aws_ecs_cluster.this.name} \
      --service-name ${aws_ecs_service.daemon.name} \
      --query 'taskArns[0]' --output text)

    # 2. Get the container runtime ID (needed for the SSM target string).
    RUNTIME_ID=$(aws ecs describe-tasks \
      --cluster ${aws_ecs_cluster.this.name} \
      --tasks "$TASK" \
      --query "tasks[0].containers[?name=='${var.name}-daemon'].runtimeId" \
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
  description = "The unit's shape, self-described for Fleet's runtime provider. Every infra unit must expose this output (test/cloud-agnostic.test.ts): it is the contract that lets Fleet predict the infrastructure it created instead of discovering it."
  value = {
    provider = "ecs"
    cluster  = aws_ecs_cluster.this.name
    # capacity_provider drives --capacity-provider-strategy in run-task so managed
    # ASG scaling fires for every worker job.
    capacity_provider = aws_ecs_capacity_provider.ec2.name
    # daemon_service names the service that runs the :daemon tag, so publishing a
    # new image can roll it (images/build.sh --redeploy-daemon) without the
    # operator naming infrastructure Fleet already created.
    daemon_service         = aws_ecs_service.daemon.name
    runner_repository_url  = aws_ecr_repository.runner.repository_url
    runner_task_definition = aws_ecs_task_definition.runner.family
    runner_container_name  = local.runner_container_name
    runner_log_group       = aws_cloudwatch_log_group.runner.name
    # Runner tasks use bridge networking on EC2; ecs run-task must not receive
    # --network-configuration for bridge-mode tasks.  Subnets and security groups
    # are intentionally empty in both this output and the SSM fleet-config parameter
    # so the values remain consistent and consumers do not pass them to run-task.
    subnets         = []
    security_groups = []
    ssm_config_path = aws_ssm_parameter.fleet_config.name
    # Offered capacity tiers: the daemon rejects manifests whose limits.resources
    # exceed every tier here at dispatch time.  Operators set offered_cpu_units /
    # offered_memory_mib to match their actual instance type; the defaults match
    # a t3.medium leaving ~512 MiB for the ECS agent and OS.
    capacity_tiers = [{ cpu = var.offered_cpu_units, memory = var.offered_memory_mib }]
  }
}
