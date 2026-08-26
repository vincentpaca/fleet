data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

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
  # The daemon publishes its operator token here at boot (#188) — a runtime
  # write, so no aws_ssm_parameter resource exists for it. The CLI derives the
  # same sibling path from fleet_config's ssm_config_path; only the IAM grant
  # below needs it spelled out at plan time.
  operator_token_ssm_path = "/${var.name}/operator-token"

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

# Every VPC ships a default security group that allows all traffic between its
# members. Nothing in Fleet uses it — every resource here names its own SG — but
# it stays permissive unless something claims it, so anything later launched into
# this VPC without an explicit SG lands in an allow-all group. Adopting it with
# no rules closes that (Checkov CKV2_AWS_12). Only when Fleet owns the VPC:
# adopting an operator's default SG would silently change their other workloads.
resource "aws_default_security_group" "this" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = merge(local.tags, { Name = "${var.name}-default-locked" })
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

  # KMS rather than the AES256 default (Checkov CKV_AWS_136). Deliberately the
  # AWS-managed ECR key, not the CMK above: images are rebuildable from this
  # repo, so there is nothing here worth the key-policy surface a CMK adds.
  encryption_configuration {
    encryption_type = "KMS"
  }

  # image_tag_mutability stays MUTABLE. The :runner and :daemon tags that
  # infra/aws/ pins by name are re-pushed on every build — by the in-account
  # CodeBuild project below and by images/build.sh (the developer path) alike;
  # IMMUTABLE makes the second push fail. See docs/decisions.md.
  tags = local.tags
}

resource "aws_ecr_repository" "project" {
  for_each = toset(var.project_repos)

  name = each.value

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
  }

  tags = local.tags
}

# --- In-account image build (CodeBuild, #189) -----------------------------------
# `fleet setup infra` owns image production: a one-shot CodeBuild project that
# clones the PUBLIC Fleet repository at var.source_ref — the same pinned ref the
# module source names, so images and infra can never skew — builds BOTH images
# from images/runner and images/daemon, and pushes them to this deployment's ECR
# as :runner and :daemon. The trust thesis survives intact: you run what your
# own account built, from a ref you can read. No clone and no local Docker on
# the operator's machine; images/build.sh stays as the developer/offline path.
#
# Created only when source_ref is set. A module applied from a local path (the
# dogfood shape) has no honest ref to pin, and a build from a floating default
# would re-shape the images silently — the wizard refuses instead. There is no
# cost gate: CodeBuild bills per build minute, and an idle project costs $0.
#
# Starting a build is the operator's act, not the unit's: `fleet setup infra`
# calls codebuild:StartBuild with the operator's own credentials (the same
# admin-ish credentials the apply used), after the apply and on --rebuild-images.
# No schedule, no webhook, and no Fleet runtime role can reach it.

locals {
  build_images = var.source_ref != ""
}

resource "aws_cloudwatch_log_group" "image_build" {
  count = local.build_images ? 1 : 0

  name              = "/${var.name}/image-build"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.fleet.arn
  tags              = local.tags
}

data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "image_build" {
  count = local.build_images ? 1 : 0

  name               = "${var.name}-image-build"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "image_build" {
  count = local.build_images ? 1 : 0

  name = "ecr-push-and-logs"
  role = aws_iam_role.image_build[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # The login handshake. GetAuthorizationToken is account-scoped by AWS's
        # own design — it cannot name a repository — and grants nothing beyond
        # the token; every write below is pinned to the one repository.
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        # Push to this deployment's runner repository ONLY (the :runner and
        # :daemon tags both live there). The build must not be able to write
        # any other repository in the account — including the per-project
        # repos this same unit creates.
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = aws_ecr_repository.runner.arn
      },
      {
        # Its own log group only.
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.image_build[0].arn}:*"
      },
    ]
  })
}

