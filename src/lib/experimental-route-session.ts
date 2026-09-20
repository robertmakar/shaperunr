import type { ExperimentalUserRoute } from '@/lib/experimental-routes-client';

export type SelectedExperimentalRoute = ExperimentalUserRoute & { word: string };

let selected: SelectedExperimentalRoute | null = null;

export function setSelectedExperimentalRoute(route: SelectedExperimentalRoute): void {
  selected = route;
}

export function getSelectedExperimentalRoute(): SelectedExperimentalRoute | null {
  return selected;
}

export function clearSelectedExperimentalRoute(): void {
  selected = null;
}
