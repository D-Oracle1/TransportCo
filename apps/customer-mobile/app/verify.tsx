import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AuthenticatedSession } from '@transportco/types';
import { Banner, Button, Field, Label, Screen, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Phone verification.
 *
 * The resend timer is a courtesy on top of the server-side limit — each SMS
 * costs money, and a customer tapping "resend" five times is the most common
 * way that bill grows.
 */
export default function Verify() {
  const router = useRouter();
  const { completeVerification } = useSession();
  const params = useLocalSearchParams<{ phone?: string; purpose?: string }>();

  const [phone, setPhone] = useState(params.phone ?? '');
  const [code, setCode] = useState('');
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(45);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function verify() {
    setBanner(null);
    setSubmitting(true);

    try {
      const result = await api.public.post<{ verified: boolean; session?: AuthenticatedSession }>(
        '/auth/verify-otp',
        { phone, code, purpose: params.purpose ?? 'phone_verification' },
      );

      if (result.session) {
        await completeVerification(result.session);
        router.replace('/home');
      } else {
        router.replace('/sign-in');
      }
    } catch (error) {
      setBanner(error instanceof ApiError ? error.message : 'That code did not work. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    setBanner(null);
    try {
      await api.public.post('/auth/otp/request', {
        phone,
        purpose: params.purpose ?? 'phone_verification',
      });
      setCooldown(45);
      setBanner('We have sent a new code.');
    } catch (error) {
      setBanner(error instanceof ApiError ? error.message : 'We could not send a new code right now.');
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <Screen scroll>
        <Label variant="h1">Confirm your number</Label>
        <Label variant="body" tone="secondary" style={{ marginTop: 6, marginBottom: theme.spacing.xl }}>
          Enter the 6-digit code we sent you.
        </Label>

        {banner ? <Banner message={banner} tone="info" /> : null}

        {!params.phone ? (
          <Field
            label="Phone number"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            placeholder="0801 234 5678"
          />
        ) : null}

        <Field
          label="Verification code"
          value={code}
          onChangeText={(value) => setCode(value.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          maxLength={6}
          placeholder="123456"
          autoComplete="sms-otp"
        />

        <View style={{ gap: theme.spacing.md }}>
          <Button label="Confirm" onPress={verify} loading={submitting} disabled={code.length < 4} />
          <Button
            label={cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
            variant="ghost"
            onPress={resend}
            disabled={cooldown > 0}
          />
        </View>
      </Screen>
    </SafeAreaView>
  );
}
