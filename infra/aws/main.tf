data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  create_vpc = var.vpc_id == null
  vpc_id     = local.create_vpc ? aws_vpc.this[0].id : var.vpc_id

  # Instances, the daemon task, and EFS mount targets all live in these subnets.
  subnet_ids = local.create_vpc ? (
    var.enable_nat_gateway ? aws_subnet.private[*].id : aws_subnet.public[*].id
  ) : var.subnet_ids
  subnet_count = local.create_vpc ? var.az_count : length(var.subnet_ids)

  daemon_image          = var.daemon_image != "" ? var.daemon_image : "${aws_ecr_repository.runner.repository_url}:daemon"
  runner_container_name = "${var.name}-runner"
  # Named once: `fleet connect` builds its SSM target from this container's
  # runtime id and resolves it through this service, so the resources and
  # fleet_config can never disagree about either name. Plain expressions, not
  # resource attributes: local.fleet_config is published as the SSM parameter
  # the daemon service reads at boot, and referencing the service from it would
  # be a dependency cycle.
  daemon_container_name = "${var.name}-daemon"
  daemon_service_name   = "${var.name}-daemon"
  fleet_config_ssm_path = "/${var.name}/fleet-config"

  # Fargate daemon: assign a public IP when subnets are public (no NAT gateway)
  # so the task can pull its image from ECR and write logs to CloudWatch.
  # With a NAT gateway (private subnets) a public IP is not needed.
  # Bool, not the run-task CLI's ENABLED/DISABLED strings: aws_ecs_service's
  # network_configuration takes a bool, and validate cannot catch the mismatch
  # (the local's value only meets the provider schema at plan time).
  daemon_assign_public_ip = local.create_vpc ? (var.enable_nat_gateway ? false : true) : true

  tags = merge(var.tags, { "fleet:module" = var.name })
}

# --- VPC (created only when var.vpc_id is null) ------------------------------

resource "aws_vpc" "this" {
  count = local.create_vpc ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id
  tags   = merge(local.tags, { Name = var.name })
}

resource "aws_subnet" "public" {
  count = local.create_vpc ? var.az_count : 0

  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.tags, { Name = "${var.name}-public-${count.index}" })
}

resource "aws_route_table" "public" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this[0].id
  }

  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  count = local.create_vpc ? var.az_count : 0

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_subnet" "private" {
  count = local.create_vpc && var.enable_nat_gateway ? var.az_count : 0

  vpc_id            = aws_vpc.this[0].id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 8)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(local.tags, { Name = "${var.name}-private-${count.index}" })
}

resource "aws_eip" "nat" {
  count = local.create_vpc && var.enable_nat_gateway ? 1 : 0

  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name}-nat" })
}

resource "aws_nat_gateway" "this" {
  count = local.create_vpc && var.enable_nat_gateway ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags       = merge(local.tags, { Name = var.name })
  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count = local.create_vpc && var.enable_nat_gateway ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[0].id
  }

  tags = merge(local.tags, { Name = "${var.name}-private" })
}

resource "aws_route_table_association" "private" {
  count = local.create_vpc && var.enable_nat_gateway ? var.az_count : 0

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

# --- Security groups ----------------------------------------------------------
# Access is SSM-only: nothing accepts inbound traffic from outside the VPC.
# Intra-VPC ingress rules:
#   - Runner tasks → daemon TCP port (instances SG → daemon SG)
#   - Daemon + instances → EFS NFS port (both SGs → efs SG)

resource "aws_security_group" "instances" {
  name        = "${var.name}-instances"
  description = "Fleet ECS container instances: egress only, no public inbound"
  vpc_id      = local.vpc_id

  egress {
    description = "All outbound (ECR, CloudWatch, SSM, EFS, daemon)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${var.name}-instances" })
}

resource "aws_security_group" "daemon" {
  name        = "${var.name}-daemon"
  description = "Fleet daemon Fargate task: TCP from runner instances only, no public inbound"
  vpc_id      = local.vpc_id

  ingress {
    # AWS restricts SG rule descriptions to ^[0-9A-Za-z_ .:/()#,@[]+=&;{}!$*-]*$
    # — no unicode arrows, no angle brackets. Plain words only.
    description     = "Runner tasks to daemon HTTP (private VPC only)"
    from_port       = var.daemon_tcp_port
    to_port         = var.daemon_tcp_port
    protocol        = "tcp"
    security_groups = [aws_security_group.instances.id]
  }

  egress {
    description = "All outbound (ECR, CloudWatch, SSM, EFS, ECS run-task)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${var.name}-daemon" })
}

