#!/usr/bin/env bash
# Build (and optionally push to ECR) a Fleet runner base image.
#
# Usage: ./images/runner/build.sh [--cli HARNESS_CLI] [--version HARNESS_VERSION]
#                                  [--push] [--registry ECR_URI] [--region AWS_REGION]
#
# Examples:
#   ./images/runner/build.sh --cli claude-code --version 1.2.3
#   ./images/runner/build.sh --cli claude-code --version 1.2.3 \
#     --push --registry 123456789012.dkr.ecr.us-east-1.amazonaws.com
#
# Auth note: API keys (ANTHROPIC_API_KEY etc.) are NOT baked into the image.
# They arrive at task start via -e flags injected by the Fleet daemon.
# Delegated jobs bill via API key; interactive OAuth/subscription login does
# not transfer to headless containers. Set env.vars in .fleet/manifest.json.
#
# ECR push: AWS credentials must be configured in the environment
# (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or an IAM role via EC2/ECS).
# A live push exercise belongs to issue #9 (ECS substrate bringup).

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

HARNESS_CLI="${HARNESS_CLI:-claude-code}"
HARNESS_VERSION="${HARNESS_VERSION:-latest}"
PUSH=0
REGISTRY=""
AWS_REGION="${AWS_REGION:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cli)      HARNESS_CLI="$2"; shift 2 ;;
    --version)  HARNESS_VERSION="$2"; shift 2 ;;
    --push)     PUSH=1; shift ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --region)   AWS_REGION="$2"; shift 2 ;;
    *) echo "error: unknown flag: $1" >&2; exit 1 ;;
  esac
done

LOCAL_TAG="fleet-runner:${HARNESS_CLI}-${HARNESS_VERSION}"

echo "building ${LOCAL_TAG} ..."
docker build \
  --build-arg "HARNESS_CLI=${HARNESS_CLI}" \
  --build-arg "HARNESS_VERSION=${HARNESS_VERSION}" \
  -t "${LOCAL_TAG}" \
  -f images/runner/Dockerfile \
  .

echo "built ${LOCAL_TAG}"

if [[ $PUSH -eq 1 ]]; then
  if [[ -z "$REGISTRY" ]]; then
    echo "error: --push requires --registry <ECR_URI>" >&2
    exit 1
  fi

  # Resolve region: flag > env > aws configure
  REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
  if [[ -z "$REGION" ]]; then
    echo "error: AWS region not set — use --region or set AWS_REGION" >&2
    exit 1
  fi

  # Authenticate to ECR.
  ACCOUNT_ID="${REGISTRY%%.*}"
  ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
  echo "authenticating to ${ECR_HOST} ..."
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$ECR_HOST"

  REMOTE_TAG="${REGISTRY}/${LOCAL_TAG}"
  docker tag "${LOCAL_TAG}" "${REMOTE_TAG}"
  docker push "${REMOTE_TAG}"
  echo "pushed ${REMOTE_TAG}"
fi
