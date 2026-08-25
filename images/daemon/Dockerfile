# Fleet daemon image.
#
# Contains: Node.js runtime (Fleet daemon source) + AWS CLI (shelled out by
# EcsProvider for ssm get-parameter and ecs run-task).
#
# Secrets NEVER enter this image. Credentials arrive at container start via
# the ECS task role (the credential endpoint at 169.254.170.2, not IMDS) or
# -e flags — never in ARG, ENV, or any image layer.
#
# Usage (build): images/build.sh --daemon
#   (it targets the deployment's architecture and owns the :daemon tag; build by
#   hand only when you are debugging this file)
#   docker build -t fleet-daemon:local -f images/daemon/Dockerfile .
#
# Usage (run locally for health-check testing):
#   docker run --rm -e FLEET_PORT=9000 -p 9000:9000 fleet-daemon:local
#   curl -s http://localhost:9000/health

# BASE_IMAGE exists for digest pinning (#138): a tag is a name, not an
# identity, and node:24-slim can move under an unchanged Dockerfile. Pass
# --build-arg BASE_IMAGE=node:24-slim@sha256:<digest> (or images/build.sh
# --base-image) to build against exactly one base. images/build.sh prints the
# digest the tag resolved to on every build, so there is always one to pin.
ARG BASE_IMAGE=node:24-slim

FROM ${BASE_IMAGE}

# AWS CLI v2 (used by EcsProvider to call ssm get-parameter and ecs run-task).
# Pinned by version AND checksum (#138): the unversioned zip is whatever AWS
# published this week, fetched over TLS with nothing else vouching for it —
# neither reproducible nor verifiable. Bumping the version means updating both
# hashes: shasum -a 256 against the versioned URLs below.
ARG AWS_CLI_VERSION=2.36.29
ARG AWS_CLI_SHA256_AMD64=cf000f7405c94742e2b3534e5436c8189e48752ccf548477ebaa1b6b8665cdb5
ARG AWS_CLI_SHA256_ARM64=d08073ff20ad0b4a5bdcee344b35052caf7aa51383caa66865708eca407125d0

# ca-certificates is explicit: --no-install-recommends drops it, and without
# it the https download below fails (curl exit 77).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) AWS_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip"; AWS_SHA256="$AWS_CLI_SHA256_AMD64" ;; \
         arm64) AWS_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip"; AWS_SHA256="$AWS_CLI_SHA256_ARM64" ;; \
         *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "$AWS_URL" -o /tmp/awscliv2.zip \
    && echo "${AWS_SHA256}  /tmp/awscliv2.zip" | sha256sum -c - \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# Fleet daemon source. No secrets here; credentials arrive at runtime only.
# Lockfiles before source (#138): npm ci depends only on package*.json, and
# COPYing src/ first busted its layer cache on every source edit.
WORKDIR /opt/fleet
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/
COPY schemas/ schemas/

# Default TCP port. When FLEET_PORT is set, the daemon binds on 0.0.0.0 inside
# the container and discovers its private IP from ECS container metadata to
# advertise to runner tasks.  Override with -e FLEET_PORT=<port>.
ENV FLEET_PORT=9000

# Health check: daemon must answer /health before the ECS service marks it healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${FLEET_PORT}/health || exit 1

# Drop root, mirroring images/runner/Dockerfile (Hadolint missing-user /
# Opengrep missing-user-entrypoint). `node` (uid 1000) ships in the base image;
# everything above still runs as root because apt, the AWS CLI install, and the
# /opt/fleet copy write outside $HOME. The daemon's one writable path is
# $FLEET_HOME: in a deployment that is the EFS mount, reached through an access
# point that forces posix uid/gid 1000 and owns its root 1000:1000
# (aws_efs_access_point.fleet_home in infra/aws/main.tf — the two halves of
# #156 land together or not at all); run locally, the default under $HOME is
# writable because /home/node belongs to uid 1000.
USER node

ENTRYPOINT ["node", "src/daemon/main.ts"]
