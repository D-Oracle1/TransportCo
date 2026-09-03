import { ActivityIndicator, View } from 'react-native';
import { BRAND } from '@transportco/config';
import { Label, theme } from '@transportco/ui';

/**
 * Branded launch splash. The root layout's guard decides where to send the
 * customer; this stays calm and on-brand while that happens.
 */
export default function Index() {
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.primaryDark, alignItems: 'center', justifyContent: 'center' }}>
      <Label variant="display" tone="inverse" style={{ letterSpacing: 4, fontSize: 48 }}>{BRAND.name}</Label>
      <ActivityIndicator color={theme.color.textInverse} style={{ marginTop: theme.spacing.xl }} />
    </View>
  );
}
