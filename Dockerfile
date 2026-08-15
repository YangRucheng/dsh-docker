# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

# ---- build stage: install dsh (compiles native deps such as node-pty) ----
FROM node:${NODE_VERSION}-bookworm-slim AS build

# node-gyp toolchain (build stage only; not part of the final image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# dsh version to install (build-arg; defaults to npm `latest`).
ARG DSH_VERSION=latest

# pnpm is required at runtime by `dsh plugin` (plugin management forwards to pnpm).
RUN npm install -g "pnpm" "@deepseek-ai/dsh@${DSH_VERSION}" \
      --no-audit --no-fund \
    && npm cache clean --force \
    && dsh --version

# Patch the compiled LLM core + trust fence + default directory (env-driven).
COPY patch-dsh.cjs /tmp/patch-dsh.cjs
RUN node /tmp/patch-dsh.cjs \
    && rm /tmp/patch-dsh.cjs

# ---- runtime stage ----
FROM node:${NODE_VERSION}-bookworm-slim

# Common development tools, in ONE early layer BEFORE the dsh COPY below, so it
# stays cached across dsh updates (only the dsh layers change, keeping pulls small).
# `node`/`npm` already come from the base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        build-essential \
        python3 python3-pip python3-venv python3-dev \
        curl ca-certificates wget \
        openssh-client \
        ripgrep jq unzip procps \
        gosu \
    && rm -rf /var/lib/apt/lists/*

# Copy the global install (dsh + pnpm + compiled native modules) and the bins.
# These layers change on every dsh version update.
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /usr/local/bin /usr/local/bin

# Non-root user + mount points.
RUN groupadd --gid 10001 dsh \
    && useradd --uid 10001 --gid dsh --create-home --home-dir /home/dsh dsh \
    && mkdir -p /workspace /home/dsh/.dsh \
    && chown -R dsh:dsh /workspace /home/dsh

# Patch overlay (binds the Web server to 0.0.0.0) + entrypoint.
COPY config/bind-0.0.0.0.patch.yml /etc/dsh/bind-0.0.0.0.patch.yml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV DSH_HOME=/home/dsh/.dsh \
    NODE_ENV=production

# Runs as root so the entrypoint can fix mount ownership, then drops to `dsh`.
WORKDIR /workspace
EXPOSE 3080

ENTRYPOINT ["docker-entrypoint.sh"]
