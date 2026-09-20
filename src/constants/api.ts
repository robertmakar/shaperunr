import Constants from 'expo-constants';
import { Platform } from 'react-native';

/** Port the local backend listens on; the LAN host is discovered at runtime. */
const BACKEND_DEV_PORT = 8787;

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, '');
}

/**
 * The LAN host Expo Go / a dev client's manifest reports Metro at, e.g.
 * "192.168.1.101:8081". Populated by @expo/cli's manifest protocol, which
 * Expo Go and expo-dev-client both use, but which a standalone/bare Debug
 * build launched from Xcode does not go through -- so this is `null` there.
 */
function getExpoManifestHost(): string | null {
  const hostUri = Constants.expoConfig?.hostUri;
  if (!hostUri) {
    return null;
  }
  const host = hostUri.split(':')[0]?.trim();
  return host || null;
}

/**
 * The host the native app actually loaded its JS bundle from, read from
 * React Native's own `SourceCode` native module (via the framework's
 * `getDevServer` helper, `react-native/Libraries/Core/Devtools/getDevServer`
 * -- the same mechanism RN's own devtools use, not a bespoke parse). This is
 * set by Metro on every Debug build that loads its bundle from the
 * packager, including a standalone app launched from Xcode, independent of
 * Expo Go's manifest protocol -- so it's the fallback for exactly the case
 * `getExpoManifestHost` can't cover. Required lazily since merely importing
 * it reaches into the native `SourceCode` module, which has no web
 * implementation.
 */
function getScriptUrlHost(): string | null {
  if (Platform.OS === 'web') {
    return null;
  }
  try {
    const getDevServer = (
      require('react-native/Libraries/Core/Devtools/getDevServer') as {
        default: () => { url: string; bundleLoadedFromServer: boolean };
      }
    ).default;
    const devServer = getDevServer();
    if (!devServer.bundleLoadedFromServer || !devServer.url) {
      return null;
    }
    const host = new URL(devServer.url).hostname;
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Development API base URL for the ShapeRunr backend.
 *
 * Never hard-code localhost or a LAN IP here: simulators, emulators, and
 * physical phones all resolve it differently, and the Mac's LAN IP changes
 * with DHCP. In development, the backend host is derived from whatever LAN
 * IP Metro is already reachable at (same Mac, port 8787 instead of 8081):
 * first via Expo Go/dev-client's manifest host, falling back to the native
 * script URL a standalone Xcode Debug build actually loaded its bundle
 * from, so both environments resolve the host without ever touching an
 * IP by hand. EXPO_PUBLIC_API_URL still works as an explicit
 * override/fallback for development, and is the only source used in
 * production -- release builds never read Metro's host at all.
 */
export function getDevelopmentApiUrl(): string | null {
  if (__DEV__) {
    const devHost = getExpoManifestHost() ?? getScriptUrlHost();
    if (devHost) {
      return `http://${devHost}:${BACKEND_DEV_PORT}`;
    }
  }

  const value = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!value) {
    return null;
  }
  return normalizeUrl(value);
}
