# Fleet runner base image — one variant per harness CLI.
#
# Build args:
#   HARNESS_CLI     The CLI name (matches manifest harness.cli). Default: claude-code.
#   HARNESS_VERSION NPM version to pin. Default: latest (pin in production).
#
# Secrets NEVER enter this image. API keys are injected at container start via
# -e flags and live only in the process environment — never in ARG, ENV, or
# any image layer. Asserted by: docker history --no-trunc | grep -i key.
#
# Usage: images/build.sh --runner --cli claude-code --version 1.2.3
#   (it targets the deployment's architecture and owns the :runner tag; build by
#   hand only when you are debugging this file)
#   docker build --build-arg HARNESS_CLI=claude-code --build-arg HARNESS_VERSION=1.2.3 \
#     -t fleet-runner:claude-code-1.2.3 -f images/runner/Dockerfile .

ARG HARNESS_CLI=claude-code
ARG HARNESS_VERSION=latest
# BASE_IMAGE exists for digest pinning (#138): a tag is a name, not an
# identity, and node:24-slim can move under an unchanged Dockerfile. Pass
# --build-arg BASE_IMAGE=node:24-slim@sha256:<digest> (or images/build.sh
# --base-image) to build against exactly one base. images/build.sh prints the
# digest the tag resolved to on every build, so there is always one to pin.
ARG BASE_IMAGE=node:24-slim

FROM ${BASE_IMAGE}

# Re-declare so post-FROM layers can see the build args.
ARG HARNESS_CLI
ARG HARNESS_VERSION

# System tools:
#   git — workspace clone and branch management
#   curl — needed by the gh install step
#   ca-certificates — explicit: --no-install-recommends drops it, and only
#   git's dependency chain happens to pull it in today (the daemon image
#   without git shipped broken https for exactly this reason)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — rung verification calls gh to check PR/CI state.
# Pinned via the official APT source so the version tracks a managed package.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Harness CLI — one layer; HARNESS_CLI selects the npm package.
#   claude-code → @anthropic-ai/claude-code
#   codex       → @openai/codex
#   opencode    → opencode
RUN set -eu; \
    case "$HARNESS_CLI" in \
      claude-code) pkg="@anthropic-ai/claude-code" ;; \
      codex)       pkg="@openai/codex" ;; \
      opencode)    pkg="opencode" ;; \
      *) echo "unknown HARNESS_CLI: $HARNESS_CLI" >&2; exit 1 ;; \
    esac; \
    if [ "$HARNESS_VERSION" = "latest" ]; then \
      npm install -g "$pkg"; \
    else \
      npm install -g "${pkg}@${HARNESS_VERSION}"; \
    fi

# Fleet runner source. No secrets here; secrets enter at runtime only.
# Lockfiles before source (#138): npm ci depends only on package*.json, and
# COPYing src/ first busted its layer cache on every source edit — the exact
# rebuild cost the two-layer image model exists to avoid.
WORKDIR /opt/fleet
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/
COPY schemas/ schemas/

# Build stamp (#207): the git SHA this image was built from, passed by
# images/build.sh. The runner logs it at job start, so a job run on a stale
# image — the #197 incident — is diagnosable from its own event log. Not a
# secret (a public commit id), so ENV is fine where credentials never are.
# Declared after the COPY layers: a new SHA on an unchanged tree re-runs
# nothing above. Empty means unstamped; the runner then logs nothing.
ARG FLEET_BUILD_SHA=""
ENV FLEET_BUILD_SHA=${FLEET_BUILD_SHA}

# Privilege contract (#196): the container starts as root, and root belongs to
# setup — never to the job. The image carried `USER node` from #155 until the
# operator-authored manifest setup.script (laptop trust class) proved
# uninstallable prerequisites: `apt-get install` is root work. Trust follows
# authorship, so the runner keeps root exactly as long as setup needs it and
# then irreversibly drops to uid 1000 (`node`, from the base image) — before
# the pickup gate, the harness, and the settle (dropPrivileges in
# src/runner/setup.ts). A job with no setup.script drops immediately. The
# harness is still the least trusted code Fleet runs and never sees uid 0;
# asserted on live jobs in test/cli-image.test.ts (harness `id -u` is 1000),
# not by grepping this file.
#
# /workspace is still created and owned by the job user here: the drop chowns
# whatever root materialised, but uid 1000 could never mkdir at the filesystem
# root itself. The container is ephemeral and mounts no volume, so there is no
# host-side ownership to reconcile — unlike the daemon image, which writes to
# EFS and keeps uid 1000 via its EFS access point (#156).
RUN mkdir -p /workspace && chown node:node /workspace

# Entrypoint: the runner, deliberately as root until setup settles (see above).
# API keys arrive via docker run -e, never baked in.
ENTRYPOINT ["node", "/opt/fleet/src/runner/main.ts"]
