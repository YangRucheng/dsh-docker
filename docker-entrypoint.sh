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
TRUSTED_ARGS=""
if [ -n "${DSH_TRUSTED_HOSTS:-}" ]; then
  for th in $(printf '%s' "$DSH_TRUSTED_HOSTS" | tr ',' ' '); do
    TRUSTED_ARGS="$TRUSTED_ARGS --trusted-host $th"
  done
fi

# shellcheck disable=SC2086
exec dsh web $PATCH_ARGS $PORT_ARGS $TRUSTED_ARGS "$@"
