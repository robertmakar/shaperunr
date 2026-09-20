import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { InfoMeta, InfoParagraph, InfoScreen, InfoSection } from '@/components/info-screen';
import { spacing, typography, type ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';

export default function PrivacyScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <InfoScreen title="Privacy">
      <View style={styles.intro}>
        <InfoMeta>Last updated: September 2026</InfoMeta>
        <Text style={styles.leadParagraph}>
          ShapeRunr is built around your location, because your location is what allows us to
          find routes around you. We try to keep the amount of information we collect and retain
          as small as possible.
        </Text>
      </View>

      <View style={styles.divider} />

      <InfoSection heading="LOCATION">
        <InfoParagraph>
          When you ask ShapeRunr to find a route, the app uses your device’s location to
          determine where your route should start.
        </InfoParagraph>
        <InfoParagraph>
          Your starting location is sent to the ShapeRunr backend so that the routing system can
          search the streets around you and generate routes.
        </InfoParagraph>
        <InfoParagraph>ShapeRunr does not need your location when you are simply browsing the app.</InfoParagraph>
      </InfoSection>

      <InfoSection heading="RUNNING LOCATION">
        <InfoParagraph>
          When you start a run, ShapeRunr uses foreground location from your device to track your
          movement, distance, pace and progress along the route.
        </InfoParagraph>
        <InfoParagraph>
          Your run tracking is used to provide the running experience inside the app.
        </InfoParagraph>
        <InfoParagraph>
          Run/session history is currently stored locally on your device. ShapeRunr does not
          currently provide cloud syncing or a user account system for your running history.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="ROUTE GENERATION">
        <InfoParagraph>
          When you request a route, ShapeRunr sends the information necessary to generate that
          route to its backend, including your starting location and the requested shape/distance.
        </InfoParagraph>
        <InfoParagraph>
          The backend uses mapping and routing data to generate candidate pedestrian routes.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="ACCOUNTS">
        <InfoParagraph>
          ShapeRunr currently does not require an account, login, email address, name, or
          password.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="ANALYTICS">
        <InfoParagraph>
          ShapeRunr does not currently use a third-party analytics service to build a profile of
          how you use the app.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="THIRD-PARTY SERVICES">
        <InfoParagraph>ShapeRunr uses mapping and routing technology to generate routes.</InfoParagraph>
        <InfoParagraph>
          Some route-generation processing takes place on ShapeRunr’s backend infrastructure
          rather than directly on your device.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="LOCAL DATA">
        <InfoParagraph>
          ShapeRunr stores certain information locally on your device, including app preferences
          and run/session information needed by the app.
        </InfoParagraph>
        <InfoParagraph>
          You can remove locally stored app data by deleting ShapeRunr from your device, subject
          to the normal behavior of your device and operating system.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="DATA RETENTION">
        <InfoParagraph>
          ShapeRunr is designed to avoid maintaining a cloud-based history of your completed runs.
        </InfoParagraph>
        <InfoParagraph>
          Location information sent for route generation is used to generate the requested route.
          ShapeRunr does not currently provide a user-facing cloud location history.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="YOUR CHOICES">
        <InfoParagraph>
          You can control whether ShapeRunr has access to your device’s location through your
          operating system’s privacy settings.
        </InfoParagraph>
        <InfoParagraph>
          If you deny location access, route generation and running features that require
          location may not work.
        </InfoParagraph>
        <InfoParagraph>You can also delete the app and its locally stored data from your device.</InfoParagraph>
      </InfoSection>

      <InfoSection heading="CHANGES TO THIS POLICY">
        <InfoParagraph>
          As ShapeRunr develops, the way the app handles information may change. If we make
          material changes to this policy, we will update the date shown at the top of this page.
        </InfoParagraph>
      </InfoSection>

      <InfoSection heading="CONTACT">
        <InfoParagraph>
          For privacy questions, contact ShapeRunr through the contact information provided in the
          app or on the official ShapeRunr website.
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
