import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { BackButton } from '@/components/back-button';
import { RouteMap } from '@/components/route-map';
import { Screen } from '@/components/screen';
import { ShapeCanvas } from '@/components/shape-canvas';
import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { colors, radii, spacing, typography } from '@/constants/theme';
import { flattenLetterStrokes, getLetterShape } from '@/lib/letter-shapes';
import { generateCandidateRoutes } from '@/lib/route-generator';
import { asciiPreview, runShapePocSelfTests } from '@/lib/shape-poc-self-test';

const CANDIDATE_COLORS = ['#111111', '#555555', '#999999'] as const;

export default function DebugShapeScreen() {
  const router = useRouter();
  const tests = useMemo(() => runShapePocSelfTests(), []);
  const generation = useMemo(
    () =>
      generateCandidateRoutes({
        word: 'ROBZ',
        startCoordinate: DEVELOPMENT_FALLBACK_LOCATION,
        targetDistanceMeters: 4000,
        maxCandidates: 3,
      }),
    [],
  );

  const passed = tests.filter((test) => test.passed).length;
  const letterPreviews = ['A', 'O', 'R', 'B', 'Z'].map((char) => {
    const shape = getLetterShape(char);
    return {
      char,
      points: shape ? flattenLetterStrokes(shape) : [],
    };
  });
  const primary = generation.candidates[0];

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <BackButton onPress={() => router.back()} />
          <Text style={styles.kicker}>DEVELOPMENT ONLY</Text>
        </View>

        <Text style={styles.title}>Shape POC</Text>
        <Text style={styles.warning}>{generation.warning}</Text>
        <Text style={styles.meta}>
          ROBZ · 4 km path · Cairo {DEVELOPMENT_FALLBACK_LOCATION.latitude},{' '}
          {DEVELOPMENT_FALLBACK_LOCATION.longitude}
        </Text>

        <Text style={styles.section}>SELF-TESTS {passed}/{tests.length}</Text>
        {tests.map((test) => (
          <Text key={test.name} style={[styles.test, test.passed ? styles.pass : styles.fail]}>
            {test.passed ? 'PASS' : 'FAIL'}  {test.name}
            {'\n'}
            {test.detail}
          </Text>
        ))}

        <Text style={styles.section}>LETTER GEOMETRY</Text>
        <View style={styles.letterRow}>
          {letterPreviews.map((letter) => (
            <View key={letter.char} style={styles.letterCard}>
              <Text style={styles.letterLabel}>{letter.char}</Text>
              <ShapeCanvas
                height={88}
                polylines={[{ points: letter.points, color: colors.text, width: 2 }]}
              />
            </View>
          ))}
        </View>

        <Text style={styles.section}>WORD TARGET · ROBZ</Text>
        <ShapeCanvas
          height={140}
          polylines={[{ points: generation.wordShape.points, color: colors.text, width: 2 }]}
        />
        <Text style={styles.ascii}>{asciiPreview(generation.wordShape.points, 40, 9)}</Text>

        <Text style={styles.section}>MAP · TARGET + TOP 3 MOCK ROUTES</Text>
        <RouteMap
          height={280}
          interactive
          coordinates={primary?.coordinates ?? generation.targetGeographic}
          start={DEVELOPMENT_FALLBACK_LOCATION}
          overlays={[
            {
              coordinates: primary?.targetCoordinates ?? generation.targetGeographic,
              strokeColor: colors.textMuted,
              strokeWidth: 3,
              lineDashPattern: [8, 6],
            },
            ...generation.candidates.slice(1).map((candidate, index) => ({
              coordinates: candidate.coordinates,
              strokeColor: CANDIDATE_COLORS[index + 1] ?? colors.textSecondary,
              strokeWidth: 3,
            })),
          ]}
        />

        {generation.candidates.map((candidate, index) => (
          <View key={candidate.id} style={styles.scoreCard}>
            <Text style={styles.scoreTitle}>
              CANDIDATE {index + 1} · {candidate.label}
            </Text>
            <Text style={styles.score}>
              score {candidate.score.score.toFixed(3)}
            </Text>
            <Text style={styles.detail}>
              coverage {candidate.score.coverage.toFixed(3)}
              {'  '}distErr {candidate.score.distanceError.toFixed(0)} m
              {'  '}lenErr {candidate.score.lengthError.toFixed(3)}
            </Text>
            <Text style={styles.detail}>
              length {Math.round(candidate.lengthMeters)} m vs target{' '}
            {Math.round(candidate.score.details.targetLengthMeters)} m
            {'  '}detour {candidate.score.details.detourRatio.toFixed(3)}
            {'  '}backtrack {candidate.score.details.backtrackRatio.toFixed(3)}
            </Text>
            <Text style={styles.devTag}>MOCK GRID · NOT A REAL STREET ROUTE</Text>
          </View>
        ))}

        <Pressable onPress={() => router.push('/debug-real-routes')} style={styles.done}>
          <Text style={styles.doneLabel}>REAL OSM ROUTES</Text>
        </Pressable>
        <Pressable onPress={() => router.back()} style={styles.done}>
          <Text style={styles.doneLabel}>CLOSE</Text>
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
  section: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginTop: spacing.xxl,
    marginBottom: spacing.sm,
  },
  test: {
    fontFamily: 'ui-monospace',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  pass: {
    color: colors.text,
  },
  fail: {
    color: '#8A1F1F',
  },
  letterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  letterCard: {
    flex: 1,
  },
  letterLabel: {
    ...typography.kicker,
    color: colors.text,
    marginBottom: 6,
  },
  ascii: {
    fontFamily: 'ui-monospace',
    fontSize: 10,
    lineHeight: 12,
    color: colors.text,
    marginTop: spacing.sm,
  },
  scoreCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
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
