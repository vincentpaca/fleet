#!/usr/bin/env bash
# Build, tag, push, and roll out Fleet's own container images for one deployment.
#
# The whole path is one command:
#
#   ./images/build.sh --redeploy-daemon
#
# builds BOTH images for the deployment's architecture, tags them :runner and
# :daemon (the tags infra/<cloud>/ pins), pushes them to the deployment's ECR
# repository, and forces the daemon service to start from the new image. No
# DOCKER_DEFAULT_PLATFORM, no docker tag, no aws ecs update-service by hand.
#
# Discovery: everything but credentials comes from the deployment's own
# fleet_config, captured beside the project that dispatches jobs —
#
#   .fleet/infra/<provider>/fleet-config.json
#     runner_repository_url  → push target, ECR host, and region
#     cluster + daemon_service → the service --redeploy-daemon rolls
#
# Capture it once after terraform apply (the same file the CLI reads
# daemon_url from):
#
#   mkdir -p .fleet/infra/aws
#   terraform -chdir=infra/aws/examples/basic output -json fleet_config \
#     > .fleet/infra/aws/fleet-config.json
#
# Every discovered value has a flag override; pass them all and no config file
# is read. Discovery is relative to the directory you run this from, while the
# build context is always this Fleet checkout — the two are different repos
# whenever an operator builds for their own project.
#
# Platform defaults to linux/amd64: the architecture infra/aws runs today (its
# Fargate daemon task and its default t3 container instances are both x86_64).
# On an arm64 workstation that means an emulated build — the deployment's
# architecture is what matters, not the builder's.
#
# --redeploy-daemon restarts FLEET'S OWN daemon service with the image just
# pushed. It deploys no user application, and no job or runner code path can
# reach it: it runs only when an operator types it (docs/decisions.md#d5).
#
# Auth: API keys (ANTHROPIC_API_KEY etc.) are NEVER baked into an image layer.
# They arrive at task start via -e flags injected by the Fleet daemon; set
# env.vars in .fleet/manifest.json. Delegated jobs bill via API key;
# interactive OAuth/subscription login does not transfer to headless
# containers. ECR push and the service roll use your ambient AWS credentials.

set -euo pipefail

usage() {
  cat <<'EOF'
usage: images/build.sh [flags]

  --runner | --daemon    build only that image (default: both)
  --platform PLATFORM    target architecture (default: linux/amd64)
  --cli HARNESS_CLI      harness CLI baked into the runner base (default: claude-code)
  --version VERSION      harness CLI version (default: latest)
  --push                 push to the deployment's ECR as :runner / :daemon
  --redeploy-daemon      --push, then force a new deployment of Fleet's daemon service
  --config PATH          fleet-config.json to discover from
  --repository URL       ECR repository URL to push to (skips discovery)
  --region REGION        AWS region (default: derived from the repository URL)
  --cluster NAME         ECS cluster holding the daemon service
  --service NAME         daemon service to roll
EOF
}

# Where the operator ran us from: fleet-config.json discovery is relative to
# this, not to the checkout.
INVOKED_FROM="$PWD"
# The Fleet checkout that owns this script is the docker build context. Derived
# from the script path, never from `git rev-parse`: run from another repo, that
# would hand docker the wrong tree.
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

BUILD_RUNNER=0
BUILD_DAEMON=0
PLATFORM="linux/amd64"
HARNESS_CLI="${HARNESS_CLI:-claude-code}"
HARNESS_VERSION="${HARNESS_VERSION:-latest}"
PUSH=0
REDEPLOY=0
CONFIG=""
REPOSITORY=""
REGION_FLAG=""
CLUSTER=""
SERVICE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runner)          BUILD_RUNNER=1; shift ;;
    --daemon)          BUILD_DAEMON=1; shift ;;
    --platform)        PLATFORM="$2"; shift 2 ;;
    --cli)             HARNESS_CLI="$2"; shift 2 ;;
    --version)         HARNESS_VERSION="$2"; shift 2 ;;
    --push)            PUSH=1; shift ;;
    --redeploy-daemon) REDEPLOY=1; PUSH=1; shift ;;
    --config)          CONFIG="$2"; shift 2 ;;
    --repository)      REPOSITORY="$2"; shift 2 ;;
    --region)          REGION_FLAG="$2"; shift 2 ;;
    --cluster)         CLUSTER="$2"; shift 2 ;;
    --service)         SERVICE="$2"; shift 2 ;;
    --registry)
      # Was a registry HOST; the tags now live in the deployment's own repository.
      echo "error: --registry is gone — pass --repository <ECR repository URL>, the full .../<name>-runner path that holds the :runner and :daemon tags" >&2
      exit 1 ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "error: unknown flag: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Neither named: build both. A deployment needs both tags.
if [[ $BUILD_RUNNER -eq 0 && $BUILD_DAEMON -eq 0 ]]; then
  BUILD_RUNNER=1
  BUILD_DAEMON=1
fi

if [[ $REDEPLOY -eq 1 && $BUILD_DAEMON -eq 0 ]]; then
  echo "error: --redeploy-daemon rolls the daemon service onto a freshly pushed :daemon image — drop --runner so the daemon image is built too" >&2
  exit 1
fi

# --- deployment discovery -----------------------------------------------------
# Resolved before anything is built: a missing field must fail in seconds, not
# after a ten-minute emulated build.

# Read one string field out of a fleet-config.json. node (the runtime Fleet
# already requires) parses it — a grep/sed JSON reader is a bug waiting for the
# first reordered key.
config_field() { # config_field <file> <key>
  node -e '
    const [file, key] = process.argv.slice(1);
    const cfg = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    const value = cfg[key];
    if (typeof value === "string" && value) process.stdout.write(value);
  ' "$1" "$2"
}