resource "aws_security_group" "efs" {
  name        = "${var.name}-efs"
  description = "Fleet EFS mount targets: NFS from container instances and daemon task only"
  vpc_id      = local.vpc_id

  ingress {
    description     = "NFS from Fleet container instances and daemon task"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.instances.id, aws_security_group.daemon.id]
  }

  tags = merge(local.tags, { Name = "${var.name}-efs" })
}

# --- ECR ----------------------------------------------------------------------

resource "aws_ecr_repository" "runner" {
  name = "${var.name}-runner"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

resource "aws_ecr_repository" "project" {
  for_each = toset(var.project_repos)

  name = each.value

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

# --- IAM ----------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# Runner task role: deliberately minimal — only the SSM messaging channels
# required for `aws ecs execute-command` (the SSM-only access path). Dispatch
# powers live on the daemon role below and must never appear here: a job
# container able to run or stop tasks defeats the sandbox the same way an
# agent answering its own decision would.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "task_ecs_exec" {
  name = "ecs-exec-ssm-channel"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      },
    ]
  })
}

# Daemon role: the coordinator's own identity, separate from the runner task
# role above. It reads the fleet-config parameter at boot and dispatches
# runner tasks; scoped to this cluster and the runner task definition only.
resource "aws_iam_role" "daemon" {
  name               = "${var.name}-daemon"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "daemon_ecs_exec" {
  name = "ecs-exec-ssm-channel"
  role = aws_iam_role.daemon.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role_policy" "daemon_ssm_config" {
  name = "ssm-fleet-config-read"
  role = aws_iam_role.daemon.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.fleet_config.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "daemon_dispatch" {
  name = "ecs-dispatch"
  role = aws_iam_role.daemon.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = "${aws_ecs_task_definition.runner.arn_without_revision}:*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.this.arn } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:StopTask"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.this.arn } }
      },
      {
        # run-task hands the runner its task and execution roles; the daemon
        # may pass exactly those two, to ECS tasks only.
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.task.arn, aws_iam_role.task_execution.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
    ]
  })
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "instance_ecs" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role_policy_attachment" "instance_ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
  tags = local.tags
}

# --- ECS cluster + EC2 capacity ------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = var.name
  tags = local.tags
}

data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

resource "aws_launch_template" "instances" {
  name_prefix   = "${var.name}-"
  image_id      = data.aws_ssm_parameter.ecs_ami.value
  instance_type = var.instance_type

  vpc_security_group_ids = [aws_security_group.instances.id]

  iam_instance_profile {
    name = aws_iam_instance_profile.instance.name
  }

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # containers need the instance role via IMDS
  }

  user_data = base64encode(<<-EOT
    #!/bin/bash
    echo "ECS_CLUSTER=${aws_ecs_cluster.this.name}" >> /etc/ecs/ecs.config
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "${var.name}-instance" })
  }

  tags = local.tags
}

resource "aws_autoscaling_group" "instances" {
  name                = "${var.name}-instances"
  min_size            = 0
  max_size            = var.max_instances
  desired_capacity    = 0
  vpc_zone_identifier = local.subnet_ids

  # Required for ECS managed termination protection.
  protect_from_scale_in = true

  # Scale-in cooldown: how long after a scale-in event before the next one.
  # Increase if jobs are being terminated mid-run by aggressive scale-in.
  default_cooldown = var.scaling_cooldown_seconds

  # Mixed instances policy: controls on-demand vs spot split.
  # on_demand_base_capacity: instances always on-demand (for baseline reliability).
  # on_demand_percentage_above_base: 0 = all additional capacity is spot; 100 = all on-demand.
  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = var.on_demand_base_capacity
      on_demand_percentage_above_base_capacity = var.on_demand_percentage_above_base
    }

    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.instances.id
        version            = "$Latest"
      }
    }
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity] # ECS managed scaling owns this
  }
}

