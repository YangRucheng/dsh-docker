# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

# dsh version to install (build-arg; defaults to npm `latest`).
ARG DSH_VERSION=latest

# pnpm is required at runtime by `dsh plugin` (plugin management forwards to pnpm).
RUN npm install -g "pnpm" "@deepseek-ai/dsh@${DSH_VERSION}" \
      --no-audit --no-fund \
    && npm cache clean --force \
    && dsh --version

# Patch the compiled LLM core: DSH_RETRY (retry count) and UA (User-Agent) overrides.
# Done at build time as root (node_modules is root-owned); the env vars are read at runtime.
COPY patch-dsh.cjs /tmp/patch-dsh.cjs
RUN NODE_PATH="$(npm root -g)" node /tmp/patch-dsh.cjs \
    && rm /tmp/patch-dsh.cjs

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

USER dsh
WORKDIR /workspace
EXPOSE 3080

ENTRYPOINT ["docker-entrypoint.sh"]
