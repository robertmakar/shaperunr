# ShapeRunr backend — local Valhalla (Mac)

Development only. The phone never talks to Valhalla, Overpass, or Geofabrik.

This guide is for **macOS on Apple Silicon** (M1/M2/M3/M4).

A real ROBZ route exists only after Valhalla has built tiles from the **Egypt** PBF and `POST /generate-routes` returns `source: "valhalla"` geometry. Until then, treat every path as not-real.

```
Docker Desktop
  → Valhalla container (port 8002)
      → egypt-latest.osm.pbf mounted at /custom_files
      → builds valhalla_tiles on first start
  → ShapeRunr backend (port 8787)
      → POST /generate-routes
  → Expo app /debug-real-routes
```

The Node backend does **not** parse the PBF. Valhalla does.

---

## 1. Install Docker Desktop

1. Download Docker Desktop for **Apple Silicon (Mac)**:  
   https://www.docker.com/products/docker-desktop/
2. Open **Docker.app** and wait until the menu-bar whale is idle.
3. Confirm in Terminal:

```bash
uname -m
# expected: arm64

docker version
docker compose version
```

If `docker: command not found`, Docker Desktop is not installed, or the app is not running.

Apple Silicon: this repo pins `platform: linux/arm64` in `docker-compose.yml` so Compose uses the native GHCR image (`ghcr.io/valhalla/valhalla-scripted:latest`) instead of x86 emulation.

---

## 2. Download the Egypt OSM extract

The file is large (~169 MB). It is **not** committed to git. The app/backend will **not** download it on startup.

From the **repository root**:

```bash
cd backend
mkdir -p data/custom_files
curl -L --fail --progress-bar \
  -o data/custom_files/egypt-latest.osm.pbf \
  https://download.geofabrik.de/africa/egypt-latest.osm.pbf
ls -lh data/custom_files/egypt-latest.osm.pbf
```

Or:

```bash
cd backend
bash scripts/download-egypt-pbf.sh
```

Source: https://download.geofabrik.de/africa/egypt.html  

Expected: `backend/data/custom_files/egypt-latest.osm.pbf` on the order of **150–200 MB**.  
If the file is a few kilobytes, the download failed (HTML error page). Delete it and retry.

This extract includes Cairo. Filename must stay `egypt-latest.osm.pbf`.

---

## 3. Start Valhalla (builds tiles the first time)

From `backend/`:

```bash
cd backend
docker compose up
```

Leave this terminal open. **First start builds the routing graph from the PBF.** That often takes **10–30+ minutes** on a Mac and uses CPU/disk heavily. Port 8002 stays silent until the build finishes.

You should see log lines about reading the PBF, `valhalla_build_tiles`, then the HTTP service starting.

Tiles are written into the same folder:

```
backend/data/custom_files/valhalla_tiles/
backend/data/custom_files/valhalla_tiles.tar
backend/data/custom_files/valhalla.json
```

Later `docker compose up` reuses those files unless the PBF changes.

Detach instead of blocking the terminal:

```bash
cd backend
docker compose up -d
docker compose logs -f valhalla
```

Stop:

```bash
cd backend
docker compose down
```

Force a full rebuild (slow — only if tiles look wrong):

```bash
cd backend
docker compose down
rm -rf data/custom_files/valhalla_tiles data/custom_files/valhalla_tiles.tar
docker compose up
```

---

## 4. Verify Valhalla

**A. Process is up**

```bash
docker compose -f backend/docker-compose.yml ps
```

Expected: `runshape-valhalla` **running**.

**B. HTTP status** (this only means the process answered — not that Cairo tiles work)

```bash
curl -s http://127.0.0.1:8002/status
```

Expected: JSON. Often includes `"version"` and `"tileset_last_modified"`.  
If this hangs or `Connection refused`, tiles are still building or the container died.

Helper:

```bash
cd backend
bash scripts/wait-for-valhalla.sh
```

**C. Pedestrian snap in Cairo** (this is the real tile check)

```bash
curl -s -X POST http://127.0.0.1:8002/locate \
  -H 'content-type: application/json' \
  -d '{"locations":[{"lat":30.0444,"lon":31.2357}],"costing":"pedestrian","verbose":false}'
```

Expected: JSON with `edges` containing `correlated_lat`, `correlated_lon`, and `way_id` near downtown Cairo — **not** an empty `edges` array.

