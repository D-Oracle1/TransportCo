import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatMoney, humanizeCountdown } from '@transportco/utils';
import { Badge, Banner, Button, Card, Field, Label, Loading, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';

/**
 * THE FARE AND NEGOTIATION SCREEN.
 *
 * The feature the whole product is built around, so the interaction has to be
 * honest about how it works:
 *
 *  - The customer sees TransportCo's fare and can accept it outright.
 *  - Or they can say what they want to pay. The company answers: accepted,
 *    countered, or declined with our best price.
 *  - The remaining-offers count is shown up front, because discovering the
 *    limit only when you hit it feels like a trick.
 *  - The countdown is SERVER-AUTHORITATIVE. When it reaches zero the buttons
 *    disable and we re-read state rather than letting the customer act on an
 *    offer the server has already expired.
 */

interface NegotiationView {
  status: string;
  originalFareMinor: number;
  companyPositionMinor: number;
  customerPositionMinor: number | null;
  finalFareMinor: number | null;
  roundsUsed: number;
  maxRounds: number;
  offersRemaining: number;
  pendingOffer: {
    id: string;
    party: 'customer' | 'company';
    amountMinor: number;
    expiresAt: string;
    expiresInSeconds: number;
  } | null;
  timeline: Array<{
    id: string;
    party: 'customer' | 'company';
    amountMinor: number;
    status: string;
    createdAt: string;
  }>;
}

interface TripView {
  id: string;
  reference: string;
  status: string;
  statusLabel: string;
  quotedFareMinor: number;
  finalFareMinor: number | null;
  fareLocked: boolean;
  pickup: { address: string };
  destination: { address: string };
}

export default function FareScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [trip, setTrip] = useState<TripView | null>(null);
  const [negotiation, setNegotiation] = useState<NegotiationView | null>(null);
  const [offer, setOffer] = useState('');
  const [banner, setBanner] = useState<{ message: string; tone: 'info' | 'danger' | 'success' } | null>(null);
  const [busy, setBusy] = useState<'accept' | 'offer' | null>(null);
  const [loading, setLoading] = useState(true);
  const [remaining, setRemaining] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const [tripView, negotiationView] = await Promise.all([
        api.get<TripView>(`/trips/${id}`),
        api.get<NegotiationView | null>(`/trips/${id}/negotiation`),
      ]);

      setTrip(tripView);
      setNegotiation(negotiationView);

      // Once the fare is locked there is nothing left to negotiate: move on to
      // the trip itself.
      if (tripView.fareLocked) {
        router.replace({ pathname: '/trip', params: { id: tripView.id } });
      }
    } catch (error) {
      setBanner({
        message: error instanceof ApiError ? error.message : 'We could not load this fare.',
        tone: 'danger',
      });
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * While an offer is with the company, poll for the answer. Realtime delivers
   * this faster when the socket is connected; polling is the fallback that
   * still works on a flaky mobile connection.
   */
  useEffect(() => {
    const waiting = negotiation?.status === 'AWAITING_COMPANY';

    if (waiting && !pollRef.current) {
      pollRef.current = setInterval(() => {
        void load();
      }, 5000);
    }

    if (!waiting && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [negotiation?.status, load]);

  // Countdown display for a pending company offer.
  useEffect(() => {
    const pending = negotiation?.pendingOffer;
    if (!pending) return;

    const tick = () => {
      const seconds = Math.max(0, Math.floor((new Date(pending.expiresAt).getTime() - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) void load();
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [negotiation?.pendingOffer, load]);

  async function acceptFare() {
    setBusy('accept');
    setBanner(null);

    try {
      const pendingCompanyOffer =
        negotiation?.pendingOffer?.party === 'company' ? negotiation.pendingOffer.id : undefined;

      await api.post(`/trips/${id}/accept-fare`, pendingCompanyOffer ? { offerId: pendingCompanyOffer } : {});
      router.replace({ pathname: '/trip', params: { id } });
    } catch (error) {
      setBanner({
        message: error instanceof ApiError ? error.message : 'We could not confirm that fare.',
        tone: 'danger',
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function submitOffer() {
    const naira = Number(offer.replace(/[^0-9]/g, ''));
    if (!naira) return;

    setBusy('offer');
    setBanner(null);

    try {
      const result = await api.post<{
        outcome: 'accepted' | 'rejected' | 'countered' | 'under_review' | 'limit_reached';
        message: string;
        counterAmountMinor?: number;
        finalFareMinor?: number;
      }>(`/trips/${id}/negotiate`, { amountMinor: naira * 100 });

      setOffer('');

      if (result.outcome === 'accepted') {
        setBanner({ message: result.message, tone: 'success' });
        router.replace({ pathname: '/trip', params: { id } });
        return;
      }

      setBanner({
        message: result.message,
        tone: result.outcome === 'rejected' || result.outcome === 'limit_reached' ? 'danger' : 'info',
      });

      await load();
    } catch (error) {
      setBanner({
        message: error instanceof ApiError ? error.message : 'We could not send your offer.',
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  if (loading || !trip) return <Loading message="Loading your fare" />;

  const currentFare = negotiation?.companyPositionMinor ?? trip.quotedFareMinor;
  const awaitingCompany = negotiation?.status === 'AWAITING_COMPANY';
  const offersLeft = negotiation?.offersRemaining ?? 0;
  const pendingCompanyOffer = negotiation?.pendingOffer?.party === 'company';
  const expired = pendingCompanyOffer && remaining <= 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <ScrollView contentContainerStyle={{ padding: theme.layout.screenPadding, paddingBottom: 120 }}>
        <Label variant="overline" tone="muted">
          {trip.reference}
        </Label>

        <Card style={{ marginTop: theme.spacing.md }}>
          <Label variant="caption" tone="muted">
            From
          </Label>
          <Label variant="body">{trip.pickup.address}</Label>

          <View style={{ height: 1, backgroundColor: theme.color.border, marginVertical: theme.spacing.md }} />

          <Label variant="caption" tone="muted">
            To
          </Label>
          <Label variant="body">{trip.destination.address}</Label>
        </Card>

        <Card style={{ marginTop: theme.spacing.lg, alignItems: 'center' }}>
          <Label variant="overline" tone="muted">
            {pendingCompanyOffer ? 'Our offer' : 'Your fare'}
          </Label>

          <Label variant="fare" style={{ marginTop: 6 }}>
            {formatMoney(currentFare)}
          </Label>

          {negotiation && negotiation.originalFareMinor !== currentFare ? (
            <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
              Originally {formatMoney(negotiation.originalFareMinor)}
            </Label>
          ) : null}

          {pendingCompanyOffer ? (
            <View style={{ marginTop: theme.spacing.md }}>
              <Badge
                label={expired ? 'This offer has expired' : `Expires in ${humanizeCountdown(remaining)}`}
                tone={remaining < 60 ? 'danger' : 'accent'}
              />
            </View>
          ) : null}
        </Card>

        {banner ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner message={banner.message} tone={banner.tone} />
          </View>
        ) : null}

        {awaitingCompany ? (
          <Card style={{ marginTop: theme.spacing.lg, alignItems: 'center' }}>
            <Label variant="bodyStrong">We are reviewing your offer</Label>
            <Label variant="caption" tone="muted" center style={{ marginTop: 6 }}>
              You offered {formatMoney(negotiation?.customerPositionMinor ?? 0)}. This usually takes under a
              minute.
            </Label>
          </Card>
        ) : null}

        {negotiation && negotiation.timeline.length > 0 ? (
          <View style={{ marginTop: theme.spacing.xl }}>
            <Label variant="overline" tone="muted">
              Your conversation
            </Label>

            {negotiation.timeline.map((entry) => (
              <View
                key={entry.id}
                style={{
                  alignSelf: entry.party === 'customer' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  marginTop: theme.spacing.md,
                  backgroundColor:
                    entry.party === 'customer' ? theme.color.primary : theme.color.surfaceMuted,
                  borderRadius: theme.radius.lg,
                  paddingHorizontal: theme.spacing.lg,
                  paddingVertical: theme.spacing.md,
                }}
              >
                <Label variant="caption" tone={entry.party === 'customer' ? 'inverse' : 'muted'}>
                  {entry.party === 'customer' ? 'You offered' : 'TransportCo offered'}
                </Label>
                <Label variant="h3" tone={entry.party === 'customer' ? 'inverse' : 'default'}>
                  {formatMoney(entry.amountMinor)}
                </Label>
              </View>
            ))}
          </View>
        ) : null}

        {!awaitingCompany && offersLeft > 0 ? (
          <Card style={{ marginTop: theme.spacing.xl }}>
            <Label variant="bodyStrong">Is this too high?</Label>
            <Label variant="caption" tone="muted" style={{ marginTop: 4, marginBottom: theme.spacing.md }}>
              Tell us what you want to pay. You have {offersLeft} offer{offersLeft === 1 ? '' : 's'} left on
              this trip.
            </Label>

            <Field
              label="I want to pay (₦)"
              value={offer}
              onChangeText={(value) => setOffer(value.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              placeholder={String(Math.round((currentFare * 0.9) / 100))}
            />

            <Button
              label="Send my offer"
              variant="accent"
              onPress={submitOffer}
              loading={busy === 'offer'}
              disabled={busy !== null || offer.length === 0}
            />
          </Card>
        ) : null}

        {!awaitingCompany && offersLeft === 0 && negotiation ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner
              tone="info"
              message={`You have used your ${negotiation.maxRounds} offers for this trip. You can accept ${formatMoney(currentFare)} or cancel.`}
            />
          </View>
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
        <Button
          label={`Accept ${formatMoney(currentFare)}`}
          onPress={acceptFare}
          loading={busy === 'accept'}
          disabled={busy !== null || awaitingCompany || expired}
        />
        <Button
          label="Cancel this request"
          variant="ghost"
          onPress={async () => {
            await api.post(`/trips/${id}/cancel`, { reason: 'fare_too_high' }).catch(() => undefined);
            router.replace('/home');
          }}
          disabled={busy !== null}
        />
      </View>
    </SafeAreaView>
  );
}
