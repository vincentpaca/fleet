# Fleet Terraform module

Provisions everything Fleet needs to run coding-agent jobs in containers on your own AWS
account: an ECS cluster backed by an EC2 auto scaling group that scales to zero, ECR
repositories for the runner and project images, the Fleet daemon as an always-on ECS
service with durable `FLEET_HOME` state on EFS, CloudWatch log groups, and a monthly
cost budget with email alerts.

**Access model: SSM only.** No security group accepts inbound traffic from outside the
VPC. Instances register with SSM Session Manager; you reach the daemon with
`aws ecs execute-command` (see the `connect_hint` output). The single intra-VPC ingress
rule is NFS (2049) from the instance security group to the EFS mount targets — required
for the `FLEET_HOME` volume to mount at all.

## One-command apply

```sh
cd examples/basic && terraform init && terraform apply
```

Then push a daemon image to the runner repository with the `daemon` tag (or set
`daemon_image`), and the service starts it automatically.

## Inputs

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `name` | `string` | `"fleet"` | Prefix for every resource name. |
| `tags` | `map(string)` | `{}` | Extra tags for all taggable resources. |
| `vpc_id` | `string` | `null` | Existing VPC to reuse; `null` creates a dedicated VPC. |
| `subnet_ids` | `list(string)` | `[]` | Subnets to use when `vpc_id` is set (instances, daemon, EFS mount targets). |
| `vpc_cidr` | `string` | `"10.42.0.0/16"` | CIDR for the module-created VPC. |
| `az_count` | `number` | `2` | AZs / subnets per tier for the module-created VPC. |
| `enable_nat_gateway` | `bool` | `false` | `true`: private subnets behind NAT; `false`: public subnets with public-IP egress. Never any inbound either way. |
| `instance_type` | `string` | `"t3.medium"` | EC2 instance type for container instances. |
| `max_instances` | `number` | `4` | ASG maximum (minimum is always 0). |
| `project_repos` | `list(string)` | `[]` | Extra ECR repositories, one per project image. |
| `daemon_image` | `string` | `""` | Daemon container image; empty means `<runner repo>:daemon`. |
| `daemon_cpu` | `number` | `256` | CPU units for the daemon container. |
| `daemon_memory` | `number` | `512` | Memory limit (MiB) for the daemon container. |
| `fleet_home_path` | `string` | `"/var/lib/fleet"` | Container path for `FLEET_HOME` (EFS-backed). |
| `log_retention_days` | `number` | `30` | CloudWatch log retention. |
| `monthly_budget_usd` | `number` | `200` | Monthly cost budget in USD. |
| `budget_email` | `string` | `"ops@example.com"` | Recipient for budget notifications (80% actual, 100% forecasted). |

## Outputs

| Name | Description |
|------|-------------|
| `cluster_arn` / `cluster_name` | The ECS cluster. |
| `daemon_service_name` | The daemon ECS service. |
| `runner_repository_url` | ECR URL for the fleet runner image. |
| `project_repository_urls` | Map of project repo name → ECR URL. |
| `efs_file_system_id` | EFS file system backing `FLEET_HOME`. |
| `vpc_id` | VPC deployed into (created or reused). |
| `connect_hint` | Copy-paste SSM/ECS-exec command to shell into the daemon. |

## Notes

- The ECS-optimized Amazon Linux 2023 AMI is resolved at plan time from the public SSM
  parameter, so instances track the current recommended image.
- The capacity provider uses managed scaling with managed termination protection; ECS
  owns the ASG's desired capacity, and the cluster idles at zero instances.
- The task role carries only the `ssmmessages` permissions needed for ECS exec; the
  execution role uses the AWS-managed `AmazonECSTaskExecutionRolePolicy`; the instance
  role combines `AmazonEC2ContainerServiceforEC2Role` with `AmazonSSMManagedInstanceCore`.
- Region is never hardcoded in the module; the example defaults to `us-east-1` via a
  variable.
