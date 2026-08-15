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
