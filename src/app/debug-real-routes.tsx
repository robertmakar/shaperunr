import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { BackButton } from '@/components/back-button';
import { PrimaryButton } from '@/components/primary-button';
import { RouteMap } from '@/components/route-map';
import { Screen } from '@/components/screen';
import { ShapeCanvas } from '@/components/shape-canvas';
import { getDevelopmentApiUrl } from '@/constants/api';
import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { colors, radii, spacing, typography } from '@/constants/theme';
import { flattenLetterStrokes, getLetterShape } from '@/lib/letter-shapes';
import {
  generateRealRoutesFromBackend,
  type RealGenerateRoutesError,
  type RealGeneratedRoute,
  type RealGenerateRoutesResponse,
} from '@/lib/real-routes-client';
import { buildWordShape } from '@/lib/word-shape';

function selectedRoute(
  result: RealGenerateRoutesResponse | null,
  selectedRouteId: string | null,
): RealGeneratedRoute | undefined {
  if (!result || result.routes.length === 0) {
    return undefined;
  }
  return result.routes.find((route) => route.id === selectedRouteId) ?? result.routes[0];
}

export default function DebugRealRoutesScreen() {
  const router = useRouter();
  const apiUrl = getDevelopmentApiUrl();
  const [word, setWord] = useState('ROBZ');
  const [distance, setDistance] = useState('4000');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<RealGenerateRoutesError | null>(null);
  const [result, setResult] = useState<RealGenerateRoutesResponse | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  const preview = buildWordShape(word);
  const selected = selectedRoute(result, selectedRouteId);

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedRouteId(null);

    const targetDistanceMeters = Number(distance);
    const response = await generateRealRoutesFromBackend({
      word,
      start: DEVELOPMENT_FALLBACK_LOCATION,
      targetDistanceMeters: Number.isFinite(targetDistanceMeters) ? targetDistanceMeters : 4000,
    });

    setLoading(false);
    if (!response.ok) {
      setError(response);
      return;
    }
    setResult(response.data);
    setSelectedRouteId(response.data.routes[0]?.id ?? null);
  }

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <BackButton onPress={() => router.back()} />
          <Text style={styles.kicker}>DEVELOPMENT / REAL VALHALLA</Text>
        </View>

        <Text style={styles.title}>Real Valhalla routes</Text>
        <Text style={styles.warning}>
          DEVELOPMENT / REAL VALHALLA. Full OSM pedestrian geometry from POST /generate-routes.
          Not mock grid. Not shown on Home → Routes → Run.
        </Text>

        <Text style={styles.meta}>
          Location · Cairo {DEVELOPMENT_FALLBACK_LOCATION.latitude},{' '}
          {DEVELOPMENT_FALLBACK_LOCATION.longitude}
        </Text>
        <Text style={styles.meta}>API · {apiUrl ?? 'EXPO_PUBLIC_API_URL is not set'}</Text>

        <Text style={styles.label}>WORD</Text>
        <TextInput
          value={word}
          onChangeText={setWord}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
          style={styles.input}
        />

        <Text style={styles.label}>DISTANCE (m)</Text>
        <TextInput
          value={distance}
          onChangeText={setDistance}
          keyboardType="number-pad"
          style={styles.input}
        />

        <View style={styles.buttonWrap}>
          <PrimaryButton
            label={loading ? 'GENERATING…' : 'GENERATE REAL ROUTES'}
            disabled={loading || word.trim().length === 0}
            onPress={() => {
              void handleGenerate();
            }}
          />
        </View>

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.text} />
            <Text style={styles.detail}>Asking the backend for Valhalla pedestrian routes…</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>REAL ROUTE GENERATION FAILED</Text>
            <Text style={styles.errorBody}>
              {error.code} · {error.message}
            </Text>
            {error.failures.slice(0, 4).map((failure, index) => (
              <Text key={`${failure.code}-${index}`} style={styles.detail}>
                {failure.candidateId ?? 'candidate'} · {failure.code} · {failure.message}
              </Text>
            ))}
            <Text style={styles.devTag}>NO MOCK FALLBACK</Text>
          </View>
        ) : null}

        <Text style={styles.section}>TARGET WORD GEOMETRY</Text>
        <ShapeCanvas
          height={140}
          polylines={[{ points: preview.points, color: colors.text, width: 2 }]}
        />
        <View style={styles.letterRow}>
          {Array.from(preview.word).map((char, index) => {
            const shape = getLetterShape(char);
            return (
              <View key={`${char}-${index}`} style={styles.letterCard}>
                <Text style={styles.letterLabel}>{char}</Text>
                <ShapeCanvas
                  height={64}
                  polylines={[{ points: shape ? flattenLetterStrokes(shape) : [], width: 2 }]}
                />
              </View>
            );
          })}
        </View>

        {result ? (
          <>
            <Text style={styles.section}>MAP · SELECTED VALHALLA ROUTE</Text>
            <Text style={styles.meta}>
              {result.elapsedMs} ms · {result.routes.length} real route(s) · source {result.source}
            </Text>
            <Text style={styles.meta}>
              Inspecting {selected?.id ?? 'none'} · tap a candidate below to compare
            </Text>
            {selected ? (
              <RouteMap
                key={selected.id}
                height={280}
                interactive
                coordinates={selected.coordinates}
                start={result.start}
                overlays={[
                  {
                    coordinates: selected.targetCoordinates,
                    strokeColor: colors.textMuted,
                    strokeWidth: 3,
                    lineDashPattern: [8, 6],
                  },
                ]}
              />
            ) : null}
            <Text style={styles.legend}>
              Dashed = this candidate’s targetCoordinates · Solid = returned Valhalla coordinates
            </Text>

            {result.routes.map((route, index) => {
              const isSelected = route.id === selected?.id;
              return (
                <Pressable
                  key={route.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`Inspect ${route.id}, ${Math.round(route.distanceMeters)} meters, shape score ${route.shapeScore.toFixed(3)}`}
                  onPress={() => setSelectedRouteId(route.id)}
                  style={[styles.scoreCard, isSelected ? styles.scoreCardSelected : null]}>
                  <Text style={styles.scoreTitle}>
                    {isSelected ? 'SELECTED · ' : ''}
                    {route.id} · CANDIDATE {index + 1} · {route.metadata.rotationDegrees}° ×{' '}
                    {route.metadata.scale.toFixed(2)}
                  </Text>
                  <Text style={styles.score}>
                    {Math.round(route.distanceMeters)} m · score {route.shapeScore.toFixed(3)}
                  </Text>
                  <Text style={styles.detail}>
                    proximity {route.scoreBreakdown.proximity.toFixed(3)}
                    {'  '}coverage {route.scoreBreakdown.coverage.toFixed(3)}
                    {'  '}order {route.scoreBreakdown.order.toFixed(3)}
                  </Text>
                  <Text style={styles.detail}>
                    length {route.scoreBreakdown.lengthFit.toFixed(3)}
                    {'  '}detour {route.scoreBreakdown.detour.toFixed(3)}
                    {'  '}backtrack {route.scoreBreakdown.backtrack.toFixed(3)}
                    {'  '}final {route.scoreBreakdown.finalScore.toFixed(3)}
                  </Text>
                  <Text style={styles.detail}>
                    distErr {route.metadata.distanceError.toFixed(0)} m
                    {'  '}
                    {route.coordinates.length} coords
                    {'  '}method {route.metadata.method}
                  </Text>
                  <Text style={styles.devTag}>DEVELOPMENT / REAL VALHALLA · OSM PEDESTRIAN</Text>
                </Pressable>
              );
            })}
          </>
        ) : null}

        <Pressable onPress={() => router.push('/debug-shape')} style={styles.done}>
          <Text style={styles.doneLabel}>MOCK SHAPE POC</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing.xxxl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  kicker: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  title: {
    ...typography.title,
    color: colors.text,
    marginTop: spacing.lg,
  },
  warning: {
    ...typography.meta,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  meta: {
    ...typography.body,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  label: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginTop: spacing.xl,
    marginBottom: 8,
  },
  input: {
    height: 52,
    borderBottomWidth: 1,
    borderBottomColor: colors.text,
    ...typography.input,
    color: colors.text,
    paddingHorizontal: 0,
  },
  buttonWrap: {
    marginTop: spacing.xl,
  },
  loading: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  errorCard: {
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  errorTitle: {
    ...typography.kicker,
    color: '#8A1F1F',
  },
  errorBody: {
    ...typography.meta,
    color: colors.text,
    marginTop: 8,
  },
  section: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginTop: spacing.xxl,
    marginBottom: spacing.sm,
  },
  letterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  letterCard: {
    flex: 1,
  },
  letterLabel: {
    ...typography.kicker,
    color: colors.text,
    marginBottom: 6,
  },
  legend: {
    ...typography.meta,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  scoreCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  scoreCardSelected: {
    borderColor: colors.text,
    backgroundColor: colors.surfaceAlt,
  },
  scoreTitle: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  score: {
    ...typography.title,
    color: colors.text,
    marginTop: 6,
  },
  detail: {
    ...typography.meta,
    color: colors.textSecondary,
    marginTop: 4,
  },
  devTag: {
    ...typography.kicker,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  done: {
    marginTop: spacing.xxl,
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  doneLabel: {
    ...typography.cta,
    color: colors.text,
  },
});