resource "aws_codebuild_project" "images" {
  count = local.build_images ? 1 : 0

  name          = "${var.name}-images"
  description   = "One-shot Fleet image build: clones the public repo at the pinned ref and pushes :runner and :daemon to this deployment's ECR. Started only by fleet setup infra."
  service_role  = aws_iam_role.image_build[0].arn
  build_timeout = 30

  artifacts {
    type = "NO_ARTIFACTS"
  }

  # privileged_mode: the buildspec runs `docker build`, and CodeBuild starts a
  # Docker daemon only in privileged builds. The images come out linux/amd64 —
  # what the Fargate daemon task and the default t3 instances run — because
  # that is the build host's own architecture; no emulation, no binfmt.
  environment {
    compute_type    = "BUILD_GENERAL1_MEDIUM"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "REPOSITORY_URL"
      value = aws_ecr_repository.runner.repository_url
    }
  }

  source {
    type            = "GITHUB"
    location        = var.source_repository
    git_clone_depth = 1

    # Inline, not a buildspec file in the repo: the pinned ref may predate any
    # such file, and the build contract belongs beside the role that grants the
    # push. Build args ride the Dockerfiles' own defaults — the same values
    # images/build.sh passes explicitly. AWS_REGION is set by CodeBuild itself.
    buildspec = <<-EOT
      version: 0.2
      phases:
        pre_build:
          commands:
            - aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$${REPOSITORY_URL%%/*}"
        build:
          commands:
            - docker build -t "$REPOSITORY_URL:runner" -f images/runner/Dockerfile .
            - docker build -t "$REPOSITORY_URL:daemon" -f images/daemon/Dockerfile .
        post_build:
          commands:
            - docker push "$REPOSITORY_URL:runner"
            - docker push "$REPOSITORY_URL:daemon"
    EOT
  }

  # The version alignment the whole design hangs on: the build checks out
  # exactly the ref the module source pins.
  source_version = var.source_ref

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.image_build[0].name
    }
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
      {
        # The parameter is a SecureString, so reading it is two authorizations:
        # ssm:GetParameter above and kms:Decrypt here. Scoped to decrypt only —
        # the daemon never writes the fleet-config parameter.
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.fleet.arn
      },
      {
        # The daemon publishes its operator token at boot (#188) as a
        # SecureString beside the config it just read, so the CLI can fetch it
        # instead of the operator extracting it with ecs execute-command by
        # hand. Write-only, and exactly this one path: anyone with SSM read on
        # the prefix already holds execute-command-grade access, so the grant
        # widens nothing. The token parameter uses the AWS-managed aws/ssm key
        # (the daemon knows the path, not this unit's CMK), which needs no kms
        # grant on either side. Pinned by test/infra-aws.test.ts.
        Effect   = "Allow"
        Action   = ["ssm:PutParameter"]
        Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.operator_token_ssm_path}"
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
        # The reconcile sweep (#147/#171) lists the cluster's running tasks and
        # describes them to find orphans by startedBy. Read-only, cluster-scoped
        # (#187): without these two the sweep's first AWS call is denied and
        # POST /reconcile answers 500 on a live deployment.
        Effect    = "Allow"
        Action    = ["ecs:ListTasks"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.this.arn } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:DescribeTasks"]
        Resource  = "*"
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

  # IMDSv2 is required and the hop limit is 1, so a job's container cannot
  # reach IMDS and assume the *instance* role — the escalation Fleet's
  # permission split exists to prevent (#157, docs/decisions.md#d16). The old
  # "containers need the instance role via IMDS" claim was checked and is
  # false: nothing job-side reads IMDS. Task credentials come from the ECS
  # credential endpoint at 169.254.170.2 (not IMDS, works at hop limit 1),
  # image pulls use the execution role resolved by the ECS agent on the host,
  # and ECS exec is the host's SSM agent. Pinned in test/infra-aws.test.ts.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # The SSM agent line is the break-glass path (#198): the ECS-optimized AL2023
  # AMI ships amazon-ssm-agent but does not enable it, so an InService worker —
  # instance role holding AmazonSSMManagedInstanceCore and all — answered
  # `ssm start-session` with TargetNotConnected during a live rescue, and the
  # committed work still on its disk was unreachable. `systemctl enable --now`
  # is AL2023's supported enablement. Network path: registration needs outbound
  # HTTPS to the ssm/ec2messages/ssmmessages endpoints, which the instances SG's
  # existing all-outbound egress already serves (the same public-IP or NAT path
  # ECR pulls take) — no new rule, and still no inbound from anywhere.
  # Pinned by tests/plan.tftest.hcl; break-glass usage is in the unit README's
  # operations section.
  user_data = base64encode(<<-EOT
    #!/bin/bash
    echo "ECS_CLUSTER=${aws_ecs_cluster.this.name}" >> /etc/ecs/ecs.config
    systemctl enable --now amazon-ssm-agent
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "${var.name}-instance" })
  }

  tags = local.tags
}

resource "aws_autoscaling_group" "instances" {
  name     = "${var.name}-instances"
  min_size = var.min_instances
  max_size = var.max_instances
  # Initial desired capacity only (ignore_changes below hands it to ECS managed
  # scaling). It must start at the floor, not 0: the ASG API rejects a desired
  # capacity below min_size at create — an apply-time failure no plan reaches.
  desired_capacity    = var.min_instances
  vpc_zone_identifier = local.subnet_ids

  lifecycle {
    ignore_changes = [desired_capacity] # ECS managed scaling owns this

    # min <= max needs both variables, so it cannot be a variable validation:
    # the module supports terraform 1.5, and cross-variable validation needs
    # 1.9 (same fork as the daemon cpu/memory pairing). The ASG API rejects
    # min_size > max_size only at apply; this precondition rejects it at plan.
    precondition {
      condition     = var.min_instances <= var.max_instances
      error_message = "min_instances=${var.min_instances} exceeds max_instances=${var.max_instances}: the ASG cannot hold a minimum above its maximum. Raise max_instances or lower the warm floor."
    }
  }

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

# --- KMS (customer-managed key for state at rest) --------------------------------
# EFS, the log groups and the fleet-config parameter are all encrypted by default
# with an AWS-managed key, which the operator cannot rotate, audit by policy, or
# revoke. One CMK covers all three so those things are the operator's to control
# (Checkov CKV_AWS_184 / CKV_AWS_158, Opengrep aws-efs-filesystem-encrypted-with-cmk).
#
# Deletion window is 30 days, deliberately not 7: the key is the only way to read
# a job's history, and a fat-fingered destroy should be recoverable for longer
# than a weekend.

resource "aws_kms_key" "fleet" {
  description             = "${var.name}: EFS state, log groups, fleet-config parameter"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  # CloudWatch Logs encrypts with the key itself rather than through a caller's
  # credentials, so the log service needs its own grant. Scoped by
  # kms:EncryptionContext so it can only be used for this deployment's groups —
  # a bare logs.* principal would let any log group in the account use this key.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountFullControl"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${data.aws_region.current.region}.amazonaws.com" }
        Action = [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/${var.name}/*"
          }
        }
      },
    ]
  })

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_kms_alias" "fleet" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.fleet.key_id
}

# --- EFS (FLEET_HOME durable state) ---------------------------------------------

resource "aws_efs_file_system" "fleet_home" {
  encrypted  = true
  kms_key_id = aws_kms_key.fleet.arn

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

# The daemon container runs as uid 1000 (`USER node` in images/daemon/Dockerfile),
# but EFS creates its filesystem root as root:root 0755 — unwritable at uid 1000.
# The access point fixes ownership structurally: it roots the daemon's mount at
# /fleet-home (created 1000:1000 on first mount) and forces every NFS request to
# posix uid/gid 1000, so no by-hand chown is baked into any deploy path (#156,
# docs/decisions.md#d16).
#
# Upgrading a deployment that predates this: state already written at the EFS
# filesystem root is NOT visible through the access point until an operator
# moves it into /fleet-home — see infra/aws/README.md.
resource "aws_efs_access_point" "fleet_home" {
  file_system_id = aws_efs_file_system.fleet_home.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/fleet-home"

    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0755"
    }
  }

  tags = merge(local.tags, { Name = "${var.name}-home" })
}

# --- CloudWatch logs -------------------------------------------------------------

resource "aws_cloudwatch_log_group" "daemon" {
  name              = "/${var.name}/daemon"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.fleet.arn
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/${var.name}/runner"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.fleet.arn
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
  lifecycle {
    # The task default must fit the advertised tier: a runner_cpu/runner_memory
    # above offered_* would dispatch jobs the daemon believes the deployment
    # cannot host (#191). Plan-time, cross-variable — the tier moves as one.
    precondition {
      condition     = var.runner_cpu <= var.offered_cpu_units && var.runner_memory <= var.offered_memory_mib
      error_message = "runner_cpu/runner_memory must not exceed offered_cpu_units/offered_memory_mib — the five tier variables move together (see variables.tf)."
    }
  }

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
  # Valid Fargate memory values (MiB) per task CPU value. Consumed by the
  # daemon task definition's precondition (below) that holds the pairing.
  fargate_memory_mib = {
    256  = [512, 1024, 2048]
    512  = range(1024, 4096 + 1, 1024)
    1024 = range(2048, 8192 + 1, 1024)
    2048 = range(4096, 16384 + 1, 1024)
    4096 = range(8192, 30720 + 1, 1024)
  }

  fleet_config = {
    provider = "ecs"
    cluster  = aws_ecs_cluster.this.name
    # The region every aws CLI call against this deployment must name (#138):
    # the operator picked it at setup, and relying on the caller's ambient
    # AWS_REGION instead turns a wrong default into "the daemon service is not
    # up". The daemon's own boot-time SSM read is the one caller that still
    # runs ambient — inside the task, ECS sets AWS_REGION to this value.
    region = data.aws_region.current.region
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
    # In-account image production (#189): the CodeBuild project `fleet setup
    # infra` starts after apply and --rebuild-images re-runs. null when the
    # module was applied from an unpinned source (no source_ref) — the CLI
    # then refuses to build rather than building from a ref nobody chose.
    image_build_project   = one(aws_codebuild_project.images[*].name)
    runner_container_name = local.runner_container_name
    runner_log_group      = aws_cloudwatch_log_group.runner.name
    # Runner tasks use bridge networking on EC2; ecs run-task must not receive
    # --network-configuration for bridge-mode tasks.
    subnets         = []
    security_groups = []
    ssm_config_path = local.fleet_config_ssm_path
    # Offered capacity: the daemon rejects manifests whose limits.resources
    # exceed every tier here, surfacing the mismatch at dispatch rather than
    # letting the job queue forever against capacity it can never obtain.
    capacity_tiers = [{ cpu = var.offered_cpu_units, memory = var.offered_memory_mib }]
    # Warm capacity floor (#67): carried so `fleet doctor`/cockpit can say why
    # instances exist at idle — 0 means any idle instance is a scale-in lag,
    # above 0 it is paid-for warm capacity.
    min_instances = var.min_instances
  }
}

resource "aws_ssm_parameter" "fleet_config" {
  name = local.fleet_config_ssm_path
  # SecureString under the deployment's CMK. The contents are not secrets — task
  # definition family, cluster name, subnet ids — but they are a complete map of
  # how to dispatch a job into this account, and a String parameter is readable
  # by anything holding ssm:GetParameter on the path. Readers must pass
  # --with-decryption and hold kms:Decrypt (see daemon_ssm_config below).
  type   = "SecureString"
  key_id = aws_kms_key.fleet.arn
  value  = jsonencode(local.fleet_config)

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

  lifecycle {
    # The Fargate cpu↔memory pairing: a precondition, not a variable
    # validation, because it reads both variables and cross-variable
    # validation needs terraform 1.9 while this module still supports 1.5.
    # Each variable's own validation holds its independent bounds; this holds
    # the pairing Fargate would otherwise reject at apply.
    precondition {
      condition     = contains(local.fargate_memory_mib[var.daemon_cpu], var.daemon_memory)
      error_message = "daemon_memory=${var.daemon_memory} is not a valid Fargate memory for daemon_cpu=${var.daemon_cpu}. Valid: 256→512/1024/2048; 512→1024-4096; 1024→2048-8192; 2048→4096-16384; 4096→8192-30720 (1024-MiB steps above cpu 256)."
    }
  }

  volume {
    name = "fleet-home"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.fleet_home.id
      transit_encryption = "ENABLED"

      # The access point roots the mount at /fleet-home owned 1000:1000 and
      # forces posix uid/gid 1000 — what lets the daemon container drop root.
      authorization_config {
        access_point_id = aws_efs_access_point.fleet_home.id
      }
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
# (ASG min_instances floor, default 0, / max_instances cap here; per-job
# wall-clock in core). Billing
# alarms are the operator's own — a budget provisioned by the unit meters the
# whole account unless cost-allocation tags are activated, and either way it
# is monitoring, not control. See docs/decisions.md#d12 (amended 2026-08-19).
