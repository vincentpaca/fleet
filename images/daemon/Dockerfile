# Fleet daemon image.
#
# Contains: Node.js runtime (Fleet daemon source) + AWS CLI (shelled out by
# EcsProvider for ssm get-parameter and ecs run-task).
#
# Secrets NEVER enter this image. Credentials arrive at container start via
# ECS task roles (IMDS) or -e flags — never in ARG, ENV, or any image layer.
#
# Usage (build):
#   docker build -t fleet-daemon:local -f images/daemon/Dockerfile .
#
# Usage (run locally for health-check testing):
#   docker run --rm -e FLEET_PORT=9000 -p 9000:9000 fleet-daemon:local
#   curl -s http://localhost:9000/health

FROM node:24-slim

# AWS CLI v2 (used by EcsProvider to call ssm get-parameter and ecs run-task).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) AWS_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" ;; \
         arm64) AWS_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" ;; \
         *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "$AWS_URL" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# Fleet daemon source. No secrets here; credentials arrive at runtime only.
WORKDIR /opt/fleet
COPY src/ src/
COPY schemas/ schemas/
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Default TCP port. When FLEET_PORT is set, the daemon binds on 0.0.0.0 inside
# the container and discovers its private IP from ECS container metadata to
# advertise to runner tasks.  Override with -e FLEET_PORT=<port>.
ENV FLEET_PORT=9000

# Health check: daemon must answer /health before the ECS service marks it healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${FLEET_PORT}/health || exit 1

ENTRYPOINT ["node", "src/daemon/main.ts"]
