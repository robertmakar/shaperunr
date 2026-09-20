/**
 * Home → Finding visual handoff timing.
 * Does not affect routing or generation.
 */
export const HOME_HANDOFF_MS = 560;

export function shouldPlayHomeHandoff(input: {
  canSearch: boolean;
  reduceMotion: boolean;
  alreadyLocked: boolean;
}): boolean {
  return input.canSearch && !input.reduceMotion && !input.alreadyLocked;
}

export function homeHandoffDuration(reduceMotion: boolean): number {
  return reduceMotion ? 0 : HOME_HANDOFF_MS;
}
