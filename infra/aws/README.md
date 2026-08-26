# Fleet Terraform module

Provisions everything Fleet needs to run your own harness jobs in containers on your own AWS
account: an ECS cluster backed by an EC2 auto scaling group that scales to zero, the
Fleet daemon as an always-on Fargate service with durable `FLEET_HOME` state on EFS,
ECR repositories for the runner and project images, and CloudWatch log groups.

Spend is bounded structurally — the ASG floors at `min_instances` (default 0) and caps
at `max_instances`, and core bounds each job's wall-clock. The unit provisions no billing
products: budget alarms are your account's own concern (`docs/decisions.md#d12`).

**Two-substrate design.** The daemon runs on Fargate (always-on, no EC2 pinned) while
worker jobs run on the EC2 capacity provider with managed ASG scaling — the ASG can
reach zero instances when the cluster is idle, and scale back out when a new job arrives.
Operators who dispatch often can trade that for speed with a
[warm capacity floor](#warm-capacity-floor).

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

## Operations

**Break-glass access to a worker instance** (a wedged job, an exited container
holding unpushed work): every worker runs the SSM agent — user_data enables it,
the instance role already carries `AmazonSSMManagedInstanceCore`, and no SSH or
inbound rule exists by design — so a shell on the box is one line:

```sh
aws ssm start-session --target <instance-id> --region <region>
```

Verify registration after a fresh apply: a worker should appear in
`aws ssm describe-instance-information --region <region>` within a few minutes
of launching. An instance that never appears there has no rescue path — treat
that as a deployment bug, not a quirk.

## Upgrading an existing deployment: the EFS access point moves FLEET_HOME

**If you deployed before the daemon dropped root (#156), applying this unit makes your
existing daemon state invisible until you move it. Read this before you apply.**

The daemon container now runs as uid 1000, and its EFS volume mounts through an
access point (`aws_efs_access_point.fleet_home`) that roots the mount at
`/fleet-home` inside the filesystem, owned `1000:1000`. Deployments that predate the
access point wrote `FLEET_HOME` at the EFS filesystem root. That data is not deleted
by the upgrade — but the access point does not show it: the upgraded daemon boots
against an empty `/fleet-home` and starts fresh, with every existing job record still
sitting at the root where the new mount cannot see it.

The unit performs no data migration — moving live state is an operator's call, not a
`terraform apply` side effect. To carry your state across:

1. Scale the daemon service to zero so nothing writes during the move
   (`aws ecs update-service --cluster <cluster> --service <name>-daemon --desired-count 0`).
2. Mount the filesystem root *without* the access point from any host or task inside
   the VPC (the mount targets accept NFS only from the instances and daemon security
   groups — a container instance already in the cluster works).
3. Move everything at the root into the access point's directory and hand it to the
   daemon's uid: `mkdir -p /mnt/efs/fleet-home && mv /mnt/efs/<contents> /mnt/efs/fleet-home/`
   then `chown -R 1000:1000 /mnt/efs/fleet-home`.
4. Scale the daemon back to one. It boots on the moved state; `daemon.lock` from the
   old task is reclaimed by the heartbeat logic, not by you.

A fresh deployment needs none of this: the access point creates `/fleet-home` with
the right ownership on first mount.

## Inputs

| Name | Type | Default | Description |
| ------ | ------ | --------- | ------------- |
| `name` | `string` | `"fleet"` | Prefix for every resource name. |
| `tags` | `map(string)` | `{}` | Extra tags for all taggable resources. |
| `vpc_id` | `string` | `null` | Existing VPC to reuse; `null` creates a dedicated VPC. |
| `subnet_ids` | `list(string)` | `[]` | Subnets to use when `vpc_id` is set (instances, daemon, EFS mount targets). |
| `vpc_cidr` | `string` | `"10.42.0.0/16"` | CIDR for the module-created VPC. |
| `az_count` | `number` | `2` | AZs / subnets per tier for the module-created VPC. |
| `enable_nat_gateway` | `bool` | `false` | `true`: private subnets behind NAT; `false`: public subnets with public-IP egress. Never any inbound either way. |
| `instance_type` | `string` | `"t3.xlarge"` | EC2 instance type for container instances. Moves together with `offered_*` and `runner_*` (one tier). 2-vCPU boxes starve suite-heavy jobs into their wall-clock budgets (#191); Spot price difference is cents per job-hour. |
| `max_instances` | `number` | `4` | ASG maximum (must be ≥ 1, and ≥ `min_instances`). |
| `min_instances` | `number` | `0` | Warm capacity floor: instances kept running at idle so a job skips the ~3-4 min cold start. **Each always-on `t3.medium` bills 24/7 — roughly $30/mo, more than the rest of a Fleet deployment combined.** See [Warm capacity floor](#warm-capacity-floor). |
| `on_demand_base_capacity` | `number` | `0` | Instances always launched on-demand before the Spot split applies. See [Spot by default](#spot-by-default). |
| `on_demand_percentage_above_base` | `number` | `0` | Percentage of capacity above the base that is on-demand (0 = all Spot, 100 = all on-demand). See [Spot by default](#spot-by-default). |
| `scaling_cooldown_seconds` | `number` | `300` | ASG cooldown between scaling events. Raise it if jobs die to aggressive scale-in. |
| `offered_cpu_units` | `number` | `4096` | Largest CPU request (ECS units) a single runner task may make; the daemon rejects bigger manifests at dispatch. Size to `instance_type`. |
| `offered_memory_mib` | `number` | `15360` | Largest memory request (MiB) a single runner task may make; sized to leave ~1 GiB headroom for the ECS agent on `instance_type`. |
| `project_repos` | `list(string)` | `[]` | Extra ECR repositories, one per project image. |
| `daemon_image` | `string` | `""` | Daemon container image; empty means `<runner repo>:daemon`. |
| `daemon_cpu` | `number` | `256` | CPU units for the daemon Fargate task (must be a valid Fargate value: 256/512/1024/2048/4096). |
| `daemon_memory` | `number` | `512` | Memory (MiB) for the daemon Fargate task (must be valid for the chosen CPU — the unit rejects an invalid pairing at plan). |
| `daemon_tcp_port` | `number` | `9000` | TCP port the daemon binds inside its container; operators reach it via SSM port-forward. |
| `runner_cpu` | `number` | `4096` | CPU units for a runner task when the manifest requests nothing — defaults to the full offered tier (one job per instance). Must not exceed `offered_cpu_units` (plan-time precondition). |
| `runner_memory` | `number` | `15360` | Hard memory limit (MiB) for a runner task when the manifest requests nothing — full offered tier. Must not exceed `offered_memory_mib` (plan-time precondition). |
| `fleet_home_path` | `string` | `"/var/lib/fleet"` | Container path for `FLEET_HOME` (EFS-backed). |
| `log_retention_days` | `number` | `30` | CloudWatch log retention. |

### Spot by default

With the defaults — `on_demand_base_capacity = 0` and
`on_demand_percentage_above_base = 0` — **every worker instance is a Spot
instance**. That is the cheap end of a real trade-off, and it is deliberate:
worker capacity exists only while jobs run, and Spot is a fraction of the
on-demand price for interruptible batch work. The cost is interruption: AWS can
reclaim a Spot instance with a two-minute warning, and the unit wires no
lifecycle hook or Capacity Rebalancing, so a reclaim kills any job mid-run. The
daemon sees the dead task only as a stall and settles the job as cancelled —
the work is lost and must be re-dispatched by hand.

Five knobs shape the exposure:

- `on_demand_base_capacity` — instances that are always on-demand. Set to 1+
  for a guaranteed baseline that reclaims cannot touch.
- `on_demand_percentage_above_base` — the split for everything above the base.
  `100` makes every worker on-demand: no reclaims, full price. A middle value
  mixes the fleet so one reclaim wave cannot take every running job.
- `max_instances` — bounds how many jobs (and therefore how much re-run cost a
  reclaim wave can create) run at once.
- `scaling_cooldown_seconds` — reclaims are not the only mid-run killer;
  aggressive scale-in is the other. Raise this if jobs die while the cluster
  shrinks.
- `instance_type` — Spot reclaim rates differ by pool; a less popular type in
  your region is reclaimed less often.

If a lost job costs you more than the on-demand premium — long jobs, jobs that
are expensive to re-prompt — set `on_demand_percentage_above_base = 100` and
pay for certainty.

### Warm capacity floor

By default the worker ASG scales to zero: idle costs nothing, and the price is
a cold start on the first job of a burst — instance boot plus runner-image
pull, roughly 3-4 minutes before the runner's first event. `min_instances`
raises the floor: the ASG keeps that many instances running at idle, and a
warm instance already holds the runner image, so warm-start is task start —
the first delegate's runner emits its first event in seconds rather than
minutes.

The cost, stated plainly: **a warm instance bills 24/7 whether or not a job
ever arrives. Each always-on `t3.medium` is roughly $30/mo — more than the
rest of a Fleet deployment (Fargate daemon, EFS, logs) combined.** That is why
the default is 0 and stays 0: scale-to-zero is a design commitment, not a
suggestion. Raise the floor only if you dispatch often enough that the wait
costs you more than the instance does. Setting it back to 0 returns the ASG to
scale-to-zero.

Two interactions to know:

- With the Spot defaults above, warm floor instances are Spot too — a reclaim
  can take your warm instance and the next job cold-starts anyway. Pair the
  floor with `on_demand_base_capacity >= min_instances` for a floor reclaims
  cannot touch (at the on-demand price).
- `fleet_config` carries `min_instances`, so tooling reading the deployment's
  self-description can tell paid-for warm capacity from scale-in lag when it
  sees instances at idle.

## Outputs

| Name | Description |
| ------ | ------------- |
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
job runs all of them, plan smoke included (`.github/workflows/tests.yml`, #48), but
locally first is the fast loop:

```sh
terraform fmt -check -recursive infra/
terraform -chdir=infra/aws/examples/basic init -backend=false -input=false
terraform -chdir=infra/aws/examples/basic validate
terraform -chdir=infra/aws init -backend=false -input=false   # then the plan smoke:
terraform -chdir=infra/aws test
npm test                                                      # API-only pins
```

### Shared provider plugin cache

Do the one-time setup below before the first `init`, or every `.terraform/` directory
gets its own ~780MB copy of the AWS provider — this unit, `examples/basic`, and a
`.fleet/infra/aws` deployment already make three, 2.3GB of a dev checkout (#131), and
each future unit or example adds another:

```sh
mkdir -p ~/.terraform.d/plugin-cache
export TF_PLUGIN_CACHE_DIR="$HOME/.terraform.d/plugin-cache"   # put it in your shell profile
```

(Or the config-file equivalent, `plugin_cache_dir = "$HOME/.terraform.d/plugin-cache"`
in `~/.terraformrc`.) With the cache set, `init` installs the provider into the shared
cache once and every `.terraform/` holds a symlink into it — one copy on disk no matter
how many directories initialize.

One caveat, because this repo gitignores `.terraform.lock.hcl`: a directory without a
lock file still *downloads* the provider from the registry on its first `init` — since
Terraform 1.4, a provider absent from the lock file is never trusted straight from the
cache ([provider_installation docs](https://developer.hashicorp.com/terraform/cli/config/config-file#provider-plugin-cache)) —
but the download lands in the shared cache and the `.terraform/` dir gets the symlink,
so disk stays at one copy either way; only the network fetch repeats. Once the
directory's lock file exists, re-`init` resolves entirely from the cache.

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
