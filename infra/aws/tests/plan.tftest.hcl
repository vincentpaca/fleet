# Plan-level smoke for this unit: the checks `terraform validate` cannot make.
#
# validate type-checks the configuration against itself. It never asks the
# provider whether a value fits the resource schema, so a local carrying the
# run-task CLI's "ENABLED" string into aws_ecs_service's bool assign_public_ip
# is, to validate, a valid configuration. Three #9 bring-up failures lived past
# fmt and validate exactly that way and died at a paid apply.
#
# mock_provider makes the plan free and offline — no credentials, no API calls,
# no state — while keeping the part that rejects the value: the real provider
# schema. Run it as part of the infra pre-release checklist (see the unit
# README); CI's terraform job runs it too (.github/workflows/tests.yml).
#
#   terraform -chdir=infra/aws init -backend=false -input=false
#   terraform -chdir=infra/aws test
#
# Needs terraform >= 1.7 for mock_provider. The unit's own required_version
# stays at 1.5.0: consumers use the module, they do not run this file.
#
# Constraints no plan can reach — AWS validates them in the API, not in the
# provider schema — are pinned outside terraform, in test/infra-aws.test.ts.
# Both halves have to exist for a bring-up to survive without an apply.

mock_provider "aws" {
  # Every data source the unit reads needs a default: a generated mock is an
  # empty value, and the unit indexes into these. Values are shaped like the
  # real thing (an AZ name, an AMI id) so the plan renders what an apply would.
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b", "us-east-1c"]
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }

  # The ECS-optimized AMI, resolved from the public SSM parameter at plan time.
  mock_data "aws_ssm_parameter" {
    defaults = {
      value = "ami-00000000000000000"
    }
  }

  # The provider parses assume-role policies at plan time, so a mock that is
  # not JSON fails every aws_iam_role in the unit. Note what this costs: with
  # the data source mocked, the plan no longer renders the unit's actual
  # assume-role documents, so a mistake inside those statements is a blind spot
  # of this smoke. Everything built with jsonencode() in the unit — the
  # dispatch policy, both container definitions, the fleet-config parameter —
  # is real, because it is computed in the configuration rather than read from
  # a data source.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

