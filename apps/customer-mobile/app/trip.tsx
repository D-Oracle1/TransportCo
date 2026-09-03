import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '@transportco/config';
import { formatMoney } from '@transportco/utils';
import { Badge, Banner, Button, Card, Label, Loading, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';

/**
 * Live trip.
 *
 * From assignment to rating, this is the only screen the customer needs. It
 * answers, in order, the questions people actually ask: who is coming, in what,
 * how far away, and what will it cost.
 *
 * SOS is always visible once a driver is assigned — a safety control that
 * requires scrolling is not a safety control.
 */

interface TripView {
  id: string;
  reference: string;
  status: string;
  statusLabel: string;
  quotedFareMinor: number;
  finalFareMinor: number | null;
  fareLabel: string;
  fareLocked: boolean;
  paymentMethod: string | null;
  paymentStatus: string;
  pickup: { address: string; latitude: number; longitude: number };
  destination: { address: string; latitude: number; longitude: number };
  driver: {
    name: string;
    rating: number | null;
    location: { latitude: number; longitude: number } | null;
    vehicle: { plateNumber: string; make: string; model: string; color: string } | null;
  } | null;
}

const ACTIVE_STATUSES = [
  'FARE_LOCKED',
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'TRIP_STARTED',
];

export default function TripScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [trip, setTrip] = useState<TripView | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTrip(await api.get<TripView>(`/trips/${id}`));
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof ApiError ? error.message : 'We could not load this trip.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Poll while the trip is live. Realtime pushes the same updates faster when
   * the socket holds; this is the floor, not the ceiling.
   */
  useEffect(() => {
    if (!trip || !ACTIVE_STATUSES.includes(trip.status)) return;

    const timer = setInterval(() => {
      void load();
    }, 8000);

    return () => clearInterval(timer);
  }, [trip, load]);

  async function raiseSos() {
    setBusy('sos');
    try {
      const incident = await api.post<{ emergencyContact: string; message: string }>('/support/sos', {
        type: 'sos',
        tripId: id,
        ...(trip?.pickup ? { latitude: trip.pickup.latitude, longitude: trip.pickup.longitude } : {}),
      });
      setBanner(incident.message);
    } catch {
      setBanner(`We could not reach operations. Call ${BRAND.supportPhone} now if you are in danger.`);
    } finally {
      setBusy(null);
    }
  }

  async function payNow() {
    setBusy('pay');
    try {
      const payment = await api.post<{ authorizationUrl: string | null; amountLabel: string }>(
        '/payments/initialize',
        { tripId: id, purpose: 'trip_fare', method: 'card' },
      );

      if (payment.authorizationUrl) {
        await Linking.openURL(payment.authorizationUrl);
      } else {
        setBanner('Payment started. We will confirm once it clears.');
      }
    } catch (error) {
      setBanner(
        error instanceof ApiError
          ? error.message
          : 'Payment could not be completed. Please try again or choose another method.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function submitRating(stars: number) {
    setRating(stars);
    setBusy('rating');

    try {
      await api.post(`/trips/${id}/review`, { driverRating: stars });
      setBanner('Thank you for rating your trip.');
      await load();
    } catch (error) {
      setBanner(error instanceof ApiError ? error.message : 'We could not save your rating.');
    } finally {
      setBusy(null);
    }
  }

  async function cancelRide() {
    setBusy('cancel');
    try {
      await api.post(`/trips/${id}/cancel`, { reason: 'changed_mind' });
      router.replace('/home');
    } catch (error) {
      setBanner(error instanceof ApiError ? error.message : 'We could not cancel this ride.');
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (loading || !trip) return <Loading message="Loading your trip" />;

  const awaitingPayment = ['PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(trip.status);
  const awaitingRating = trip.status === 'REVIEW_PENDING';
  const isLive = ACTIVE_STATUSES.includes(trip.status);
  // A ride can be cancelled right up until the driver starts moving toward you.
  const cancellable = ['FARE_LOCKED', 'DRIVER_ASSIGNED'].includes(trip.status);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <ScrollView contentContainerStyle={{ padding: theme.layout.screenPadding, paddingBottom: 120 }}>
        <Label variant="overline" tone="muted">
          {trip.reference}
        </Label>
        <Label variant="h1" style={{ marginTop: 4 }}>
          {trip.statusLabel}
        </Label>

        {banner ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner message={banner} tone="info" />
          </View>
        ) : null}

        {trip.driver ? (
          <Card style={{ marginTop: theme.spacing.lg }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <View
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: theme.color.primaryLight,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Label variant="h3" style={{ color: theme.color.primaryDark }}>
                  {trip.driver.name.charAt(0)}
                </Label>
              </View>

              <View style={{ flex: 1 }}>
                <Label variant="h3">{trip.driver.name}</Label>
                <Label variant="caption" tone="muted">
                  {trip.driver.rating ? `${trip.driver.rating.toFixed(1)} ★ · ` : ''}
                  PEGO driver
                </Label>
              </View>
            </View>

            {trip.driver.vehicle ? (
              <View
                style={{
                  marginTop: theme.spacing.md,
                  paddingTop: theme.spacing.md,
                  borderTopWidth: 1,
                  borderTopColor: theme.color.border,
                }}
              >
                <Label variant="caption" tone="muted">
                  Vehicle
                </Label>
                <Label variant="bodyStrong">
                  {trip.driver.vehicle.color} {trip.driver.vehicle.make} {trip.driver.vehicle.model}
                </Label>
                <Label variant="h3" style={{ marginTop: 2, letterSpacing: 1 }}>
                  {trip.driver.vehicle.plateNumber}
                </Label>
              </View>
            ) : null}
          </Card>
        ) : (
          <Card style={{ marginTop: theme.spacing.lg }}>
            <Label variant="bodyStrong">Finding your driver</Label>
            <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
              We assign a company driver and vehicle to every trip. You will see who is coming in a moment.
            </Label>
          </Card>
        )}

        <Card style={{ marginTop: theme.spacing.lg }}>
          <Label variant="caption" tone="muted">
            Pickup
          </Label>
          <Label variant="body">{trip.pickup.address}</Label>

          <View style={{ height: 1, backgroundColor: theme.color.border, marginVertical: theme.spacing.md }} />

          <Label variant="caption" tone="muted">
            Destination
          </Label>
          <Label variant="body">{trip.destination.address}</Label>
        </Card>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Label variant="caption" tone="muted">
                Agreed fare
              </Label>
              <Label variant="h2">{formatMoney(trip.finalFareMinor ?? trip.quotedFareMinor)}</Label>
            </View>
            <Badge
              label={trip.paymentStatus === 'paid' ? 'Paid' : (trip.paymentMethod ?? 'cash').replace('_', ' ')}
              tone={trip.paymentStatus === 'paid' ? 'success' : 'neutral'}
            />
          </View>

          {trip.fareLocked ? (
            <Label variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
              This fare is locked. Your driver cannot change it.
            </Label>
          ) : null}
        </Card>

        {awaitingRating ? (
          <Card style={{ marginTop: theme.spacing.lg }}>
            <Label variant="bodyStrong">How was your trip?</Label>
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.md }}>
              {[1, 2, 3, 4, 5].map((star) => (
                <Pressable key={star} onPress={() => submitRating(star)} style={{ flex: 1 }} disabled={busy !== null}>
                  <Card
                    style={{
                      padding: theme.spacing.md,
                      alignItems: 'center',
                      backgroundColor: star <= rating ? theme.color.accent : theme.color.surface,
                    }}
                  >
                    <Label variant="h3">{star <= rating ? '★' : '☆'}</Label>
                  </Card>
                </Pressable>
              ))}
            </View>
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
          gap: theme.spacing.sm,
        }}
      >
        {awaitingPayment ? (
          <Button label="Pay now" variant="accent" onPress={payNow} loading={busy === 'pay'} />
        ) : null}

        {isLive && trip.driver ? (
          <Button label="Emergency — alert operations" variant="danger" onPress={raiseSos} loading={busy === 'sos'} />
        ) : null}

        {cancellable ? (
          <Button label="Cancel ride" variant="ghost" onPress={cancelRide} loading={busy === 'cancel'} disabled={busy !== null} />
        ) : (
          <Button label="Back to home" variant="ghost" onPress={() => router.replace('/home')} />
        )}
      </View>
    </SafeAreaView>
  );
}
