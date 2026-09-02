import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Field, Label, Screen, theme } from '@transportco/ui';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

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
      router.replace('/home');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'phone_not_verified') {
        // Not a failure — an unfinished sign-up. Send them to finish it.
        router.push({ pathname: '/verify', params: { phone: identifier, purpose: 'phone_verification' } });
        return;
      }
      setBanner(error instanceof ApiError ? error.message : 'We could not sign you in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <Screen scroll>
        <Label variant="h1">Welcome back</Label>
        <Label variant="body" tone="secondary" style={{ marginTop: 6, marginBottom: theme.spacing.xl }}>
          Sign in to book your next trip.
        </Label>

        {banner ? <Banner message={banner} tone="danger" /> : null}

        <Field
          label="Phone or email"
          value={identifier}
          onChangeText={setIdentifier}
          placeholder="0801 234 5678"
          autoCapitalize="none"
          autoComplete="username"
        />

        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
        />

        <View style={{ gap: theme.spacing.md }}>
          <Button label="Sign in" onPress={submit} loading={submitting} />
          <Button
            label="Forgot password"
            variant="ghost"
            onPress={() => router.push({ pathname: '/verify', params: { purpose: 'password_reset' } })}
          />
          <Button label="Create an account" variant="ghost" onPress={() => router.replace('/sign-up')} />
        </View>
      </Screen>
    </SafeAreaView>
  );
}