# The default shape: the unit creates its VPC with public subnets and no NAT
# gateway, so the daemon task needs a public IP to reach ECR and CloudWatch.
run "public_subnets_give_the_daemon_a_public_ip" {
  command = plan

  variables {
    # What examples/basic passes, so the per-project ECR repositories are part
    # of the planned graph rather than the one resource only validate reaches.
    project_repos = ["acme-app"]
  }

  # A bool, not a string: the provider schema is the only thing that says so,
  # and it only speaks at plan time. Comparing against the literal `true` also
  # fails an inverted conditional, which a type check alone would pass.
  assert {
    condition     = aws_ecs_service.daemon.network_configuration[0].assign_public_ip == true
    error_message = "public subnets and no NAT: the daemon task cannot pull its image without a public IP"
  }

  # `fleet connect` builds the same target in src/providers/ecs.ts, where it is
  # unit-tested; this is the hand-run copy an operator pastes. The SSM
  # StartSession API rejects the comma form that `ecs execute-command` uses, so
  # pin the shape: ecs: followed by three underscore-separated fields of
  # target-safe characters. Shell expansions in the hint (`$RUNTIME_ID`,
  # `${TASK##*/}`) stand in for values the operator's shell fills in, so they
  # collapse to a placeholder before the charset is checked.
  assert {
    condition = can(regex(
      "^ecs:[0-9A-Za-z.-]+_[0-9A-Za-z.-]+_[0-9A-Za-z.-]+$",
      replace(
        regex("--target \"([^\"\n]+)\"", output.connect_hint)[0],
        "/\\$\\{[^}]*\\}|\\$[A-Za-z_][0-9A-Za-z_]*/",
        "SHELLVALUE",
      ),
    ))
    error_message = "connect_hint's --target is not an SSM session target: it must be ecs:<cluster>_<taskId>_<runtimeId>, and the API rejects commas and slashes"
  }

  # Region rides fleet_config (#138): every `aws` call the CLI and daemon make
  # against this deployment names it explicitly, instead of trusting the
  # caller's ambient AWS_REGION — which, wrong, turns into the misleading "the
  # daemon service is not up". Asserted through the output, which is the same
  # local the SSM parameter publishes (test/cloud-agnostic.test.ts holds the
  # one-copy rule); the parameter's own value is unknown at plan.
  assert {
    condition     = output.fleet_config.region == "us-east-1"
    error_message = "fleet_config must carry the deployment's region, or every consumer falls back to the caller's ambient AWS_REGION"
  }

  # The daemon container runs as uid 1000 (#156), and EFS creates its
  # filesystem root as root:root — so FLEET_HOME is writable only through the
  # access point: rooted at /fleet-home, created 1000:1000, every NFS request
  # forced to posix uid/gid 1000. Any drift in these numbers is a daemon that
  # boots and cannot write a single job.
  assert {
    condition = (
      aws_efs_access_point.fleet_home.posix_user[0].uid == 1000 &&
      aws_efs_access_point.fleet_home.posix_user[0].gid == 1000 &&
      aws_efs_access_point.fleet_home.root_directory[0].path == "/fleet-home" &&
      aws_efs_access_point.fleet_home.root_directory[0].creation_info[0].owner_uid == 1000 &&
      aws_efs_access_point.fleet_home.root_directory[0].creation_info[0].owner_gid == 1000 &&
      aws_efs_access_point.fleet_home.root_directory[0].creation_info[0].permissions == "0755"
    )
    error_message = "the FLEET_HOME access point must be rooted at /fleet-home as uid/gid 1000 (0755), or the non-root daemon cannot write its state"
  }

  # The access point only matters if the daemon's volume actually mounts
  # through it. The id itself is unknown at plan, but the block's presence is
  # in the configuration: no authorization_config means the mount lands on the
  # root:root filesystem root and the uid-1000 daemon cannot write it.
  assert {
    condition     = length(tolist(aws_ecs_task_definition.daemon.volume)[0].efs_volume_configuration[0].authorization_config) == 1
    error_message = "the daemon's fleet-home volume must mount through the EFS access point (authorization_config), or uid 1000 lands on an unwritable root"
  }

  # Scale-to-zero is a design commitment, not a suggestion (#67): by default
  # the worker ASG floors at zero so idle costs nothing. A default that drifts
  # above zero bills the operator an always-on instance (~$120/mo on-demand t3.xlarge) — more than
  # the rest of a Fleet deployment combined — without anyone choosing it.
  assert {
    condition = (
      aws_autoscaling_group.instances.min_size == 0 &&
      aws_autoscaling_group.instances.desired_capacity == 0
    )
    error_message = "the worker ASG must default to a floor of zero: warm capacity is opt-in via min_instances, never a default cost"
  }

  # The middle field is the task *id*, and the hint's TASK holds an ARN — the
  # slashes in which the API rejects just as it rejects the commas above. The
  # check above cannot see it, because a shell variable collapses to a
  # placeholder whatever it holds, so pin the one thing that is visible: TASK
  # is never spent directly on the target.
  assert {
    condition     = !can(regex("--target \"[^\"\n]*\\$\\{?TASK\\}?[_,\"]", output.connect_hint))
    error_message = "connect_hint spends $TASK (a task ARN) on the SSM target: strip the ARN prefix first ($${TASK##*/})"
  }
}

# Private subnets behind a NAT gateway: egress goes through the NAT, and a
# public IP on the task is both unnecessary and (on a private subnet) refused.
run "nat_gateway_keeps_the_daemon_off_the_public_internet" {
  command = plan

  variables {
    enable_nat_gateway = true
  }

  assert {
    condition     = aws_ecs_service.daemon.network_configuration[0].assign_public_ip == false
    error_message = "with a NAT gateway the daemon task must not take a public IP"
  }
}

# A reused VPC: the unit cannot know whether the operator's subnets route
# through a NAT, so it assigns a public IP and the branch is a third code path.
run "reused_vpc_plans_against_the_operators_subnets" {
  command = plan

  variables {
    vpc_id     = "vpc-00000000000000000"
    subnet_ids = ["subnet-00000000000000001", "subnet-00000000000000002"]
  }

  assert {
    condition     = aws_ecs_service.daemon.network_configuration[0].assign_public_ip == true
    error_message = "a reused VPC's subnets are unknown to the unit: the daemon task keeps its public IP"
  }

  assert {
    condition     = length(aws_efs_mount_target.fleet_home) == 2
    error_message = "one EFS mount target per operator-supplied subnet, or the daemon cannot mount FLEET_HOME from every subnet it may land in"
  }
}

# --- variable validation (#138) ----------------------------------------------
# Constraints that fail at plan, not apply. Each run below feeds the unit a
# value AWS would reject only after money was spent, and expects the named
# variable's validation (or the task definition's precondition) to reject it
# first. A validation that stops failing these is a validation someone deleted.

