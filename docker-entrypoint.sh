#!/bin/sh
set -e

# Bind host (0.0.0.0 by default; DSH_HOST=127.0.0.1 reverts to loopback).
HOST="${DSH_HOST:-0.0.0.0}"
case "$HOST" in
  0.0.0.0)   PATCH_ARGS="--patch /etc/dsh/bind-0.0.0.0.patch.yml" ;;
  127.0.0.1) PATCH_ARGS="" ;;
  *) echo "error: DSH_HOST must be 0.0.0.0 or 127.0.0.1 (got '$HOST')" >&2; exit 1 ;;
esac

# Optional port env -> the web app's own --port flag.
PORT_ARGS=""
[ -n "${DSH_PORT:-}" ] && PORT_ARGS="--port $DSH_PORT"

# Optional trusted hosts (space/comma separated) -> repeatable --trusted-host flags.
# Needed when accessing through a domain/reverse proxy: dsh's /api trust fence
# only lets through loopback plus the trusted authorities, otherwise it 403s.
TRUSTED_ARGS=""
if [ -n "${DSH_TRUSTED_HOSTS:-}" ]; then
  for th in $(printf '%s' "$DSH_TRUSTED_HOSTS" | tr ',' ' '); do
    TRUSTED_ARGS="$TRUSTED_ARGS --trusted-host $th"
  done
fi

if [ "$(id -u)" = "0" ]; then
  # Running as root (the image default): fix bind-mount ownership, then drop to
  # the non-root `dsh` user. Bind mounts keep the host's ownership, which would
  # otherwise block `dsh` from writing its data dir ($DSH_HOME) and the workspace.
  DSH_HOME="${DSH_HOME:-/home/dsh/.dsh}"
  mkdir -p "$DSH_HOME"
  chown -R dsh:dsh "$DSH_HOME" 2>/dev/null || true
  [ -d /workspace ] && chown dsh:dsh /workspace 2>/dev/null || true
  # shellcheck disable=SC2086
  exec gosu dsh dsh web $PATCH_ARGS $PORT_ARGS $TRUSTED_ARGS "$@"
fi

# Already running as a non-root user (e.g. `docker run --user ...`): run directly.
# shellcheck disable=SC2086
exec dsh web $PATCH_ARGS $PORT_ARGS $TRUSTED_ARGS "$@"
