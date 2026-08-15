#!/bin/sh
set -e

# Bind host: default 0.0.0.0 so Docker `-p 3080:3080` reaches the server.
# Set DSH_HOST=127.0.0.1 to revert to the loopback-only (safe) default.
HOST="${DSH_HOST:-0.0.0.0}"
case "$HOST" in
  0.0.0.0)   PATCH_ARGS="--patch /etc/dsh/bind-0.0.0.0.patch.yml" ;;
  127.0.0.1) PATCH_ARGS="" ;;
  *) echo "error: DSH_HOST must be 0.0.0.0 or 127.0.0.1 (got '$HOST')" >&2; exit 1 ;;
esac

# Optional port env -> the web app's own --port flag.
PORT_ARGS=""
if [ -n "${DSH_PORT:-}" ]; then
  PORT_ARGS="--port $DSH_PORT"
fi

# Extra user args (e.g. --trusted-host) are appended verbatim.
# shellcheck disable=SC2086
exec dsh web $PATCH_ARGS $PORT_ARGS "$@"
