import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Coordinate } from '@/lib/geo';

/**
 * Local-only persistence for completed runs — "My Shapes". Deliberately a
 * standalone module rather than routed through preferences-storage.ts:
 * that module's get/setPreference contract is for single string values,
 * while this stores one growing JSON array under its own key. Still uses
 * the same `shaperunr:` namespace convention and the same
 * never-throw/best-effort philosophy as every other AsyncStorage-backed
 * store in the app.
 */
const STORAGE_KEY = 'shaperunr:runs';

export type RunHistoryRecord = {
  id: string;
  word: string;
  /** ISO 8601 timestamp of when the run finished. */
  finishedAt: string;
  distanceMeters: number;
  elapsedMs: number;
  shapeProgressPercent: number;
  completed: boolean;
  /** The target shape's own geographic coordinates — lets a future detail screen redraw the full target route. */
  targetShapeCoordinates: Coordinate[];
  /** The runner's actual GPS trail, kept as separate per-segment arrays (the same shape as RunTrackingSession.pathSegments) so a future detail screen can preserve the existing pause-boundary rendering rather than a single flattened line. */
  runnerPathSegments: Coordinate[][];
};

export type SaveRunHistoryInput = Omit<RunHistoryRecord, 'id' | 'finishedAt'>;

function generateRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sortNewestFirst(records: RunHistoryRecord[]): RunHistoryRecord[] {
  return records
    .slice()
    .sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime());
}

/** Best-effort: a failed read never throws — an empty list is a safe fallback, never a crash. */
export async function listRunHistory(): Promise<RunHistoryRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return sortNewestFirst(parsed as RunHistoryRecord[]);
  } catch {
    return [];
  }
}

/**
 * Appends exactly one record for a finished run. Best-effort, like every
 * other write in this app's AsyncStorage layer: a failure here is swallowed
 * rather than surfaced, because history persistence must never be the
 * reason a run fails to finish.
 */
export async function saveFinishedRun(input: SaveRunHistoryInput): Promise<void> {
  try {
    const existing = await listRunHistory();
    const record: RunHistoryRecord = {
      ...input,
      id: generateRunId(),
      finishedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([record, ...existing]));
  } catch {
    // Intentionally swallowed — see doc comment above.
  }
}
