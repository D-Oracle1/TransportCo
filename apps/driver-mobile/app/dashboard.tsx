import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatDistance, formatMoney } from '@transportco/utils';
import { Badge, Banner, Button, Card, Label, Loading, theme } from '@transportco/ui';
import { useSession } from '@/lib/session';
import { locationReporter } from '@/lib/location';

/**
 * Driver home.
 *
 * Built for a glance at a traffic light: one big control for availability, then
 * the trip in hand. Nothing on this screen invites browsing — a driver reading
 * a list while driving is a safety problem, not a UX one.
 *
 * Note what is absent: no fare editing, no negotiation, no trip selection. The
 * driver executes assigned work.
 */
export default function Dashboard() {
  const router = useRouter();
  const { dashboard, refresh, setAvailability, signOut } = useSession();

  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [connection, setConnection] = useState({ online: true, queued: 0 });

  // Surfaces the offline queue so a driver knows their trip updates are held,
  // not lost.
  useEffect(() => locationReporter.onStatusChange((online, queued) => setConnection({ online, queued })), []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  if (!dashboard) return <Loading />;

  const { driver, today, activeTrips, upcomingTrips } = dashboard;
  const isOnline = driver.state !== 'OFFLINE' && driver.state !== 'SUSPENDED';
  const activeTrip = activeTrips[0];

  async function toggleAvailability() {
    setBusy(true);
    setBanner(null);

    try {
      await setAvailability(isOnline ? 'OFFLINE' : 'AVAILABLE');
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'We could not change your status.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <ScrollView
        contentContainerStyle={{ padding: theme.layout.screenPadding, paddingBottom: theme.spacing['3xl'] }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        }
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Label variant="caption" tone="muted">
              Signed in as
            </Label>
            <Label variant="h2">{driver.fullName}</Label>
            {driver.vehicle ? (
              <Label variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {driver.vehicle.make} {driver.vehicle.model} · {driver.vehicle.plateNumber}
              </Label>
            ) : (
              <Label variant="caption" tone="danger" style={{ marginTop: 2 }}>
                No vehicle assigned — contact operations
              </Label>
            )}
          </View>

          <Badge
            label={driver.state.replace(/_/g, ' ').toLowerCase()}
            tone={isOnline ? 'success' : 'neutral'}
          />
        </View>

        {!connection.online ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner
              tone="warning"
              message={`You are offline. ${connection.queued} location update(s) will be sent when you reconnect.`}
            />
          </View>
        ) : null}

        {banner ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner message={banner} tone="danger" />
          </View>
        ) : null}

        <Card
          style={{
            marginTop: theme.spacing.xl,
            backgroundColor: isOnline ? theme.color.successBg : theme.color.surfaceMuted,
            borderColor: isOnline ? theme.color.success : theme.color.border,
          }}
        >
          <Label variant="h3">{isOnline ? 'You are online' : 'You are offline'}</Label>
          <Label variant="caption" tone="secondary" style={{ marginTop: 4, marginBottom: theme.spacing.md }}>
            {isOnline
              ? 'Dispatch can assign you trips. Your location is shared with operations.'
              : 'You will not receive trips while offline.'}
          </Label>

          <Button
            label={isOnline ? 'Go offline' : 'Go online'}
            variant={isOnline ? 'secondary' : 'primary'}
            onPress={toggleAvailability}
            loading={busy}
            disabled={!driver.vehicle && !isOnline}
          />
        </Card>

        {activeTrip ? (
          <Pressable
            onPress={() => router.push({ pathname: '/trip', params: { id: activeTrip.id } })}
            style={{ marginTop: theme.spacing.lg }}
          >
            <Card style={{ borderColor: theme.color.accent, borderWidth: 2 }}>
              <Badge label="Current trip" tone="accent" />

              <Label variant="h3" style={{ marginTop: theme.spacing.md }}>
                {activeTrip.customer_name}
              </Label>

              <Label variant="caption" tone="muted" style={{ marginTop: theme.spacing.md }}>
                Pickup
              </Label>
              <Label variant="body">{activeTrip.pickup_address}</Label>

              <Label variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
                Destination
              </Label>
              <Label variant="body">{activeTrip.destination_address}</Label>

              <View
                style={{
                  marginTop: theme.spacing.md,
                  paddingTop: theme.spacing.md,
                  borderTopWidth: 1,
                  borderTopColor: theme.color.border,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <View>
                  <Label variant="caption" tone="muted">
                    Agreed fare
                  </Label>
                  <Label variant="h3">{formatMoney(activeTrip.final_fare_minor ?? 0)}</Label>
                </View>
                <Badge label={(activeTrip.payment_method ?? 'cash').replace('_', ' ')} tone="info" />
              </View>
            </Card>
          </Pressable>
        ) : (
          <Card style={{ marginTop: theme.spacing.lg }}>
            <Label variant="bodyStrong">
              {isOnline ? 'Waiting for your next trip' : 'Go online to receive trips'}
            </Label>
            <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
              Operations assigns trips. You will be notified as soon as one is yours.
            </Label>
          </Card>
        )}

        <View style={{ flexDirection: 'row', gap: theme.spacing.md, marginTop: theme.spacing.lg }}>
          <Card style={{ flex: 1 }}>
            <Label variant="overline" tone="muted">
              Trips today
            </Label>
            <Label variant="h1">{today.trips}</Label>
          </Card>
          <Card style={{ flex: 1 }}>
            <Label variant="overline" tone="muted">
              Distance today
            </Label>
            <Label variant="h1">{formatDistance(today.distanceMetres)}</Label>
          </Card>
        </View>

        {upcomingTrips.length > 0 ? (
          <View style={{ marginTop: theme.spacing.xl }}>
            <Label variant="overline" tone="muted">
              Scheduled for you
            </Label>

            {upcomingTrips.map((trip) => (
              <Card key={trip.id} style={{ marginTop: theme.spacing.md, padding: theme.spacing.md }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Label variant="bodyStrong">{trip.customer_name}</Label>
                  <Label variant="bodyStrong">
                    {new Date(trip.scheduled_pickup_at).toLocaleTimeString('en-NG', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Label>
                </View>
                <Label variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
                  {trip.pickup_address}
                </Label>
              </Card>
            ))}
          </View>
        ) : null}

        <View style={{ marginTop: theme.spacing['2xl'], gap: theme.spacing.md }}>
          <Button label="My trip history" variant="secondary" onPress={() => router.push('/history')} />
          <Button label="Sign out" variant="ghost" onPress={signOut} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
