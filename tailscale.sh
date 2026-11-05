#!/bin/sh
set -eu
if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  mkdir -p /tmp/hararest-tailscale
  chmod 700 /tmp/hararest-tailscale
  /app/tailscaled --tun=userspace-networking \
    --state=/tmp/hararest-tailscale/state --statedir=/tmp/hararest-tailscale \
    --socket=/tmp/hararest-tailscale/socket \
    --outbound-http-proxy-listen=127.0.0.1:1056 &
  /app/tailscale --socket=/tmp/hararest-tailscale/socket up \
    --authkey="$TAILSCALE_AUTHKEY" --hostname="${TAILSCALE_HOSTNAME:-heroku-hararest}" \
    --accept-dns=false
fi
exec node dist/server.js
