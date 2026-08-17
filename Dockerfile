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
# `node`/`npm` already come from the base image. `gh` is always the latest
# release from its official GitHub releases (resolved at build time via the
# `releases/latest` redirect), with tarball checksum verification, so a
# corrupted download or a failed version lookup fails the build loudly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        build-essential \
        python3 python3-pip python3-venv python3-dev \
        curl ca-certificates wget \
        openssh-client \
        ripgrep jq unzip procps \
    && cd /tmp \
    && ARCH="$(dpkg --print-architecture)" \
    && GH_VERSION="$(curl -fsSIL -L --retry 5 --retry-all-errors -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest | sed -E 's|.*/tag/v([0-9.]+)/?.*|\1|')" \
    && case "$GH_VERSION" in \
         [0-9]*.[0-9]*.[0-9]*) echo "Resolved gh CLI version: $GH_VERSION" ;; \
         *) echo "error: failed to resolve the latest gh release (got '$GH_VERSION')" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 5 --retry-all-errors "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" -o gh_checksums.txt \
    && curl -fsSL --retry 5 --retry-all-errors "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" -o "gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
    && grep "gh_${GH_VERSION}_linux_${ARCH}.tar.gz" gh_checksums.txt | sha256sum -c - \
    && tar -xzf "gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
    && cp "gh_${GH_VERSION}_linux_${ARCH}/bin/gh" /usr/local/bin/gh \
    && chmod +x /usr/local/bin/gh \
    && rm -rf "gh_${GH_VERSION}_linux_${ARCH}.tar.gz" "gh_${GH_VERSION}_linux_${ARCH}" gh_checksums.txt \
    && gh --version \
    && rm -rf /var/lib/apt/lists/*

# Copy the global install (dsh + pnpm + compiled native modules) and the bins.
# These layers change on every dsh version update.
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /usr/local/bin /usr/local/bin

# Patch overlay (binds the Web server to 0.0.0.0) + entrypoint.
COPY config/bind-0.0.0.0.patch.yml /etc/dsh/bind-0.0.0.0.patch.yml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Runtime plugin-fence patch (runs at container start when DSH_DISABLE_TRUST_FENCE=1).
COPY patch-plugin-fence.cjs /usr/local/bin/patch-plugin-fence.cjs
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV DSH_HOME=/root/.dsh \
    NODE_ENV=production

# Runs as root.
WORKDIR /workspace
EXPOSE 3080

ENTRYPOINT ["docker-entrypoint.sh"]
