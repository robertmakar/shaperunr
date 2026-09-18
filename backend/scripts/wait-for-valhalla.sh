#!/usr/bin/env bash
# Poll Valhalla until /status responds. Tile generation can take 10–30+ minutes.
set -euo pipefail

URL="${VALHALLA_URL:-http://127.0.0.1:8002}"
TRIES="${1:-60}"
SLEEP_SECONDS=10

echo "Waiting for Valhalla at $URL/status"
echo "First Egypt build can take a long time. Keep docker compose logs open in another terminal."

for ((i=1; i<=TRIES; i++)); do
  if curl -sf "$URL/status" >/dev/null; then
    echo
    echo "Valhalla reachable. Status:"
    curl -s "$URL/status"
    echo
    exit 0
  fi
  echo "  attempt $i/$TRIES — not ready yet"
  sleep "$SLEEP_SECONDS"
done

echo
echo "Valhalla did not become ready. Check:"
echo "  docker compose logs valhalla"
echo "  ls -lh data/custom_files"
exit 1
