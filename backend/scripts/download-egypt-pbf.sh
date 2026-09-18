#!/usr/bin/env bash
# Manual download of the Geofabrik Egypt extract. Never run from app/backend startup.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT/data/custom_files"
DEST="$DEST_DIR/egypt-latest.osm.pbf"
URL="https://download.geofabrik.de/africa/egypt-latest.osm.pbf"

mkdir -p "$DEST_DIR"

if [[ -f "$DEST" ]]; then
  echo "Already exists: $DEST"
  ls -lh "$DEST"
  exit 0
fi

echo "Downloading Egypt OSM extract (~169 MB) to:"
echo "  $DEST"
curl -L --fail --progress-bar -o "$DEST.partial" "$URL"
mv "$DEST.partial" "$DEST"
ls -lh "$DEST"
echo "Done. Next: cd backend && docker compose up"
