import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { InfoMeta, InfoParagraph, InfoScreen, InfoSection } from '@/components/info-screen';
import { spacing, typography, type ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';

export default function TermsScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <InfoScreen title="Terms">
      <View style={styles.intro}>
        <InfoMeta>Last updated: September 2026</InfoMeta>
        <Text style={styles.leadParagraph}>
          By using ShapeRunr, you agree to use the app responsibly and in accordance with these
          terms.
        </Text>
      </View>

      <View style={styles.divider} />

      <InfoSection heading="USING SHAPERUNR">
        <InfoParagraph>ShapeRunr is a running and route-generation tool.</InfoParagraph>
        <InfoParagraph>
          You can enter words or shapes and request routes designed to trace them through the
          streets around you.
        </InfoParagraph>
        <InfoParagraph>
          ShapeRunr does not guarantee that every generated route will be available, accessible,
          safe, or suitable for every runner.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="ROUTES ARE SUGGESTIONS">
        <InfoParagraph>Generated routes are suggestions.</InfoParagraph>
        <InfoParagraph>
          Street conditions, construction, closures, traffic, private property, pedestrian
          restrictions, weather, map-data errors and other real-world conditions can change after
          a route is generated.
        </InfoParagraph>
        <InfoParagraph>Always use your own judgment before following a route.</InfoParagraph>
      </InfoSection>

      <InfoSection heading="RUN SAFELY">
        <InfoParagraph>You are responsible for your own safety while using ShapeRunr.</InfoParagraph>
        <InfoParagraph>
          Pay attention to traffic, pedestrians, road conditions, construction, crossings and your
          surroundings.
        </InfoParagraph>
        <InfoParagraph>
          Do not enter private property, restricted areas, active construction zones, roads that
          are unsafe for pedestrians, or any area where access is prohibited.
        </InfoParagraph>
        <InfoParagraph>
          Do not use ShapeRunr while distracted or while interacting with the app in a way that
          prevents you from paying attention to your surroundings.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="LOCATION AND GPS">
        <InfoParagraph>
          ShapeRunr relies on device location and GPS for route generation and run tracking.
        </InfoParagraph>
        <InfoParagraph>
          GPS accuracy can vary depending on your device, surroundings, buildings, weather and
          other conditions.
        </InfoParagraph>
        <InfoParagraph>
          Distance, pace, position and shape-progress measurements are estimates and should not
          be treated as precise measurements.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="AVAILABILITY">
        <InfoParagraph>ShapeRunr is provided as an evolving service.</InfoParagraph>
        <InfoParagraph>
          Features, routes, map data, availability and functionality may change, be interrupted,
          or become unavailable without notice.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="ACCEPTABLE USE">
        <InfoParagraph>
          You agree not to misuse ShapeRunr, attempt to interfere with its services, circumvent
          reasonable technical restrictions, or use the service in a way that could harm ShapeRunr
          or other users.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="INTELLECTUAL PROPERTY">
        <InfoParagraph>
          The ShapeRunr name, branding, visual identity, software and original content are owned
          by or licensed to ShapeRunr and may not be copied, modified, distributed or used without
          permission, except where permitted by applicable law.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="DISCLAIMER">
        <InfoParagraph>ShapeRunr is provided for informational and recreational purposes.</InfoParagraph>
        <InfoParagraph>
          To the extent permitted by applicable law, ShapeRunr makes no guarantee that generated
          routes will be accurate, complete, available, accessible, or suitable for a particular
          purpose.
        </InfoParagraph>
        <InfoParagraph>
          You are responsible for deciding whether a route is appropriate and safe before and
          during your run.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="CHANGES">
        <InfoParagraph>
          These terms may be updated as ShapeRunr develops. When material changes are made, the
          date at the top of this page will be updated.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="CONTACT">
        <InfoParagraph>
          For questions about these terms, contact ShapeRunr through the contact information
          provided in the app or on the official ShapeRunr website.
        </InfoParagraph>
      </InfoSection>
    </InfoScreen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    intro: {
      gap: spacing.sm,
    },
    leadParagraph: {
      ...typography.body,
      color: colors.text,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
  });
}
