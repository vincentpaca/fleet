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
# Usage:
#   docker build --build-arg HARNESS_CLI=claude-code --build-arg HARNESS_VERSION=1.2.3 \
#     -t fleet-runner:claude-code-1.2.3 -f images/runner/Dockerfile .

ARG HARNESS_CLI=claude-code
ARG HARNESS_VERSION=latest

FROM node:24-slim

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
WORKDIR /opt/fleet
COPY src/ src/
COPY schemas/ schemas/
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Entrypoint: the runner. API keys arrive via docker run -e, never baked in.
ENTRYPOINT ["node", "src/runner/main.ts"]
