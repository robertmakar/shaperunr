import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { DistanceSelector } from '@/components/distance-selector';
import { LocationControl, type LocationControlStatus } from '@/components/location-control';
import { PrimaryButton } from '@/components/primary-button';
import { Screen } from '@/components/screen';
import { colors, spacing, typography } from '@/constants/theme';
import { formatWord } from '@/lib/format';
import type { Coordinate } from '@/lib/geo';
import { requestAndGetCurrentLocation } from '@/lib/location';

export default function HomeScreen() {
  const router = useRouter();
  const [word, setWord] = useState('');
  const [distance, setDistance] = useState(4);
  const [locationStatus, setLocationStatus] = useState<LocationControlStatus>('idle');
  const [userLocation, setUserLocation] = useState<Coordinate | null>(null);
  const canSearch = word.trim().length > 0;

  async function handleUseLocation() {
    setLocationStatus('loading');

    const result = await requestAndGetCurrentLocation();

    if (result.ok) {
      setUserLocation(result.coordinate);
      setLocationStatus('ready');
      return;
    }

    setUserLocation(null);
    setLocationStatus('unavailable');
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}>
          <View>
            <Text style={styles.logo}>RUNSHAPE</Text>

            <View style={styles.hero}>
              <Text style={styles.title}>What do you want</Text>
              <Text style={styles.title}>to run?</Text>
            </View>

            <TextInput
              value={word}
              onChangeText={setWord}
              placeholder="Type a word..."
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={12}
              style={styles.input}
            />

            <View style={styles.section}>
              <Text style={styles.label}>DISTANCE</Text>
              <DistanceSelector value={distance} onChange={setDistance} />
            </View>

            <LocationControl
              status={locationStatus}
              coordinate={userLocation}
              onPress={() => {
                void handleUseLocation();
              }}
            />
          </View>

          <View>
            <PrimaryButton
              label="FIND MY ROUTE"
              disabled={!canSearch}
              onPress={() => {
                router.push({
                  pathname: '/routes',
                  params: {
                    word: formatWord(word),
                    distance: String(distance),
                    ...(userLocation
                      ? {
                          latitude: String(userLocation.latitude),
                          longitude: String(userLocation.longitude),
                        }
                      : {}),
                  },
                });
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open developer shape proof of concept"
              onPress={() => router.push('/debug-shape')}
              style={styles.devLink}>
              <Text style={styles.devLinkText}>DEV · SHAPE POC</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open developer real OpenStreetMap route generator"
              onPress={() => router.push('/debug-real-routes')}
              style={styles.devLink}>
              <Text style={styles.devLinkText}>DEV · REAL OSM ROUTES</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'space-between',
    paddingBottom: spacing.two,
  },
  logo: {
    ...typography.logo,
    color: colors.text,
  },
  hero: {
    marginTop: spacing.hero,
    marginBottom: spacing.xxl,
  },
  title: {
    ...typography.hero,
    color: colors.text,
  },
  input: {
    height: 64,
    borderBottomWidth: 1,
    borderBottomColor: colors.text,
    ...typography.input,
    color: colors.text,
    paddingHorizontal: 0,
  },
  section: {
    marginTop: 42,
  },
  label: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginBottom: 14,
  },
  devLink: {
    marginTop: spacing.xl,
    alignSelf: 'flex-start',
  },
  devLinkText: {
    ...typography.kicker,
    color: colors.textMuted,
  },
});
