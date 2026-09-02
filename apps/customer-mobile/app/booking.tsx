import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { formatDistance, formatDuration } from '@transportco/utils';
import { Badge, Banner, Button, Card, Field, Label, Loading, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';

/**
 * Booking.
 *
 * Pickup defaults to the device's location because that is right nearly every
 * time; changing it is one tap away.
 *
 * DESTINATION PICKING: this screen uses saved places plus a curated list of
 * Port Harcourt landmarks. Google Places autocomplete drops in here as a
 * replacement for `DestinationPicker` — the rest of the flow already speaks
 * coordinates, so nothing downstream changes. Shipping a working picker beats
 * shipping an empty search box wired to a key nobody has configured yet.
 */

interface Place {
  latitude: number;
  longitude: number;
  address: string;
}

interface SavedLocation {
  id: string;
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

/** Development destination set for the Rivers State pilot. */
const LANDMARKS: Place[] = [
  { address: 'Port Harcourt International Airport, Omagwa', latitude: 5.0155, longitude: 6.9496 },
  { address: 'GRA Phase 2, Port Harcourt', latitude: 4.8087, longitude: 7.0134 },
  { address: 'Rumuola Junction, Port Harcourt', latitude: 4.8354, longitude: 7.0134 },
  { address: 'Mile 3 Market, Diobu', latitude: 4.8064, longitude: 6.9895 },
  { address: 'Rumuokoro Roundabout', latitude: 4.8686, longitude: 6.9989 },
  { address: 'Trans Amadi Industrial Layout', latitude: 4.7967, longitude: 7.0289 },
  { address: 'University of Port Harcourt, Choba', latitude: 4.8996, longitude: 6.9106 },
  { address: 'Eleme Junction, Port Harcourt', latitude: 4.8009, longitude: 7.0847 },
];

interface Quote {
  quoteId: string;
  fareMinor: number;
  currency: string;
  distanceMetres: number;
  durationSeconds: number;
  expiresAt: string;
  negotiable: boolean;
  maxOffers: number;
  breakdown: Array<{ label: string; amountMinor: number }>;
}

export default function Booking() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    destinationAddress?: string;
    destinationLat?: string;
    destinationLng?: string;
  }>();

  const [pickup, setPickup] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(
    params.destinationAddress && params.destinationLat && params.destinationLng
      ? {
          address: params.destinationAddress,
          latitude: Number(params.destinationLat),
          longitude: Number(params.destinationLng),
        }
      : null,
  );

  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [passengers, setPassengers] = useState(1);
  const [instructions, setInstructions] = useState('');
  const [scheduled, setScheduled] = useState<Date | null>(null);

  const [locating, setLocating] = useState(true);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // Locate the customer once, on mount.
  useEffect(() => {
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();

        if (status !== 'granted') {
          // Refused permission is not a dead end: they can still pick a pickup
          // from their saved places.
          setLocationError('Location is off. Choose your pickup point below.');
          setLocating(false);
          return;
        }

        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        setPickup({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          address: 'Current location',
        });
      } catch {
        setLocationError('We could not find your location. Choose your pickup point below.');
      } finally {
        setLocating(false);
      }
    })();
  }, []);

  useEffect(() => {
    void api
      .get<SavedLocation[]>('/customer/me/locations')
      .then(setSaved)
      .catch(() => undefined);
  }, []);

  const canQuote = pickup !== null && destination !== null;

  // Any change to the trip invalidates the price we were showing.
  useEffect(() => {
    setQuote(null);
  }, [pickup, destination, passengers, scheduled]);

  async function getQuote() {
    if (!pickup || !destination) return;

    setBanner(null);
    setQuoting(true);

    try {
      const result = await api.post<Quote>('/trips/estimate', {
        pickup,
        destination,
        passengers,
        ...(scheduled ? { scheduledFor: scheduled.toISOString() } : {}),
      });
      setQuote(result);
    } catch (error) {
      setBanner(error instanceof ApiError ? error.message : 'We could not price this trip right now.');
    } finally {
      setQuoting(false);
    }
  }

  async function confirm() {
    if (!quote) return;

    setBanner(null);
    setCreating(true);

    try {
      // An idempotency key makes a retry after a dropped response safe: the
      // customer gets the same trip back, not a second one.
      const idempotencyKey = `${quote.quoteId}-create`;

      const trip = await api.post<{ tripId: string }>(
        '/trips',
        {
          quoteId: quote.quoteId,
          paymentMethod: 'cash',
          ...(instructions ? { specialInstructions: instructions } : {}),
        },
        idempotencyKey,
      );

      router.replace({ pathname: '/fare', params: { id: trip.tripId } });
    } catch (error) {
      setBanner(
        error instanceof ApiError ? error.message : 'We could not create this trip. Please try again.',
      );
    } finally {
      setCreating(false);
    }
  }

  const destinations = useMemo(
    () => [
      ...saved.map((location) => ({
        address: location.address,
        latitude: location.latitude,
        longitude: location.longitude,
        label: location.label,
      })),
      ...LANDMARKS.map((place) => ({ ...place, label: null as string | null })),
    ],
    [saved],
  );

  if (locating) return <Loading message="Finding your location" />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <ScrollView contentContainerStyle={{ padding: theme.layout.screenPadding, paddingBottom: 140 }}>
        <Label variant="h1">Book a ride</Label>

        {locationError ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner message={locationError} tone="warning" />
          </View>
        ) : null}

        {banner ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner message={banner} tone="danger" />
          </View>
        ) : null}

        <Card style={{ marginTop: theme.spacing.lg }}>
          <Label variant="overline" tone="muted">
            Pickup
          </Label>
          <Label variant="bodyStrong" style={{ marginTop: 4 }}>
            {pickup?.address ?? 'Not set'}
          </Label>

          <View style={{ height: 1, backgroundColor: theme.color.border, marginVertical: theme.spacing.md }} />

          <Label variant="overline" tone="muted">
            Destination
          </Label>
          <Label variant="bodyStrong" style={{ marginTop: 4 }}>
            {destination?.address ?? 'Choose where you are going'}
          </Label>
        </Card>

        <Label variant="overline" tone="muted" style={{ marginTop: theme.spacing.xl }}>
          {destination ? 'Change destination' : 'Where are you going?'}
        </Label>

        <View style={{ marginTop: theme.spacing.md, gap: theme.spacing.sm }}>
          {destinations.map((place) => {
            const selected = destination?.address === place.address;
            return (
              <Pressable
                key={place.address}
                onPress={() =>
                  setDestination({
                    address: place.address,
                    latitude: place.latitude,
                    longitude: place.longitude,
                  })
                }
              >
                <Card
                  style={{
                    padding: theme.spacing.md,
                    borderColor: selected ? theme.color.primary : theme.color.border,
                    borderWidth: selected ? 2 : 1,
                  }}
                >
                  {place.label ? <Badge label={place.label} tone="info" /> : null}
                  <Label variant="body" style={{ marginTop: place.label ? 6 : 0 }}>
                    {place.address}
                  </Label>
                </Card>
              </Pressable>
            );
          })}
        </View>

        {!pickup && saved.length > 0 ? (
          <>
            <Label variant="overline" tone="muted" style={{ marginTop: theme.spacing.xl }}>
              Pickup from a saved place
            </Label>
            <View style={{ marginTop: theme.spacing.md, gap: theme.spacing.sm }}>
              {saved.map((location) => (
                <Pressable
                  key={location.id}
                  onPress={() =>
                    setPickup({
                      address: location.address,
                      latitude: location.latitude,
                      longitude: location.longitude,
                    })
                  }
                >
                  <Card style={{ padding: theme.spacing.md }}>
                    <Label variant="bodyStrong">{location.label}</Label>
                    <Label variant="caption" tone="muted">
                      {location.address}
                    </Label>
                  </Card>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        <Label variant="overline" tone="muted" style={{ marginTop: theme.spacing.xl }}>
          Passengers
        </Label>
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.md }}>
          {[1, 2, 3, 4, 5, 6].map((count) => (
            <Pressable key={count} onPress={() => setPassengers(count)} style={{ flex: 1 }}>
              <Card
                style={{
                  padding: theme.spacing.md,
                  alignItems: 'center',
                  backgroundColor: passengers === count ? theme.color.primary : theme.color.surface,
                  borderColor: passengers === count ? theme.color.primary : theme.color.border,
                }}
              >
                <Label variant="bodyStrong" tone={passengers === count ? 'inverse' : 'default'}>
                  {count}
                </Label>
              </Card>
            </Pressable>
          ))}
        </View>

        <View style={{ marginTop: theme.spacing.xl }}>
          <Field
            label="Anything the driver should know? (optional)"
            value={instructions}
            onChangeText={setInstructions}
            placeholder="Gate 3, opposite the pharmacy"
            multiline
          />
        </View>

        <Pressable onPress={() => setScheduled(scheduled ? null : new Date(Date.now() + 2 * 3600_000))}>
          <Card style={{ padding: theme.spacing.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Label variant="bodyStrong">
                  {scheduled ? 'Scheduled ride' : 'Ride now'}
                </Label>
                <Label variant="caption" tone="muted">
                  {scheduled
                    ? scheduled.toLocaleString('en-NG', {
                        weekday: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Tap to schedule for later'}
                </Label>
              </View>
              <Badge label={scheduled ? 'Scheduled' : 'Now'} tone={scheduled ? 'info' : 'neutral'} />
            </View>
          </Card>
        </Pressable>

        {quote ? (
          <Card style={{ marginTop: theme.spacing.xl }}>
            <Label variant="overline" tone="muted">
              Your fare
            </Label>

            <Label variant="fare" style={{ marginTop: 4 }}>
              {new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(
                quote.fareMinor / 100,
              )}
            </Label>

            <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
              {formatDistance(quote.distanceMetres)} · about {formatDuration(quote.durationSeconds)}
            </Label>

            {quote.negotiable ? (
              <View style={{ marginTop: theme.spacing.md }}>
                <Badge label={`You can make up to ${quote.maxOffers} offers`} tone="accent" />
              </View>
            ) : null}
          </Card>
        ) : null}
      </ScrollView>

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: theme.layout.screenPadding,
          backgroundColor: theme.color.surface,
          borderTopWidth: 1,
          borderTopColor: theme.color.border,
        }}
      >
        {quote ? (
          <Button label="Continue" onPress={confirm} loading={creating} variant="accent" />
        ) : (
          <Button
            label={canQuote ? 'See my fare' : 'Choose a destination'}
            onPress={getQuote}
            loading={quoting}
            disabled={!canQuote}
          />
        )}
      </View>
    </SafeAreaView>
  );
}
