import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useResolvedAppearance, useThemeColors } from '@/hooks/use-theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colors = useThemeColors();
  const resolvedAppearance = useResolvedAppearance();

  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return (
    // Required by react-native-gesture-handler (used by Home's left-edge
    // swipe-to-exit-Finding gesture) for any GestureDetector to receive touches.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style={resolvedAppearance === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      />
    </GestureHandlerRootView>
  );
}
