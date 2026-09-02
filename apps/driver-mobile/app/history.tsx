import { useEffect, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatMoney } from '@transportco/utils';
import { Badge, Button, Card, EmptyView, Label, Loading, theme } from '@transportco/ui';
import { api } from '@/lib/api';

interface TripRow {
  id: string;
  reference: string;
  status: string;
  pickup_address: string;
  destination_address: string;
  final_fare_minor: number | null;
  payment_method: string | null;
  payment_status: string;
  completed_at: string | null;
  created_at: string;
}

/**
 * Driver trip history.
 *
 * Shows what was collected and how, because the first question a driver has at
 * the end of a shift is what they owe the office in cash.
 */
export default function History() {
  const router = useRouter();
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void api
      .get<{ items: TripRow[] }>('/drivers/me/trips?pageSize=30')
      .then((result) => setTrips(result.items))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;

  const cashToday = trips
    .filter(
      (trip) =>
        trip.payment_method === 'cash' &&
        trip.payment_status === 'paid' &&
        trip.completed_at &&
        new Date(trip.completed_at).toDateString() === new Date().toDateString(),
    )
    .reduce((total, trip) => total + (trip.final_fare_minor ?? 0), 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <View style={{ padding: theme.layout.screenPadding }}>
        <Label variant="h1">Your trips</Label>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <Label variant="overline" tone="muted">
            Cash collected today
          </Label>
          <Label variant="h2">{formatMoney(cashToday)}</Label>
          <Label variant="caption" tone="muted" style={{ marginTop: 2 }}>
            Hand this in at the end of your shift.
          </Label>
        </Card>
      </View>

      <FlatList
        data={trips}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          paddingHorizontal: theme.layout.screenPadding,
          paddingBottom: theme.spacing['3xl'],
          gap: theme.spacing.md,
        }}
        ListEmptyComponent={<EmptyView title="No trips yet" />}
        renderItem={({ item }) => (
          <Card style={{ padding: theme.spacing.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Label variant="bodyStrong">{item.reference}</Label>
              <Label variant="bodyStrong">{formatMoney(item.final_fare_minor ?? 0)}</Label>
            </View>
            <Label variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 4 }}>
              {item.pickup_address} → {item.destination_address}
            </Label>
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
              <Badge
                label={item.status.replace(/_/g, ' ').toLowerCase()}
                tone={item.status === 'COMPLETED' ? 'success' : 'neutral'}
              />
              <Badge
                label={item.payment_status === 'paid' ? 'paid' : 'unpaid'}
                tone={item.payment_status === 'paid' ? 'success' : 'warning'}
              />
            </View>
          </Card>
        )}
      />

      <View style={{ padding: theme.layout.screenPadding }}>
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </View>
    </SafeAreaView>
  );
}
