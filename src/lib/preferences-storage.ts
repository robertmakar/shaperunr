import AsyncStorage from '@react-native-async-storage/async-storage';

/** Namespaces every ShapeRunr preference key so AsyncStorage's shared, unnamespaced keyspace never collides with another library's. */
const NAMESPACE = 'shaperunr';

export async function getPreference(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(`${NAMESPACE}:${key}`);
  } catch {
    return null;
  }
}

/** Best-effort: a failed write just means the preference falls back to its default next launch, never a crash. */
export async function setPreference(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(`${NAMESPACE}:${key}`, value);
  } catch {
    // Intentionally swallowed — see doc comment above.
  }
}