run "nine_azs_would_collide_public_and_private_cidrs" {
  command = plan

  variables {
    az_count = 10
  }

  expect_failures = [var.az_count]
}

run "a_zero_instance_cap_can_never_run_a_job" {
  command = plan

  variables {
    max_instances = 0
  }

  expect_failures = [var.max_instances]
}

run "daemon_cpu_must_be_a_fargate_value" {
  command = plan

  variables {
    daemon_cpu = 300
  }

  expect_failures = [var.daemon_cpu]
}

run "daemon_memory_outside_the_fargate_range_fails_its_own_validation" {
  command = plan

  variables {
    daemon_memory = 128
  }

  expect_failures = [var.daemon_memory]
}

# 4096 MiB is a valid Fargate memory — for cpu 512 and up. With the default
# cpu 256 it is an invalid pairing, which only the cross-variable precondition
# on the daemon task definition can see (the module supports terraform 1.5,
# where a variable validation cannot read another variable).
run "daemon_cpu_memory_pairing_is_held_by_the_precondition" {
  command = plan

  variables {
    daemon_cpu    = 256
    daemon_memory = 4096
  }

  expect_failures = [aws_ecs_task_definition.daemon]
}

run "offered_capacity_must_be_positive" {
  command = plan

  variables {
    offered_cpu_units  = 0
    offered_memory_mib = 0
  }

  expect_failures = [var.offered_cpu_units, var.offered_memory_mib]
}

run "spot_split_knobs_hold_their_api_bounds" {
  command = plan

  variables {
    on_demand_base_capacity         = -1
    on_demand_percentage_above_base = 150
  }

  expect_failures = [var.on_demand_base_capacity, var.on_demand_percentage_above_base]
}

# --- warm capacity floor (#67) -------------------------------------------------

# min_instances is the whole feature: it must land on the ASG minimum (what
# keeps an instance warm) AND ride fleet_config (what lets `fleet doctor` say
# why instances exist at idle). desired_capacity must start at the floor too:
# the ASG API rejects desired < min at create — an apply-time failure this
# plan-time assert is here to prevent.
run "a_warm_floor_lands_on_the_asg_and_rides_fleet_config" {
  command = plan

  variables {
    min_instances = 1
  }

  assert {
    condition = (
      aws_autoscaling_group.instances.min_size == 1 &&
      aws_autoscaling_group.instances.desired_capacity == 1
    )
    error_message = "min_instances=1 must set the ASG minimum and initial desired capacity to 1, or the operator pays for a knob that keeps nothing warm"
  }

  assert {
    condition     = output.fleet_config.min_instances == 1
    error_message = "fleet_config must carry min_instances, or the cockpit cannot tell paid-for warm capacity from scale-in lag"
  }
}

run "a_negative_floor_fails_its_own_validation" {
  command = plan

  variables {
    min_instances = -1
  }

  expect_failures = [var.min_instances]
}

# A floor above the cap is rejected by the ASG API only at apply. Cross-variable,
# so it is the precondition on the ASG (not a variable validation — the module
# supports terraform 1.5) that has to catch it at plan.
run "a_floor_above_the_cap_is_held_by_the_precondition" {
  command = plan

  variables {
    min_instances = 5
    max_instances = 4
  }

  expect_failures = [aws_autoscaling_group.instances]
}

# The worker tier is one coherent unit (#191): the default instance hosts the
# default task, and the task default claims the full offered tier so a job gets
# the performance the tier advertises. A 2-vCPU default starved suite-heavy
# jobs into their wall-clock budgets.
run "worker_tier_is_coherent" {
  command = plan

  assert {
    condition     = aws_launch_template.instances.instance_type == "t3.xlarge"
    error_message = "the default worker instance type must be t3.xlarge (#191) — change it only together with the offered_* and runner_* defaults"
  }
  assert {
    condition     = var.runner_cpu == 4096 && var.runner_memory == 15360
    error_message = "the default runner task must claim the full offered tier (4096 cpu units / 15360 MiB) — the precondition on the task definition ties these to what actually ships"
  }
  assert {
    condition     = output.fleet_config.capacity_tiers[0].cpu == 4096 && output.fleet_config.capacity_tiers[0].memory == 15360
    error_message = "fleet_config must advertise the new tier so the daemon's checkResources matches the deployment"
  }
}

run "runner_default_exceeding_tier_fails_at_plan" {
  command = plan

  variables {
    runner_cpu = 8192
  }

  expect_failures = [aws_ecs_task_definition.runner]
}
