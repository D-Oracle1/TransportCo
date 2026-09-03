import { ActivityIndicator, View } from 'react-native';
import { BRAND } from '@transportco/config';
import { Label, theme } from '@transportco/ui';

export default function Index() {
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.primaryDark, alignItems: 'center', justifyContent: 'center' }}>
      <Label variant="display" tone="inverse" style={{ letterSpacing: 4, fontSize: 48 }}>{BRAND.name}</Label>
      <Label variant="overline" tone="inverse" style={{ marginTop: 6, opacity: 0.7 }}>Driver</Label>
      <ActivityIndicator color={theme.color.textInverse} style={{ marginTop: theme.spacing.xl }} />
    </View>
  );
}
