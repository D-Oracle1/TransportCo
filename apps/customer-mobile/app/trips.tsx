import { useEffect, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Card, EmptyView, Label, Loading, theme } from '@transportco/ui';
import { api } from '@/lib/api';

interface TripRow {
  id: string;
  reference: string;
  status: string;
  statusLabel: string;
  fareLabel: string;
  pickup_address: string;
  destination_address: string;
  created_at: string;
}

/**
 * Trip history.
 *
 * Paginated rather than loaded whole: a customer on a metered connection should
 * not download two years of trips to see last week's.
 */
export default function Trips() {
  const router = useRouter();

  const [trips, setTrips] = useState<TripRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  async function load(nextPage: number) {
    const result = await api.get<{ items: TripRow[]; totalPages: number }>(
      `/trips?page=${nextPage}&pageSize=20`,
    );

    setTrips((current) => (nextPage === 1 ? result.items : [...current, ...result.items]));
    setTotalPages(result.totalPages);
    setPage(nextPage);
  }

  useEffect(() => {
    void load(1).finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <View style={{ padding: theme.layout.screenPadding, paddingBottom: theme.spacing.md }}>
        <Label variant="h1">Your trips</Label>
      </View>

      <FlatList
        data={trips}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          paddingHorizontal: theme.layout.screenPadding,
          paddingBottom: theme.spacing['3xl'],
          gap: theme.spacing.md,
        }}
        ListEmptyComponent={
          <EmptyView title="No trips yet" message="Your completed trips will appear here." />
        }
        onEndReachedThreshold={0.4}
        onEndReached={async () => {
          if (loadingMore || page >= totalPages) return;
          setLoadingMore(true);
          await load(page + 1).catch(() => undefined);
          setLoadingMore(false);
        }}
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push({ pathname: '/trip', params: { id: item.id } })}>
            <Card style={{ padding: theme.spacing.md }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Label variant="caption" tone="muted">
                  {new Date(item.created_at).toLocaleDateString('en-NG', {
                    day: 'numeric',
                    month: 'short',
                  })}
                </Label>
                <Label variant="bodyStrong">{item.fareLabel}</Label>
              </View>

              <Label variant="body" numberOfLines={1} style={{ marginTop: 6 }}>
                {item.destination_address}
              </Label>
              <Label variant="caption" tone="muted" numberOfLines={1}>
                from {item.pickup_address}
              </Label>

              <View style={{ marginTop: theme.spacing.sm }}>
                <Badge
                  label={item.statusLabel}
                  tone={
                    item.status === 'COMPLETED'
                      ? 'success'
                      : item.status === 'CANCELLED'
                        ? 'danger'
                        : 'info'
                  }
                />
              </View>
            </Card>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}