resource "aws_ecs_capacity_provider" "ec2" {
  name = "${var.name}-ec2"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.instances.arn
    managed_termination_protection = "ENABLED"

    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 1
    }
  }

  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = [aws_ecs_capacity_provider.ec2.name]

  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.ec2.name
    weight            = 1
  }
}

# --- EFS (FLEET_HOME durable state) ---------------------------------------------

resource "aws_efs_file_system" "fleet_home" {
  encrypted = true

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = merge(local.tags, { Name = "${var.name}-home" })
}

resource "aws_efs_mount_target" "fleet_home" {
  count = local.subnet_count

  file_system_id  = aws_efs_file_system.fleet_home.id
  subnet_id       = local.subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}

# --- CloudWatch logs -------------------------------------------------------------

resource "aws_cloudwatch_log_group" "daemon" {
  name              = "/${var.name}/daemon"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/${var.name}/runner"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# --- Runner task definition -------------------------------------------------------
# Each job runs as a one-off ecs run-task using this definition as the template.
# The runner image is the same ECR repository as the daemon but with the "runner"
# tag.  The daemon reads this definition's family name from the SSM fleet-config
# parameter at boot so no hand-set FLEET_ECS_TASK_DEF is needed.
# Network mode is bridge (EC2 only): the run-task call does not need
# --network-configuration because container networking is handled at the EC2
# instance level.

resource "aws_ecs_task_definition" "runner" {
  family                   = "${var.name}-runner"
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
  task_role_arn            = aws_iam_role.task.arn
  execution_role_arn       = aws_iam_role.task_execution.arn

  container_definitions = jsonencode([
    {
      name      = local.runner_container_name
      image     = "${aws_ecr_repository.runner.repository_url}:runner"
      essential = true
      cpu       = var.runner_cpu
      memory    = var.runner_memory

      # Seconds between SIGTERM and SIGKILL when the daemon cancels a job
      # (#111). The runner's cancel teardown kills the harness tree, pushes the
      # work in progress and settles inside FLEET_CANCEL_DEADLINE_MS (20s); past
      # this timeout ECS kills it mid-push and the uncommitted work is gone.
      # Pinned rather than left to the ECS default so raising the runner's
      # deadline cannot silently outgrow it.
      stopTimeout = 30

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.runner.name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = "runner"
        }
      }
    },
  ])

  tags = local.tags
}

# --- Fleet-config SSM parameter ---------------------------------------------------
# Stores the provider configuration the daemon reads at startup via the
# FLEET_ECS_CONFIG_SSM_PATH env var.  Subnets and security groups are intentionally
# omitted: the runner task uses bridge networking and must not pass
# --network-configuration to ecs run-task.

# This deployment's self-description, written once and published twice: as the
# SSM parameter the daemon reads at boot, and as the fleet_config output
# operators capture beside their project. Terraform cannot reference an output,
# so the map has to live in a local — and it has to be ONE local. It was two
# hand-kept copies until #57, by which time the parameter had silently missed
# daemon_service, runner_repository_url, and ssm_config_path: the copy nobody
# reads at apply time is the copy that rots. test/cloud-agnostic.test.ts fails a
# unit that writes the map more than once.
locals {
  fleet_config = {
    provider = "ecs"
    cluster  = aws_ecs_cluster.this.name
    # capacity_provider replaces launch_type: run-task uses --capacity-provider-strategy
    # so ECS managed scaling fires and the ASG scales out for each job.
    capacity_provider = aws_ecs_capacity_provider.ec2.name
    # daemon_service names the service that runs the :daemon tag, so publishing a
    # new image can roll it (images/build.sh --redeploy-daemon) without the
    # operator naming infrastructure Fleet already created.
    daemon_service = local.daemon_service_name
    # Operator access (D12): `fleet connect` resolves the service's running task,
    # takes this container's runtime id for the SSM target, and forwards
    # daemon_port to localhost. Without both, reaching the daemon is back to
    # hand-run aws commands — see the connect_hint output.
    daemon_container_name  = local.daemon_container_name
    daemon_port            = var.daemon_tcp_port
    runner_repository_url  = aws_ecr_repository.runner.repository_url
    runner_task_definition = aws_ecs_task_definition.runner.family
    runner_container_name  = local.runner_container_name
    runner_log_group       = aws_cloudwatch_log_group.runner.name
    # Runner tasks use bridge networking on EC2; ecs run-task must not receive
    # --network-configuration for bridge-mode tasks.
    subnets         = []
    security_groups = []
    ssm_config_path = local.fleet_config_ssm_path
    # Offered capacity: the daemon rejects manifests whose limits.resources
    # exceed every tier here, surfacing the mismatch at dispatch rather than
    # letting the job queue forever against capacity it can never obtain.
    capacity_tiers = [{ cpu = var.offered_cpu_units, memory = var.offered_memory_mib }]
  }
}

