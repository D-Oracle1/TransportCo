import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { BRAND } from '@transportco/config';
import { formatDistance, formatMoney } from '@transportco/utils';
import { Badge, Banner, Button, Card, Label, Loading, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * The driver's trip screen.
 *
 * ONE primary action at a time — navigate, arrived, start, complete — because a
 * screen of equally weighted buttons is a screen someone taps wrong while
 * pulling away from a kerb.
 *
 * The fare is READ-ONLY here, and there is no endpoint that would let it be
 * otherwise. Cash collection must equal the agreed fare exactly; a shortfall is
 * an operations conversation, not something settled at the roadside.
 */

interface DriverTrip {
  id: string;
  reference: string;
  status: string;
  customerName: string;
  customerMaskedPhone: string;
  pickup: { address: string; latitude: number; longitude: number };
  destination: { address: string; latitude: number; longitude: number };
  passengers: number;
  specialInstructions: string | null;
  agreedFareMinor: number;
  agreedFareLabel: string;
  paymentMethod: string | null;
  paymentStatus: string;
  distanceMetres: number;
}

const NEXT_ACTION: Record<
  string,
  { action: 'start_pickup' | 'arrived' | 'start_trip' | 'complete_trip'; label: string } | null
> = {
  DRIVER_ASSIGNED: { action: 'start_pickup', label: 'Start pickup' },
  DRIVER_EN_ROUTE: { action: 'arrived', label: 'I have arrived' },
  DRIVER_ARRIVED: { action: 'start_trip', label: 'Start trip' },
  TRIP_STARTED: { action: 'complete_trip', label: 'Complete trip' },
};

export default function DriverTripScreen() {
  const router = useRouter();
  const { refresh } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [trip, setTrip] = useState<DriverTrip | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ text: string; tone: 'info' | 'danger' | 'success' } | null>(null);

  const load = useCallback(async () => {
    try {
      setTrip(await api.get<DriverTrip>(`/drivers/me/trips/${id}`));
    } catch (error) {
      setBanner({
        text: error instanceof ApiError ? error.message : 'We could not load this trip.',
        tone: 'danger',
      });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function performAction(action: string, label: string) {
    setBusy(action);
    setBanner(null);

    try {
      // Arrival and completion are location-verified server-side, so the fix
      // goes with the request rather than being trusted from the last ping.
      let coords: { latitude: number; longitude: number } | null = null;
      if (action === 'arrived' || action === 'complete_trip') {
        try {
          const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
          coords = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        } catch {
          coords = null;
        }
      }

      const result = await api.post<{ status: string; paymentDue: boolean; amountMinor: number | null }>(
        `/drivers/me/trips/${id}/actions`,
        { action, ...(coords ?? {}) },
        // Idempotent: a retry after a dropped response must not advance the
        // trip twice.
        `${id}-${action}`,
      );

      await Promise.all([load(), refresh()]);

      if (result.paymentDue && trip?.paymentMethod === 'cash') {
        setBanner({ text: `Collect ${formatMoney(result.amountMinor ?? 0)} in cash.`, tone: 'info' });
      } else if (action === 'complete_trip') {
        setBanner({ text: 'Trip completed.', tone: 'success' });
      }
    } catch (error) {
      setBanner({
        text: error instanceof ApiError ? error.message : `We could not record "${label}". Try again.`,
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  async function collectCash() {
    if (!trip) return;

    Alert.alert(
      'Confirm cash collected',
      `Confirm you have received ${trip.agreedFareLabel} from ${trip.customerName}.`,
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            setBusy('cash');
            try {
              await api.post(
                `/drivers/me/trips/${id}/cash`,
                { amountMinor: trip.agreedFareMinor },
                `${id}-cash`,
              );
              setBanner({ text: 'Cash recorded. Thank you.', tone: 'success' });
              await Promise.all([load(), refresh()]);
            } catch (error) {
              setBanner({
                text:
                  error instanceof ApiError
                    ? error.message
                    : 'We could not record the cash. Contact operations.',
                tone: 'danger',
              });
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  async function raiseSos() {
    setBusy('sos');
    try {
      await api.post('/support/sos', { type: 'sos', tripId: id });
      setBanner({ text: 'Operations has been alerted.', tone: 'info' });
    } catch {
      setBanner({ text: `Could not reach operations. Call ${BRAND.supportPhone}.`, tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  function navigate(target: 'pickup' | 'destination') {
    if (!trip) return;
    const point = target === 'pickup' ? trip.pickup : trip.destination;
    void Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${point.latitude},${point.longitude}`);
  }

  if (loading || !trip) return <Loading message="Loading trip" />;

  const next = NEXT_ACTION[trip.status] ?? null;
  const cashDue =
    trip.paymentMethod === 'cash' &&
    trip.paymentStatus !== 'paid' &&
    ['TRIP_COMPLETED', 'PAYMENT_PENDING'].includes(trip.status);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <ScrollView contentContainerStyle={{ padding: theme.layout.screenPadding, paddingBottom: 170 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Label variant="overline" tone="muted">
            {trip.reference}
          </Label>
          <Badge label={trip.status.replace(/_/g, ' ').toLowerCase()} tone="neutral" />
        </View>

        {banner ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner message={banner.text} tone={banner.tone} />
          </View>
        ) : null}

        <Card style={{ marginTop: theme.spacing.lg }}>
          <Label variant="overline" tone="muted">
            Customer
          </Label>
          <Label variant="h3" style={{ marginTop: 2 }}>
            {trip.customerName}
          </Label>
          <Label variant="caption" tone="muted">
            {trip.customerMaskedPhone} · {trip.passengers} passenger
            {trip.passengers === 1 ? '' : 's'}
          </Label>

          {trip.specialInstructions ? (
            <View
              style={{
                marginTop: theme.spacing.md,
                padding: theme.spacing.md,
                backgroundColor: theme.color.surfaceMuted,
                borderRadius: theme.radius.md,
              }}
            >
              <Label variant="caption" tone="muted">
                From the customer
              </Label>
              <Label variant="body">{trip.specialInstructions}</Label>
            </View>
          ) : null}
        </Card>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <Label variant="overline" tone="muted">
            Pickup
          </Label>
          <Label variant="body">{trip.pickup.address}</Label>
          <Button
            label="Navigate to pickup"
            variant="secondary"
            onPress={() => navigate('pickup')}
            style={{ marginTop: theme.spacing.md }}
          />

          <View style={{ height: 1, backgroundColor: theme.color.border, marginVertical: theme.spacing.lg }} />

          <Label variant="overline" tone="muted">
            Destination
          </Label>
          <Label variant="body">{trip.destination.address}</Label>
          <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
            About {formatDistance(trip.distanceMetres)}
          </Label>
          <Button
            label="Navigate to destination"
            variant="secondary"
            onPress={() => navigate('destination')}
            style={{ marginTop: theme.spacing.md }}
          />
        </Card>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Label variant="overline" tone="muted">
                Agreed fare
              </Label>
              <Label variant="h2">{trip.agreedFareLabel}</Label>
            </View>
            <Badge
              label={trip.paymentStatus === 'paid' ? 'Paid' : (trip.paymentMethod ?? 'cash').replace('_', ' ')}
              tone="neutral"
            />
          </View>

          <Label variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
            This fare was agreed with the company. It cannot be changed.
          </Label>
        </Card>
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
        {cashDue ? (
          <Button label="Cash collected" variant="accent" onPress={collectCash} loading={busy === 'cash'} />
        ) : next ? (
          <Button
            label={next.label}
            onPress={() => performAction(next.action, next.label)}
            loading={busy === next.action}
          />
        ) : (
          <Button label="Back to dashboard" onPress={() => router.replace('/dashboard')} />
        )}

        {trip.status === 'DRIVER_ARRIVED' ? (
          <Button
            label="Customer did not show"
            variant="ghost"
            onPress={() => performAction('report_no_show', 'No-show')}
            loading={busy === 'report_no_show'}
          />
        ) : null}

        <Button label="Emergency" variant="danger" onPress={raiseSos} loading={busy === 'sos'} />
      </View>
    </SafeAreaView>
  );
}