find_config() {
  local candidate
  for candidate in "$INVOKED_FROM"/.fleet/infra/*/fleet-config.json; do
    if [[ -f "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

capture_hint() {
  echo "  capture the deployment's own values once after terraform apply:" >&2
  echo "    mkdir -p .fleet/infra/aws" >&2
  echo "    terraform -chdir=infra/aws/examples/basic output -json fleet_config > .fleet/infra/aws/fleet-config.json" >&2
}

if [[ $PUSH -eq 1 ]]; then
  if [[ -z "$CONFIG" ]]; then
    CONFIG="$(find_config || true)"
  elif [[ ! -f "$CONFIG" ]]; then
    echo "error: --config file not found: $CONFIG" >&2
    exit 1
  fi
  if [[ -n "$CONFIG" ]]; then
    echo "reading deployment from ${CONFIG}"
    [[ -n "$REPOSITORY" ]] || REPOSITORY="$(config_field "$CONFIG" runner_repository_url)"
    [[ -n "$CLUSTER" ]] || CLUSTER="$(config_field "$CONFIG" cluster)"
    [[ -n "$SERVICE" ]] || SERVICE="$(config_field "$CONFIG" daemon_service)"
  fi

  if [[ -z "$REPOSITORY" ]]; then
    echo "error: no ECR repository to push to — pass --repository <url>, or:" >&2
    capture_hint
    exit 1
  fi

  ECR_HOST="${REPOSITORY%%/*}"
  if [[ "$ECR_HOST" == "$REPOSITORY" ]]; then
    echo "error: --repository must be a full ECR repository URL (<host>/<repository>), got: ${REPOSITORY}" >&2
    exit 1
  fi

  # Region, most authoritative first: the flag, then the repository's own host
  # (a login token is region-scoped, so the URL beats an unrelated AWS_REGION),
  # then the ambient AWS config.
  REGION="$REGION_FLAG"
  if [[ -z "$REGION" && "$ECR_HOST" =~ \.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$ ]]; then
    REGION="${BASH_REMATCH[1]}"
  fi
  if [[ -z "$REGION" ]]; then
    REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
  fi
  if [[ -z "$REGION" ]]; then
    echo "error: AWS region not set — use --region or set AWS_REGION" >&2
    exit 1
  fi

  if [[ $REDEPLOY -eq 1 && -z "$CLUSTER" ]]; then
    echo "error: --redeploy-daemon needs the ECS cluster — pass --cluster <name>, or take it from fleet_config's cluster field:" >&2
    capture_hint
    exit 1
  fi
  if [[ $REDEPLOY -eq 1 && -z "$SERVICE" ]]; then
    echo "error: --redeploy-daemon needs the daemon service — pass --service <name>, or take it from fleet_config's daemon_service field:" >&2
    capture_hint
    exit 1
  fi
fi

# --- build --------------------------------------------------------------------

RUNNER_LOCAL_TAG="fleet-runner:${HARNESS_CLI}-${HARNESS_VERSION}"
DAEMON_LOCAL_TAG="fleet-daemon:local"

build_image() { # build_image <local tag> <dockerfile> [build args...]
  local tag="$1" dockerfile="$2"
  shift 2
  echo "building ${tag} for ${PLATFORM} ..."
  # ${1+"$@"} not "$@": the daemon build passes no extra args, and bash 3.2
  # (still /bin/bash on macOS, where an arm64 operator hits this first) treats
  # an empty "$@" as an unbound variable under set -u.
  docker build \
    --platform "$PLATFORM" \
    ${1+"$@"} \
    -t "$tag" \
    -f "${REPO_ROOT}/${dockerfile}" \
    "$REPO_ROOT"
  echo "built ${tag} (${PLATFORM})"
}

if [[ $BUILD_RUNNER -eq 1 ]]; then
  build_image "$RUNNER_LOCAL_TAG" images/runner/Dockerfile \
    --build-arg "HARNESS_CLI=${HARNESS_CLI}" \
    --build-arg "HARNESS_VERSION=${HARNESS_VERSION}"
fi
if [[ $BUILD_DAEMON -eq 1 ]]; then
  build_image "$DAEMON_LOCAL_TAG" images/daemon/Dockerfile
fi

# --- push ---------------------------------------------------------------------

LOGIN_DONE=0
ecr_login() {
  if [[ $LOGIN_DONE -eq 1 ]]; then return 0; fi
  echo "authenticating to ${ECR_HOST} (${REGION}) ..."
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$ECR_HOST"
  LOGIN_DONE=1
}

push_image() { # push_image <local tag> <remote tag>
  local local_tag="$1" remote="${REPOSITORY}:$2"
  ecr_login
  docker tag "$local_tag" "$remote"
  docker push "$remote"
  echo "pushed ${remote}"
}

if [[ $PUSH -eq 1 ]]; then
  # :runner and :daemon are the tags the infra unit pins — never derived from
  # the harness version, which the task definitions know nothing about.
  if [[ $BUILD_RUNNER -eq 1 ]]; then push_image "$RUNNER_LOCAL_TAG" runner; fi
  if [[ $BUILD_DAEMON -eq 1 ]]; then push_image "$DAEMON_LOCAL_TAG" daemon; fi
fi

# --- roll the daemon ----------------------------------------------------------

if [[ $REDEPLOY -eq 1 ]]; then
  echo "forcing a new deployment of ${SERVICE} on ${CLUSTER} ..."
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --force-new-deployment \
    --region "$REGION" >/dev/null
  echo "rolled ${SERVICE} — its next task starts from ${REPOSITORY}:daemon"
  echo "watch it settle:"
  echo "  aws ecs wait services-stable --cluster ${CLUSTER} --services ${SERVICE} --region ${REGION}"
fi
