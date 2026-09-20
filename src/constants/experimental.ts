/**
 * DEVELOPMENT ONLY.
 * When true, Home FIND MY ROUTE uses the experimental graph-constrained pipeline.
 * The mock `/routes` screen and production generator stay unchanged.
 * Set EXPO_PUBLIC_EXPERIMENTAL_ROUTES=false to restore mock Home → Routes.
 */
export const EXPERIMENTAL_ROUTES = process.env.EXPO_PUBLIC_EXPERIMENTAL_ROUTES !== 'false';

/**
 * DEVELOPMENT ONLY. When true, experimental search uses the known-good
 * Alexandria diagnostic pin instead of phone GPS. No production UI.
 * Default off. Set EXPO_PUBLIC_DEBUG_FIXED_ALEXANDRIA=true to compare
 * phone-path vs geography.
 */
export const DEBUG_FIXED_ALEXANDRIA = process.env.EXPO_PUBLIC_DEBUG_FIXED_ALEXANDRIA === 'true';

export const ALEXANDRIA_DIAGNOSTIC_COORDINATE = {
  latitude: 31.227549,
  longitude: 29.94947,
} as const;