resource "aws_ssm_parameter" "fleet_config" {
  name  = local.fleet_config_ssm_path
  type  = "String"
  value = jsonencode(local.fleet_config)

  tags = local.tags
}

# --- Daemon service ---------------------------------------------------------------
# The daemon runs on Fargate — its own substrate, independent of the worker
# capacity provider and ASG.  This lets the worker ASG scale to zero when idle
# while the daemon stays up to accept new jobs.
#
# Operator access: SSM port-forward (see the connect_hint output).  No inbound
# network rule opens a path from the public internet; the daemon SG accepts
# traffic only from the runner instances SG on the daemon TCP port.

resource "aws_ecs_task_definition" "daemon" {
  family                   = "${var.name}-daemon"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  # Fargate requires cpu and memory at the task level (as strings).
  cpu                = tostring(var.daemon_cpu)
  memory             = tostring(var.daemon_memory)
  task_role_arn      = aws_iam_role.daemon.arn
  execution_role_arn = aws_iam_role.task_execution.arn

  volume {
    name = "fleet-home"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.fleet_home.id
      transit_encryption = "ENABLED"
    }
  }

  container_definitions = jsonencode([
    {
      name      = local.daemon_container_name
      image     = local.daemon_image
      essential = true
      cpu       = var.daemon_cpu
      memory    = var.daemon_memory

      environment = [
        { name = "FLEET_HOME", value = var.fleet_home_path },
        # FLEET_PORT: daemon binds TCP so runner tasks can reach it.
        # FLEET_DAEMON_HOST is NOT set here — the daemon auto-discovers its
        # private IP from ECS container metadata at startup (awsvpc networking
        # gives the task a VPC ENI whose IP appears in the metadata endpoint).
        { name = "FLEET_PORT", value = tostring(var.daemon_tcp_port) },
        # FLEET_PROVIDER selects the ECS backend; FLEET_ECS_CONFIG_SSM_PATH tells
        # the daemon where to read fleet_config at boot — no hand-set FLEET_ECS_*
        # variables are needed in a production deployment.
        { name = "FLEET_PROVIDER", value = "ecs" },
        { name = "FLEET_ECS_CONFIG_SSM_PATH", value = aws_ssm_parameter.fleet_config.name },
      ]

      mountPoints = [
        {
          sourceVolume  = "fleet-home"
          containerPath = var.fleet_home_path
          readOnly      = false
        },
      ]

      portMappings = [
        {
          containerPort = var.daemon_tcp_port
          protocol      = "tcp"
        },
      ]

      linuxParameters = {
        initProcessEnabled = true # clean child reaping for ECS exec sessions
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.daemon.name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = "daemon"
        }
      }
    },
  ])

  tags = local.tags
}

resource "aws_ecs_service" "daemon" {
  name                    = local.daemon_service_name
  cluster                 = aws_ecs_cluster.this.id
  task_definition         = aws_ecs_task_definition.daemon.arn
  desired_count           = 1
  launch_type             = "FARGATE"
  enable_execute_command  = true
  enable_ecs_managed_tags = true

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.daemon.id]
    assign_public_ip = local.daemon_assign_public_ip
  }

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  depends_on = [
    aws_efs_mount_target.fleet_home,
  ]

  tags = local.tags
}

# Deliberately no billing/budget resources: Fleet bounds spend structurally
# (ASG min 0 / max_instances cap here; per-job wall-clock in core). Billing
# alarms are the operator's own — a budget provisioned by the unit meters the
# whole account unless cost-allocation tags are activated, and either way it
# is monitoring, not control. See docs/decisions.md#d12 (amended 2026-08-19).
