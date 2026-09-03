#!/usr/bin/env bash
# Keep an SSM port-forward to the fleet daemon alive.
#
# Usage: ./infra/aws/tunnel.sh [--cluster NAME] [--service NAME] [--container NAME]
#                              [--port REMOTE_PORT] [--local-port LOCAL_PORT]
#                              [--region AWS_REGION] [--keepalive SECONDS]
#
# Defaults follow the module defaults: cluster "fleet", service/container
# "<cluster>-daemon", remote port 9000, local port 1<remote port>.
#
# A bare `aws ssm start-session` port-forward dies twice over: Session
# Manager terminates the session after its idle timeout (20-minute account
# default) whenever no traffic crosses the tunnel, and every daemon deploy
# replaces the ECS task the session is pinned to. This wrapper fixes both:
#   - a background loop GETs the daemon's /health through the tunnel so the
#     session never counts as idle
#   - when the session ends anyway (deploy, network blip, expired
#     credentials) the outer loop re-resolves the current task and reconnects
#
# The local port deliberately defaults to 1<remote port> (9000 -> 19000),
# not the remote port itself: local agents commonly squat low ports and
# accept connections silently. Point fleet-config.json's daemon_url at the
# local port.
#
# The SSM target is underscore-separated (the API regex rejects commas).
# Ctrl-C (or SIGTERM) tears down the session and the keepalive, then exits.

# No `set -e`: aws failures inside the loop (expired creds, mid-deploy gaps)
# must fall through to a retry, not kill the tunnel.
set -uo pipefail

CLUSTER="fleet"
SERVICE=""
CONTAINER=""
PORT="9000"
LOCAL_PORT=""
REGION="${AWS_REGION:-}"
KEEPALIVE=60

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)    CLUSTER="$2"; shift 2 ;;
    --service)    SERVICE="$2"; shift 2 ;;
    --container)  CONTAINER="$2"; shift 2 ;;
    --port)       PORT="$2"; shift 2 ;;
    --local-port) LOCAL_PORT="$2"; shift 2 ;;
    --region)     REGION="$2"; shift 2 ;;
    --keepalive)  KEEPALIVE="$2"; shift 2 ;;
    *) echo "error: unknown flag: $1" >&2; exit 1 ;;
  esac
done

SERVICE="${SERVICE:-${CLUSTER}-daemon}"
CONTAINER="${CONTAINER:-$SERVICE}"
LOCAL_PORT="${LOCAL_PORT:-1${PORT}}"

# Resolve region: flag > env > aws configure
REGION="${REGION:-$(aws configure get region 2>/dev/null || true)}"
if [[ -z "$REGION" ]]; then
  echo "error: AWS region not set — use --region or set AWS_REGION" >&2
  exit 1
fi

SESSION_PID=""
KEEPALIVE_PID=""
cleanup() {
  if [[ -n "$SESSION_PID" ]]; then
    # The aws CLI spawns session-manager-plugin as a child that outlives its
    # parent and keeps the local port open — kill it before the CLI itself.
    pkill -TERM -P "$SESSION_PID" 2>/dev/null
    kill "$SESSION_PID" 2>/dev/null
  fi
  [[ -n "$KEEPALIVE_PID" ]] && kill "$KEEPALIVE_PID" 2>/dev/null
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

(
  while :; do
    sleep "$KEEPALIVE"
    curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${LOCAL_PORT}/health" 2>/dev/null || true
  done
) &
KEEPALIVE_PID=$!

while :; do
  TASK="$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" \
    --service-name "$SERVICE" --query 'taskArns[0]' --output text)"
  if [[ -z "$TASK" || "$TASK" == "None" ]]; then
    echo "no running ${SERVICE} task in ${CLUSTER}; retrying in 15s ..."
    sleep 15
    continue
  fi

  RUNTIME_ID="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" \
    --tasks "$TASK" \
    --query "tasks[0].containers[?name=='${CONTAINER}'].runtimeId" --output text)"
  if [[ -z "$RUNTIME_ID" || "$RUNTIME_ID" == "None" ]]; then
    echo "container ${CONTAINER} not up yet on task ${TASK##*/}; retrying in 15s ..."
    sleep 15
    continue
  fi

  echo "tunnel up: http://localhost:${LOCAL_PORT} -> ${SERVICE}:${PORT} (task ${TASK##*/})"
  aws ssm start-session --region "$REGION" \
    --target "ecs:${CLUSTER}_${TASK##*/}_${RUNTIME_ID}" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"localhost\"],\"portNumber\":[\"${PORT}\"],\"localPortNumber\":[\"${LOCAL_PORT}\"]}" &
  SESSION_PID=$!
  wait "$SESSION_PID"
  SESSION_PID=""
  echo "session ended; reconnecting in 3s ..."
  sleep 3
done
