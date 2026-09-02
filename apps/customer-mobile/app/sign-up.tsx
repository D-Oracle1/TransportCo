import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { registerCustomerSchema } from '@transportco/validation';
import { Banner, Button, Field, Label, Screen, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';

/**
 * Registration.
 *
 * NO CARD IS REQUESTED HERE, and that is a product decision rather than an
 * omission: a new transport brand asking a Nigerian customer for card details
 * before delivering a single trip loses them at the first screen. Unpaid
 * cancellation fees are handled later as an outstanding balance instead.
 *
 * Validation uses the SAME schema the API enforces, so the form cannot pass
 * here and fail there for a different reason.
 */
export default function SignUp() {
  const router = useRouter();

  const [form, setForm] = useState({
    fullName: '',
    phone: '',
    email: '',
    password: '',
    referralCode: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit() {
    setBanner(null);

    const candidate = {
      fullName: form.fullName,
      phone: form.phone,
      password: form.password,
      ...(form.email ? { email: form.email } : {}),
      ...(form.referralCode ? { referralCode: form.referralCode } : {}),
    };

    const parsed = registerCustomerSchema.safeParse(candidate);

    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setErrors({});
    setSubmitting(true);

    try {
      await api.public.post<{ phone: string }>('/auth/register', parsed.data);
      router.push({ pathname: '/verify', params: { phone: parsed.data.phone, purpose: 'phone_verification' } });
    } catch (error) {
      setBanner(
        error instanceof ApiError ? error.message : 'We could not create your account. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <Screen scroll>
        <Label variant="h1">Create your account</Label>
        <Label variant="body" tone="secondary" style={{ marginTop: 6, marginBottom: theme.spacing.xl }}>
          It takes a minute. We will send a code to confirm your number.
        </Label>

        {banner ? <Banner message={banner} tone="danger" /> : null}

        <Field
          label="Full name"
          value={form.fullName}
          onChangeText={update('fullName')}
          placeholder="John Doe"
          autoCapitalize="words"
          autoComplete="name"
          error={errors.fullName}
        />

        <Field
          label="Phone number"
          value={form.phone}
          onChangeText={update('phone')}
          placeholder="0801 234 5678"
          keyboardType="phone-pad"
          autoComplete="tel"
          error={errors.phone}
          hint="We will send your confirmation code here."
        />

        <Field
          label="Email (optional)"
          value={form.email}
          onChangeText={update('email')}
          placeholder="john@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          error={errors.email}
        />

        <Field
          label="Password"
          value={form.password}
          onChangeText={update('password')}
          secureTextEntry
          autoComplete="new-password"
          error={errors.password}
          hint="At least 8 characters, with a capital letter and a number."
        />

        <Field
          label="Referral code (optional)"
          value={form.referralCode}
          onChangeText={(value) => update('referralCode')(value.toUpperCase())}
          autoCapitalize="characters"
          error={errors.referralCode}
        />

        <Banner
          tone="info"
          message="No card required. Add a payment method later, or pay with cash on the day."
        />

        <View style={{ marginTop: theme.spacing.lg, gap: theme.spacing.md }}>
          <Button label="Create account" onPress={submit} loading={submitting} />
          <Button label="I already have an account" variant="ghost" onPress={() => router.replace('/sign-in')} />
        </View>
      </Screen>
    </SafeAreaView>
  );
}
