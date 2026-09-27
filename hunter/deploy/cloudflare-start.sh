#!/bin/sh
# Starts the hunter on Cloudflare Containers: brings the database back from R2, keeps
# streaming it there while the site runs, and loads the sample hunt while there are no
# data keys, so the site isn't empty.
set -eu
db="${HUNTER_DB:-/data/hunter.db}"
config="${LITESTREAM_CONFIG:-/app/hunter/deploy/litestream.yml}"

if [ -n "${LITESTREAM_ACCESS_KEY_ID:-}" ]; then
  litestream restore -config "$config" -if-db-not-exists -if-replica-exists "$db"
else
  echo "WARNING: no R2 credentials; the database is lost whenever the container stops." >&2
fi

if [ -z "${KEEPA_API_KEY:-}${APIFY_TOKEN:-}" ]; then
  python -m hunter hunt --sample --if-empty
fi

if [ -n "${LITESTREAM_ACCESS_KEY_ID:-}" ]; then
  exec litestream replicate -config "$config" -exec "python -m hunter serve --port 8100"
fi
exec python -m hunter serve --port 8100
