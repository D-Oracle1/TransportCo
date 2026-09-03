import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatDistance, formatMoney } from '@transportco/utils';
import { Banner, Button, Card, Label, Loading, theme } from '@transportco/ui';
import { useSession } from '@/lib/session';
import { locationReporter } from '@/lib/location';

/**
 * Driver home.
 *
 * Built for a glance at a traffic light: one big availability control, then the
 * trip in hand. Monochrome and high-contrast so the state — online or not, a
 * trip or not — reads instantly. No fare editing, no negotiation, no trip
 * selection: the driver executes assigned work.
 */
export default function Dashboard() {
  const router = useRouter();
  const { dashboard, refresh, setAvailability, signOut } = useSession();

  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [connection, setConnection] = useState({ online: true, queued: 0 });

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
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }} edges={['top']}>
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
        {/* header */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Label variant="caption" tone="muted">Driver</Label>
            <Label variant="h1">{driver.fullName}</Label>
            {driver.vehicle ? (
              <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
                {driver.vehicle.make} {driver.vehicle.model} · {driver.vehicle.plateNumber}
              </Label>
            ) : (
              <Label variant="caption" tone="danger" style={{ marginTop: 4 }}>
                No vehicle assigned — contact operations
              </Label>
            )}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isOnline ? theme.color.text : theme.color.borderStrong }} />
            <Label variant="caption" tone={isOnline ? 'default' : 'muted'}>{isOnline ? 'Online' : 'Offline'}</Label>
          </View>
        </View>

        {!connection.online ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner tone="warning" message={`Offline — ${connection.queued} update(s) will send when you reconnect.`} />
          </View>
        ) : null}
        {banner ? <View style={{ marginTop: theme.spacing.lg }}><Banner message={banner} tone="danger" /></View> : null}

        {/* availability hero — dark when online, light when off */}
        <Card
          style={{
            marginTop: theme.spacing.xl,
            backgroundColor: isOnline ? theme.color.primary : theme.color.surfaceMuted,
            padding: theme.spacing.xl,
          }}
        >
          <Label variant="h2" tone={isOnline ? 'inverse' : 'default'}>
            {isOnline ? "You're online" : "You're offline"}
          </Label>
          <Label
            variant="caption"
            style={{ marginTop: 6, marginBottom: theme.spacing.lg, color: isOnline ? theme.color.primaryLight : theme.color.textSecondary }}
          >
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

        {/* the trip in hand */}
        {activeTrip ? (
          <Pressable onPress={() => router.push({ pathname: '/trip', params: { id: activeTrip.id } })} style={{ marginTop: theme.spacing.lg }}>
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Label variant="overline" tone="muted">Current trip</Label>
                <Label variant="caption" tone="muted">Open ›</Label>
              </View>
              <Label variant="h2" style={{ marginTop: theme.spacing.sm }}>{activeTrip.customer_name}</Label>

              <View style={{ marginTop: theme.spacing.lg, gap: theme.spacing.md }}>
                <View style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'flex-start' }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: theme.color.text, marginTop: 4 }} />
                  <View style={{ flex: 1 }}>
                    <Label variant="caption" tone="muted">Pickup</Label>
                    <Label variant="body">{activeTrip.pickup_address}</Label>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'flex-start' }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.color.text, marginTop: 4 }} />
                  <View style={{ flex: 1 }}>
                    <Label variant="caption" tone="muted">Destination</Label>
                    <Label variant="body">{activeTrip.destination_address}</Label>
                  </View>
                </View>
              </View>

              <View style={{ marginTop: theme.spacing.lg, paddingTop: theme.spacing.md, borderTopWidth: 1, borderTopColor: theme.color.border, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <View>
                  <Label variant="caption" tone="muted">Agreed fare</Label>
                  <Label variant="h1">{formatMoney(activeTrip.final_fare_minor ?? 0)}</Label>
                </View>
                <Label variant="caption" tone="muted">{(activeTrip.payment_method ?? 'cash').replace('_', ' ')}</Label>
              </View>
            </Card>
          </Pressable>
        ) : (
          <Card style={{ marginTop: theme.spacing.lg }}>
            <Label variant="bodyStrong">{isOnline ? 'Waiting for your next trip' : 'Go online to receive trips'}</Label>
            <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
              Operations assigns trips. You'll be notified the moment one is yours.
            </Label>
          </Card>
        )}

        {/* today */}
        <View style={{ flexDirection: 'row', gap: theme.spacing.md, marginTop: theme.spacing.lg }}>
          <Card style={{ flex: 1 }}>
            <Label variant="overline" tone="muted">Trips today</Label>
            <Label variant="display" style={{ marginTop: 2 }}>{today.trips}</Label>
          </Card>
          <Card style={{ flex: 1 }}>
            <Label variant="overline" tone="muted">Distance</Label>
            <Label variant="display" style={{ marginTop: 2 }}>{formatDistance(today.distanceMetres)}</Label>
          </Card>
        </View>

        {upcomingTrips.length > 0 ? (
          <View style={{ marginTop: theme.spacing.xl }}>
            <Label variant="overline" tone="muted">Scheduled for you</Label>
            {upcomingTrips.map((trip) => (
              <Card key={trip.id} style={{ marginTop: theme.spacing.md, padding: theme.spacing.md }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Label variant="bodyStrong">{trip.customer_name}</Label>
                  <Label variant="bodyStrong">
                    {new Date(trip.scheduled_pickup_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
                  </Label>
                </View>
                <Label variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>{trip.pickup_address}</Label>
              </Card>
            ))}
          </View>
        ) : null}

        <View style={{ marginTop: theme.spacing['2xl'], gap: theme.spacing.md }}>
          <Button label="Trip history" variant="secondary" onPress={() => router.push('/history')} />
          <Button label="Sign out" variant="ghost" onPress={signOut} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