**D. Backend health** (after step 5)

```bash
curl -s http://127.0.0.1:8787/health
```

Expected when ready:

```json
{
  "ok": true,
  "valhalla": {
    "available": true,
    "reachable": true,
    "tileDataAvailable": true,
    "pedestrianRoutingAvailable": true,
    "cairoCovered": true
  },
  "localFiles": {
    "osmPbfPresent": true,
    "valhallaTilesPresent": true
  }
}
```

`reachable: true` alone is **not** success. You need `cairoCovered: true`.

---

## 5. Start the ShapeRunr backend

In a **second** terminal:

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

Expected:

```
ShapeRunr backend (DEV) http://127.0.0.1:8787
Valhalla http://127.0.0.1:8002
```

`.env` should keep:

```
VALHALLA_URL=http://127.0.0.1:8002
```

---

## 6. Start Expo

In a **third** terminal, from the **repository root**:

```bash
cp .env.example .env
# .env must contain:
# EXPO_PUBLIC_API_URL=http://127.0.0.1:8787

npx expo start
```

| Where the app runs | `EXPO_PUBLIC_API_URL` |
| --- | --- |
| Web or iOS Simulator | `http://127.0.0.1:8787` |
| Android emulator | `http://10.0.2.2:8787` |
| Physical iPhone / Android | `http://YOUR_LAN_IP:8787` (same Wi-Fi) |

`localhost` on a physical phone is the **phone**, not your Mac.

---

## 7. Run the debug screen / first real test

In the app: **DEV · REAL OSM ROUTES** (`/debug-real-routes`).

Or from Terminal once Valhalla **and** the backend are healthy:

```bash
curl -s -X POST http://127.0.0.1:8787/generate-routes \
  -H 'content-type: application/json' \
  -d '{"word":"ROBZ","latitude":30.0444,"longitude":31.2357,"targetDistance":4000}'
```

A real result must include `"source": "valhalla"` and a `coordinates` array from Valhalla — not the mock grid. Then inspect `distanceMeters`, `shapeScore`, `coverage`, and `metadata` (chamfer / detour / backtrack / method / elapsedMs). Do not retune scoring until that geometry has been looked at.

---

## Troubleshooting

**Docker not installed**  
`docker: command not found` → install Docker Desktop (Apple Silicon) and start the app.

**Apple Silicon image problems**  
If pull fails with “no matching manifest for linux/arm64”:

```bash
docker buildx imagetools inspect ghcr.io/valhalla/valhalla-scripted:latest
```

You should see `linux/arm64`. If only `amd64` is listed, remove `platform: linux/arm64` from `docker-compose.yml` so Docker can emulate (slower). Native arm64 is preferred.

**Port 8002 already in use**

```bash
lsof -nP -iTCP:8002 -sTCP:LISTEN
docker ps
```

Stop the other process or `docker compose down` in this repo.

**Container exits immediately**

```bash
cd backend
docker compose logs valhalla
ls -lh data/custom_files
```

Usual cause: missing or tiny `egypt-latest.osm.pbf`.

**Tiles missing / still building**  
`curl :8002/status` connection refused for a long time is normal during the first build. Watch logs. Do not set `use_tiles_ignore_pbf=True` until a successful `valhalla_tiles.tar` exists.

**PBF not mounted**  
Compose maps `./data/custom_files` → `/custom_files`. The file must be:

`backend/data/custom_files/egypt-latest.osm.pbf`

not the repo root, and not named something else.

**Backend cannot connect to Valhalla**  
Health shows `reachable: false`. Start Compose first. `VALHALLA_URL` must be `http://127.0.0.1:8002` on the Mac. Do not point the **Expo app** at port 8002.

**Physical phone cannot reach localhost**  
Set `EXPO_PUBLIC_API_URL` to your Mac’s LAN IP (`ipconfig getifaddr en0`). Allow incoming connections on port 8787.

**Health: reachable but cairoCovered false**  
Status works, but `/locate` did not snap downtown Cairo. Wait for tile build to finish, confirm the PBF is Egypt, then consider a rebuild (`rm` tiles + `docker compose up`).

---

## What this stack will not do

- Download the Egypt PBF when the app or backend starts
- Commit PBF files or Valhalla tiles
- Invent streets or fall back to the mock grid
- Put these routes on `/routes` yet
