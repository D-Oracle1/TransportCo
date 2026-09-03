import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '@transportco/config';
import { Button, Label, theme } from '@transportco/ui';

/**
 * Welcome.
 *
 * States the promise the product is built around — an agreed fare with a
 * company driver — because that is what distinguishes TransportCo from the
 * apps this customer already has installed.
 */
export default function Welcome() {
  const router = useRouter();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.primary }}>
      <View style={{ flex: 1, padding: theme.layout.screenPadding, justifyContent: 'space-between' }}>
        <View style={{ marginTop: theme.spacing['4xl'] }}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: theme.radius.lg,
              backgroundColor: theme.color.accent,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: theme.spacing.xl,
            }}
          >
            <Label variant="h1" style={{ color: theme.color.onAccent }}>
              {BRAND.monogram}
            </Label>
          </View>

          <Label variant="display" tone="inverse">
            {BRAND.name}
          </Label>

          <Label variant="h3" tone="inverse" style={{ marginTop: theme.spacing.md, opacity: 0.9 }}>
            {BRAND.tagline}
          </Label>

          <View style={{ marginTop: theme.spacing['2xl'], gap: theme.spacing.md }}>
            <Label variant="body" tone="inverse" style={{ opacity: 0.85 }}>
              See your fare before you book — and tell us if it is too high.
            </Label>
            <Label variant="body" tone="inverse" style={{ opacity: 0.85 }}>
              Every driver is a PEGO employee in a company vehicle.
            </Label>
            <Label variant="body" tone="inverse" style={{ opacity: 0.85 }}>
              Pay with cash, transfer or card. No card needed to sign up.
            </Label>
          </View>
        </View>

        <View style={{ gap: theme.spacing.md }}>
          <Button label="Create an account" variant="accent" onPress={() => router.push('/sign-up')} />
          <Button label="I already have an account" variant="ghost" onPress={() => router.push('/sign-in')} />
        </View>
      </View>
    </SafeAreaView>
  );
}
