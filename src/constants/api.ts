/**
 * Development API base URL for the RunShape backend.
 *
 * Never hard-code localhost here: simulators, emulators, and physical
 * phones all resolve it differently. Set EXPO_PUBLIC_API_URL.
 */
export function getDevelopmentApiUrl(): string | null {
  const value = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!value) {
    return null;
  }
  return value.replace(/\/$/, '');
}
