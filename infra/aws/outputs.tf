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
  description = "How to open a shell in the running daemon via SSM (ECS exec) — no inbound network access exists."
  value       = <<-EOT
    TASK=$(aws ecs list-tasks --cluster ${aws_ecs_cluster.this.name} --service-name ${aws_ecs_service.daemon.name} --query 'taskArns[0]' --output text)
    aws ecs execute-command --cluster ${aws_ecs_cluster.this.name} --task "$TASK" --container ${var.name}-daemon --interactive --command /bin/sh
  EOT
}

output "fleet_config" {
  description = "The unit's shape, self-described for Fleet's runtime provider. Every infra unit must expose this output (test/cloud-agnostic.test.ts): it is the contract that lets Fleet predict the infrastructure it created instead of discovering it."
  value = {
    provider               = "ecs"
    cluster                = aws_ecs_cluster.this.name
    capacity_provider      = aws_ecs_capacity_provider.ec2.name
    runner_repository_url  = aws_ecr_repository.runner.repository_url
    runner_task_definition = aws_ecs_task_definition.runner.family
    runner_container_name  = local.runner_container_name
    runner_log_group       = aws_cloudwatch_log_group.runner.name
    # Runner tasks use bridge networking on EC2; ecs run-task must not receive
    # --network-configuration for bridge-mode tasks.  Subnets and security groups
    # are intentionally empty in both this output and the SSM fleet-config parameter
    # so the values remain consistent and consumers do not pass them to run-task.
    # A future Fargate unit would populate these from its own VPC/SG resources.
    subnets         = []
    security_groups = []
    launch_type     = "EC2"
    ssm_config_path = aws_ssm_parameter.fleet_config.name
    # Offered capacity tiers: the daemon rejects manifests whose limits.resources
    # exceed every tier here at dispatch time.  Operators set offered_cpu_units /
    # offered_memory_mib to match their actual instance type; the defaults match
    # a t3.medium leaving ~512 MiB for the ECS agent and OS.
    capacity_tiers = [{ cpu = var.offered_cpu_units, memory = var.offered_memory_mib }]
  }
}
