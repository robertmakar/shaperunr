import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const backendSrcDir = dirname(fileURLToPath(import.meta.url));
export const backendRootDir = resolve(backendSrcDir, '..');
loadEnv({ path: resolve(backendRootDir, '.env') });

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() !== '' ? raw.trim() : fallback;
}

function resolveBackendPath(pathValue: string): string {
  return isAbsolute(pathValue) ? pathValue : resolve(backendRootDir, pathValue);
}

const osmPbfPath = readString('OSM_PBF_PATH', './data/custom_files/egypt-latest.osm.pbf');
const valhallaTileDir = readString('VALHALLA_TILE_DIR', './data/custom_files/valhalla_tiles');
const valhallaTileTar = resolveBackendPath('./data/custom_files/valhalla_tiles.tar');

export const config = {
  port: readNumber('PORT', 8787),
  valhallaUrl: readString('VALHALLA_URL', 'http://127.0.0.1:8002').replace(/\/$/, ''),
  valhallaTimeoutMs: readNumber('VALHALLA_TIMEOUT_MS', 25_000),
  osmPbfPath,
  osmPbfAbsolutePath: resolveBackendPath(osmPbfPath),
  valhallaTileDir,
  valhallaTileDirAbsolutePath: resolveBackendPath(valhallaTileDir),
  valhallaTileTarAbsolutePath: valhallaTileTar,
  startRadiusMeters: readNumber('START_RADIUS_METERS', 250),
  snapRadiusMeters: readNumber('SNAP_RADIUS_METERS', 100),
  distanceToleranceRatio: readNumber('DISTANCE_TOLERANCE_RATIO', 0.25),
  maxReturnedRoutes: readNumber('MAX_RETURNED_ROUTES', 3),
  candidateConcurrency: readNumber('CANDIDATE_CONCURRENCY', 3),
  minWordLength: 1,
  maxWordLength: 12,
  minDistanceMeters: 500,
  maxDistanceMeters: 20_000,
} as const;

export function localOsmFiles() {
  return {
    osmPbfPath: config.osmPbfAbsolutePath,
    osmPbfPresent: existsSync(config.osmPbfAbsolutePath),
    valhallaTileDir: config.valhallaTileDirAbsolutePath,
    valhallaTilesPresent:
      existsSync(config.valhallaTileDirAbsolutePath) || existsSync(config.valhallaTileTarAbsolutePath),
    valhallaTileTarPath: config.valhallaTileTarAbsolutePath,
    valhallaTileTarPresent: existsSync(config.valhallaTileTarAbsolutePath),
  };
}
