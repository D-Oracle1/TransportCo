import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatMoney } from '@transportco/utils';
import { Badge, Banner, Card, Label, theme } from '@transportco/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Home.
 *
 * One question dominates the screen — WHERE ARE YOU GOING? — because that is
 * the only thing most customers open the app to do. Everything else is
 * secondary and sits below it.
 *
 * An active trip takes over the top of the screen when there is one: a customer
 * with a driver on the way should not have to hunt for their trip.
 */

interface SavedLocation {
  id: string;
  label: string;
  kind: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface ActiveTrip {
  id: string;
  reference: string;
  status: string;
  statusLabel: string;
  fareLabel: string;
  destination: { address: string };
  driver: { name: string } | null;
}

interface RecentTrip {
  id: string;
  reference: string;
  status: string;
  statusLabel: string;
  destination_address: string;
  fareLabel: string;
}

export default function Home() {
  const router = useRouter();
  const { profile, refreshProfile } = useSession();

  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [active, setActive] = useState<ActiveTrip | null>(null);
  const [recent, setRecent] = useState<RecentTrip[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    try {
      const [locations, activeTrip, trips] = await Promise.all([
        api.get<SavedLocation[]>('/customer/me/locations'),
        api.get<ActiveTrip | null>('/trips/active'),
        api.get<{ items: RecentTrip[] }>('/trips?pageSize=3'),
      ]);

      setSaved(locations);
      setActive(activeTrip);
      setRecent(trips.items);
      setOffline(false);
    } catch {
      // Home stays usable offline: the customer can still see what was last
      // loaded and start a booking, which will fail loudly at the right moment.
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <ScrollView
        contentContainerStyle={{ padding: theme.layout.screenPadding, paddingBottom: theme.spacing['3xl'] }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await Promise.all([load(), refreshProfile()]);
              setRefreshing(false);
            }}
          />
        }
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Label variant="caption" tone="muted">
              Hello
            </Label>
            <Label variant="h2">{profile?.fullName.split(' ')[0] ?? 'there'}</Label>
          </View>

          <Pressable onPress={() => router.push('/profile')} accessibilityRole="button">
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: theme.color.primaryLight,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Label variant="bodyStrong" style={{ color: theme.color.primaryDark }}>
                {(profile?.fullName ?? 'T').charAt(0).toUpperCase()}
              </Label>
            </View>
          </Pressable>
        </View>

        {offline ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner message="You are offline. Some information may be out of date." tone="warning" />
          </View>
        ) : null}

        {profile && profile.outstandingBalanceMinor > 0 ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner
              tone="danger"
              message={`You have ${profile.outstandingBalanceLabel} outstanding. Settle it to book another ride.`}
            />
          </View>
        ) : null}

        {/* The primary action. Deliberately the largest thing on the screen. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Where are you going"
          onPress={() => router.push('/booking')}
          style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1, marginTop: theme.spacing.xl })}
        >
          <Card style={{ backgroundColor: theme.color.primary, borderColor: theme.color.primary }}>
            <Label variant="overline" tone="inverse" style={{ opacity: 0.75 }}>
              Book a ride
            </Label>
            <Label variant="h1" tone="inverse" style={{ marginTop: 6 }}>
              Where are you going?
            </Label>
            <Label variant="caption" tone="inverse" style={{ marginTop: 8, opacity: 0.85 }}>
              See the fare first — and tell us if it is too high.
            </Label>
          </Card>
        </Pressable>

        {active ? (
          <Pressable
            onPress={() => router.push({ pathname: '/trip', params: { id: active.id } })}
            style={{ marginTop: theme.spacing.lg }}
          >
            <Card style={{ borderColor: theme.color.accent, borderWidth: 2 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Badge label="Active trip" tone="accent" />
                <Label variant="bodyStrong">{active.fareLabel}</Label>
              </View>
              <Label variant="h3" style={{ marginTop: theme.spacing.md }}>
                {active.statusLabel}
              </Label>
              <Label variant="body" tone="secondary" style={{ marginTop: 4 }}>
                To {active.destination.address}
              </Label>
              {active.driver ? (
                <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
                  {active.driver.name} is your driver
                </Label>
              ) : null}
            </Card>
          </Pressable>
        ) : null}

        {saved.length > 0 ? (
          <View style={{ marginTop: theme.spacing.xl }}>
            <Label variant="overline" tone="muted">
              Saved places
            </Label>
            <View style={{ flexDirection: 'row', gap: theme.spacing.md, marginTop: theme.spacing.md }}>
              {saved.slice(0, 2).map((location) => (
                <Pressable
                  key={location.id}
                  style={{ flex: 1 }}
                  onPress={() =>
                    router.push({
                      pathname: '/booking',
                      params: {
                        destinationAddress: location.address,
                        destinationLat: String(location.latitude),
                        destinationLng: String(location.longitude),
                      },
                    })
                  }
                >
                  <Card style={{ padding: theme.spacing.md }}>
                    <Label variant="bodyStrong">{location.label}</Label>
                    <Label variant="caption" tone="muted" numberOfLines={1}>
                      {location.address}
                    </Label>
                  </Card>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {profile ? (
          <Card style={{ marginTop: theme.spacing.xl }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <View>
                <Label variant="overline" tone="muted">
                  Loyalty points
                </Label>
                <Label variant="h2" style={{ marginTop: 2 }}>
                  {profile.loyalty.balancePoints.toLocaleString('en-NG')}
                </Label>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Label variant="overline" tone="muted">
                  Trips
                </Label>
                <Label variant="h2" style={{ marginTop: 2 }}>
                  {profile.totalTrips}
                </Label>
              </View>
            </View>
          </Card>
        ) : null}

        {recent.length > 0 ? (
          <View style={{ marginTop: theme.spacing.xl }}>
            <Label variant="overline" tone="muted">
              Recent trips
            </Label>
            {recent.map((trip) => (
              <Pressable
                key={trip.id}
                onPress={() => router.push({ pathname: '/trip', params: { id: trip.id } })}
                style={{ marginTop: theme.spacing.md }}
              >
                <Card style={{ padding: theme.spacing.md }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Label variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
                      {trip.destination_address}
                    </Label>
                    <Label variant="bodyStrong">{trip.fareLabel}</Label>
                  </View>
                  <Label variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    {trip.statusLabel}
                  </Label>
                </Card>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={{ marginTop: theme.spacing.xl, flexDirection: 'row', gap: theme.spacing.md }}>
          <Pressable style={{ flex: 1 }} onPress={() => router.push('/support')}>
            <Card style={{ padding: theme.spacing.md, alignItems: 'center' }}>
              <Label variant="bodyStrong">Support</Label>
            </Card>
          </Pressable>
          <Pressable style={{ flex: 1 }} onPress={() => router.push('/profile')}>
            <Card style={{ padding: theme.spacing.md, alignItems: 'center' }}>
              <Label variant="bodyStrong">Profile</Label>
            </Card>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
