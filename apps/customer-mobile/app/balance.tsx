import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, EmptyView, Label, Loading, Screen, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Outstanding balance.
 *
 * The direct consequence of not demanding a card at sign-up: a cancellation or
 * no-show fee becomes a visible debt the customer settles deliberately, rather
 * than a silent charge to a card we never asked for. Showing exactly what is
 * owed and why is what keeps that trade honest.
 */

interface BalanceView {
  totalMinor: number;
  totalLabel: string;
  items: Array<{
    id: string;
    reason: string;
    outstandingLabel: string;
    tripReference: string | null;
    since: string;
  }>;
}

const REASON_LABELS: Record<string, string> = {
  cancellation_fee: 'Cancellation fee',
  no_show_fee: 'No-show fee',
  failed_payment: 'Unpaid trip',
  manual_adjustment: 'Adjustment',
};

export default function Balance() {
  const router = useRouter();
  const { refreshProfile } = useSession();

  const [balance, setBalance] = useState<BalanceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    void api
      .get<BalanceView>('/customer/me/balances')
      .then(setBalance)
      .catch(() => setBanner('We could not load your balance.'))
      .finally(() => setLoading(false));
  }, []);

  async function settle() {
    setPaying(true);
    setBanner(null);

    try {
      const payment = await api.post<{ authorizationUrl: string | null }>('/payments/initialize', {
        purpose: 'outstanding_balance',
        method: 'card',
      });

      if (payment.authorizationUrl) {
        await Linking.openURL(payment.authorizationUrl);
      } else {
        setBanner('Payment started. We will confirm once it clears.');
      }

      await refreshProfile();
    } catch (error) {
      setBanner(
        error instanceof ApiError
          ? error.message
          : 'Payment could not be completed. Please try again or choose another method.',
      );
    } finally {
      setPaying(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <Screen scroll>
        <Label variant="h1">Your balance</Label>

        {banner ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner message={banner} tone="info" />
          </View>
        ) : null}

        {!balance || balance.items.length === 0 ? (
          <View style={{ marginTop: theme.spacing['2xl'] }}>
            <EmptyView title="Nothing owed" message="You are all settled up." />
            <Button
              label="Back to home"
              variant="ghost"
              onPress={() => router.replace('/home')}
              style={{ marginTop: theme.spacing.lg }}
            />
          </View>
        ) : (
          <>
            <Card style={{ marginTop: theme.spacing.lg, alignItems: 'center' }}>
              <Label variant="overline" tone="muted">
                Total outstanding
              </Label>
              <Label variant="fare" style={{ marginTop: 6 }}>
                {balance.totalLabel}
              </Label>
            </Card>

            <Label variant="overline" tone="muted" style={{ marginTop: theme.spacing.xl }}>
              What this is for
            </Label>

            {balance.items.map((item) => (
              <Card key={item.id} style={{ marginTop: theme.spacing.md, padding: theme.spacing.md }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Label variant="bodyStrong">{REASON_LABELS[item.reason] ?? item.reason}</Label>
                  <Label variant="bodyStrong">{item.outstandingLabel}</Label>
                </View>
                <Label variant="caption" tone="muted" style={{ marginTop: 2 }}>
                  {item.tripReference ? `Trip ${item.tripReference} · ` : ''}
                  {new Date(item.since).toLocaleDateString('en-NG')}
                </Label>
              </Card>
            ))}

            <Button
              label={`Pay ${balance.totalLabel}`}
              variant="accent"
              onPress={settle}
              loading={paying}
              style={{ marginTop: theme.spacing.xl }}
            />
            <Button
              label="Back"
              variant="ghost"
              onPress={() => router.back()}
              style={{ marginTop: theme.spacing.md }}
            />
          </>
        )}
      </Screen>
    </SafeAreaView>
  );
}
