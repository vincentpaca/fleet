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
internet. Operators reach the daemon HTTP API via an SSM port-forward, which `fleet connect`
opens and holds (the `connect_hint` output is the same thing by hand). Intra-VPC ingress rules:

- Runner tasks (instances SG) → daemon TCP port
- Daemon + instances → EFS NFS port (2049)

## Bring-up

**1. Apply, and capture the deployment's own description — one command.** Run it from the
project that will dispatch jobs, not from this unit:

```sh
fleet setup infra                    # add --yes plus --name/--region/… to run it headless
```

The CLI owns this step. It interviews you for the values this unit's defaults cannot
assume (`name`, `region`, an optional existing VPC), generates
`.fleet/infra/aws/main.tf` consuming this module at a pinned git ref, shows you the
plan, applies on an explicit yes, and writes the `fleet_config` output to
`.fleet/infra/aws/fleet-config.json` — every value the image build and the rest of the
CLI need, including the `daemon_url` line step 3 used to ask you to paste in by hand.
State is local, beside the generated root module (`--backend` + `--backend-config` for a
real backend); `.fleet/infra/` is gitignored, so two people on one repo can point at
different deployments. `fleet setup infra --destroy` plans the teardown, shows what dies,
and takes it down on a yes.

Driving terraform yourself is still supported — the module is a module:

```sh
cd examples/basic && terraform init && terraform apply
mkdir -p <project>/.fleet/infra/aws
terraform -chdir=$PWD output -json fleet_config \
  > <project>/.fleet/infra/aws/fleet-config.json
```

**2. Publish both images and start the daemon on them — one command.**

```sh
<fleet-checkout>/images/build.sh --redeploy-daemon
```

That builds the runner base and the daemon image for **this deployment's**
architecture (`linux/amd64`; pass `--platform` to change it), tags them `:runner`
and `:daemon` — the tags this unit's task definitions pin — pushes both to the ECR
repository from `fleet_config`, and forces a new deployment of the daemon service so
it starts from the image just pushed. You never set `DOCKER_DEFAULT_PLATFORM`,
`docker tag`, or `aws ecs update-service` by hand.

**3. Open the tunnel.** `fleet setup infra` already wrote `"daemon_url":
"http://127.0.0.1:19000"` into `fleet-config.json` (any free local port works; `1` +
`daemon_tcp_port` is the convention — add it by hand if you captured the output
yourself). From the project directory:

```sh
fleet connect          # foreground; --detach to supervise in the background
```

It resolves the deployment from `fleet_config`, forwards `daemon_port` to the port
`daemon_url` names, verifies `/health`, and reopens the session when it dies —
re-resolving the daemon task, which a `force-new-deployment` replaces. `fleet doctor`
reports the tunnel's state; `connect_hint` is the same sequence to run by hand.

On an arm64 workstation the build is emulated, which needs binfmt registered.
Docker Desktop ships it; a plain arm64 Linux engine (a Graviton dev box) does not,
and without it the first `RUN` fails with `exec format error`. Register it once:

```sh
docker run --privileged --rm tonistiigi/binfmt --install amd64
```

`daemon_image` is still available if you would rather point the service at an image
you publish elsewhere.

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
| `connect_hint` | The SSM port-forward commands `fleet connect` runs, for when you want the tunnel by hand. |
| `fleet_config` | The unit's self-description: what the daemon reads at boot, what `images/build.sh` publishes to (`runner_repository_url`, `cluster`, `daemon_service`), and what `fleet connect` tunnels into (`daemon_container_name`, `daemon_port`). Capture it as `.fleet/infra/aws/fleet-config.json`. |

## Changing this unit

`fmt` and `validate` are not enough, and #9's bring-up proved it: `assign_public_ip`
carrying a string where the provider wants a bool passed both and died at apply, after
four paid attempts. Run every check below before an infra change ships — CI's terraform
job runs `fmt` and `validate` today, and the plan smoke is still yours to run until the
job learns it (`.github/workflows/tests.yml`, #48):

```sh
terraform fmt -check -recursive infra/
terraform -chdir=infra/aws/examples/basic init -backend=false -input=false
terraform -chdir=infra/aws/examples/basic validate
terraform -chdir=infra/aws init -backend=false -input=false   # then the plan smoke:
terraform -chdir=infra/aws test
npm test                                                      # API-only pins
```

`terraform test` plans the unit through all three network branches — public subnets, NAT
gateway, reused VPC — against a mocked AWS provider (`tests/plan.tftest.hcl`): no
credentials, no API calls, no state, but the real provider schema doing the rejecting. It
needs terraform ≥ 1.7 for `mock_provider`; the module itself still only requires 1.5.
Mocking has one cost worth knowing: data sources return canned values, so the unit's
`aws_iam_policy_document` assume-role documents are not rendered by this plan (policies
built with `jsonencode()` in the configuration are).

What a plan cannot see, because AWS enforces it in the API rather than in the provider
schema, is pinned in the Node suite instead (`test/infra-aws.test.ts`) — today the
character class AWS allows in a security-group description, group's and rule's alike,
which rejected a unicode arrow mid-apply. New constraint, same fork: schema-shaped goes in the plan
smoke, API-shaped goes in the suite.

## Notes

- The ECS-optimized Amazon Linux 2023 AMI is resolved at plan time from the public SSM
  parameter, so worker instances track the current recommended image.
- The worker capacity provider uses managed scaling with managed termination protection;
  ECS owns the ASG's desired capacity, and the cluster can idle at zero EC2 instances.
- The daemon runs on Fargate (its own substrate, separate from the worker ASG) so the
  worker ASG can reach zero while the daemon stays up. Runner tasks reach the daemon on
  `daemon_tcp_port` (default 9000) through the daemon security group; no inbound rule
  opens a path from outside the VPC.
- The daemon logs four `fleet daemon:`-prefixed lines at boot to its log group — `FLEET_HOME`,
  provider, config source (the fleet-config SSM parameter name, never its contents), and
  the listen address. The last line is the one that says it is up: a task stream with the
  first three and no `listening on` is stuck before bind, so read the stream before
  reaching for `ecs execute-command`.
- The daemon discovers its own private IP from the ECS container metadata endpoint at
  startup and advertises it in the `FLEET_DAEMON_URL` it passes to runner tasks — no
  static IP or service-discovery registration needed.
- The task role carries only the `ssmmessages` permissions needed for ECS exec plus
  `ssm:GetParameter` for the fleet-config read at boot; the execution role uses the
  AWS-managed `AmazonECSTaskExecutionRolePolicy`; the instance role combines
  `AmazonEC2ContainerServiceforEC2Role` with `AmazonSSMManagedInstanceCore`.
- Region is never hardcoded in the module; the example defaults to `us-east-1` via a
  variable.
