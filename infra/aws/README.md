# Fleet Terraform module

Provisions everything Fleet needs to run coding-agent jobs in containers on your own AWS
account: an ECS cluster backed by an EC2 auto scaling group that scales to zero, the
Fleet daemon as an always-on Fargate service with durable `FLEET_HOME` state on EFS,
ECR repositories for the runner and project images, and CloudWatch log groups.

Spend is bounded structurally — the ASG floors at zero and caps at `max_instances`,
and core bounds each job's wall-clock. The unit provisions no billing products:
budget alarms are your account's own concern (`docs/decisions.md#d12`).

**Two-substrate design.** The daemon runs on Fargate (always-on, no EC2 pinned) while
worker jobs run on the EC2 capacity provider with managed ASG scaling — the ASG can
reach zero instances when the cluster is idle, and scale back out when a new job arrives.

**Access model: SSM only.** No security group accepts inbound traffic from the public
internet. Operators reach the daemon HTTP API via SSM port-forward (see the `connect_hint`
output for the exact command). Intra-VPC ingress rules:
- Runner tasks (instances SG) → daemon TCP port
- Daemon + instances → EFS NFS port (2049)

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
| `daemon_cpu` | `number` | `256` | CPU units for the daemon Fargate task (must be a valid Fargate value: 256/512/1024/2048/4096). |
| `daemon_memory` | `number` | `512` | Memory (MiB) for the daemon Fargate task (must be valid for the chosen CPU). |
| `daemon_tcp_port` | `number` | `9000` | TCP port the daemon binds inside its container; operators reach it via SSM port-forward. |
| `fleet_home_path` | `string` | `"/var/lib/fleet"` | Container path for `FLEET_HOME` (EFS-backed). |
| `log_retention_days` | `number` | `30` | CloudWatch log retention. |

## Outputs

| Name | Description |
|------|-------------|
| `cluster_arn` / `cluster_name` | The ECS cluster. |
| `daemon_service_name` | The daemon ECS service. |
| `runner_repository_url` | ECR URL for the fleet runner image. |
| `project_repository_urls` | Map of project repo name → ECR URL. |
| `efs_file_system_id` | EFS file system backing `FLEET_HOME`. |
| `vpc_id` | VPC deployed into (created or reused). |
| `connect_hint` | SSM port-forward commands (copy-paste) to tunnel the daemon HTTP port to localhost. |

## Notes

- The ECS-optimized Amazon Linux 2023 AMI is resolved at plan time from the public SSM
  parameter, so worker instances track the current recommended image.
- The worker capacity provider uses managed scaling with managed termination protection;
  ECS owns the ASG's desired capacity, and the cluster can idle at zero EC2 instances.
- The daemon runs on Fargate (its own substrate, separate from the worker ASG) so the
  worker ASG can reach zero while the daemon stays up. Runner tasks reach the daemon on
  `daemon_tcp_port` (default 9000) through the daemon security group; no inbound rule
  opens a path from outside the VPC.
- The daemon discovers its own private IP from the ECS container metadata endpoint at
  startup and advertises it in the `FLEET_DAEMON_URL` it passes to runner tasks — no
  static IP or service-discovery registration needed.
- The task role carries only the `ssmmessages` permissions needed for ECS exec plus
  `ssm:GetParameter` for the fleet-config read at boot; the execution role uses the
  AWS-managed `AmazonECSTaskExecutionRolePolicy`; the instance role combines
  `AmazonEC2ContainerServiceforEC2Role` with `AmazonSSMManagedInstanceCore`.
- Region is never hardcoded in the module; the example defaults to `us-east-1` via a
  variable.
