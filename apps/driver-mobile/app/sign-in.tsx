import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '@transportco/config';
import { Banner, Button, Field, Label, Screen, theme } from '@transportco/ui';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Driver sign-in.
 *
 * Drivers are issued credentials by operations — there is no self-registration,
 * because a driver account is an employment record, not a sign-up.
 */
export default function SignIn() {
  const router = useRouter();
  const { signIn } = useSession();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setBanner(null);
    setSubmitting(true);

    try {
      await signIn(identifier.trim(), password);
      router.replace('/dashboard');
    } catch (error) {
      setBanner(error instanceof ApiError ? error.message : 'We could not sign you in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <Screen scroll>
        <View style={{ marginTop: theme.spacing['2xl'], marginBottom: theme.spacing['2xl'] }}>
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: theme.radius.lg,
              backgroundColor: theme.color.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Label variant="h2" tone="inverse">{BRAND.monogram}</Label>
          </View>
          <Label variant="h1" style={{ marginTop: theme.spacing.lg }}>Driver sign in</Label>
          <Label variant="body" tone="secondary" style={{ marginTop: 4 }}>
            Use the phone number and password operations gave you.
          </Label>
        </View>

        {banner ? <Banner message={banner} tone="danger" /> : null}

        <Field
          label="Phone number"
          value={identifier}
          onChangeText={setIdentifier}
          keyboardType="phone-pad"
          autoCapitalize="none"
          placeholder="0804 000 0001"
        />

        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry />

        <Button label="Sign in" onPress={submit} loading={submitting} />

        <Label variant="caption" tone="muted" center style={{ marginTop: theme.spacing.xl }}>
          Trouble signing in? Call operations on {BRAND.supportPhone}.
        </Label>
      </Screen>
    </SafeAreaView>
  );
}
