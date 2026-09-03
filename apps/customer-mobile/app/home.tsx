import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { formatMoney, humanizeCountdown } from '@transportco/utils';
import { Badge, Banner, Button, Field, Label, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Home — the whole ride in one screen.
 *
 * A single sheet carries the customer from "where are you going?" to a locked
 * fare without ever changing pages: pick a destination, see the price, and
 * either book it or say what you'd rather pay. Only the live trip (a driver on
 * the way) gets its own screen.
 */

interface Place {
  latitude: number;
  longitude: number;
  address: string;
}
interface SavedLocation extends Place {
  id: string;
  label: string;
}
interface ActiveTrip {
  id: string;
  statusLabel: string;
  fareLabel: string;
  destination: { address: string };
  driver: { name: string } | null;
}
interface Quote {
  quoteId: string;
  fareMinor: number;
  distanceMetres: number;
  durationSeconds: number;
}
interface TripView {
  id: string;
  quotedFareMinor: number;
  finalFareMinor: number | null;
  fareLocked: boolean;
}
interface NegotiationView {
  status: string;
  originalFareMinor: number;
  companyPositionMinor: number;
  customerPositionMinor: number | null;
  offersRemaining: number;
  maxRounds: number;
  pendingOffer: { id: string; party: 'customer' | 'company'; amountMinor: number; expiresAt: string } | null;
  timeline: Array<{ id: string; party: 'customer' | 'company'; amountMinor: number }>;
}

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

type Phase = 'choose' | 'quoted' | 'negotiate';

export default function Home() {
  const router = useRouter();
  const { profile } = useSession();

  // ── trip setup ────────────────────────────────────────────────────────────
  const [pickup, setPickup] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<ActiveTrip | null>(null);

  // ── flow ──────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('choose');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [trip, setTrip] = useState<TripView | null>(null);
  const [negotiation, setNegotiation] = useState<NegotiationView | null>(null);
  const [offer, setOffer] = useState('');
  const [busy, setBusy] = useState<null | 'quote' | 'book' | 'offer' | 'accept'>(null);
  const [banner, setBanner] = useState<{ message: string; tone: 'info' | 'danger' | 'success' } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Locate the customer once.
  useEffect(() => {
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setPickup({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, address: 'Current location' });
      } catch {
        /* pickup can be chosen from saved places */
      }
    })();
  }, []);

  const load = useCallback(async () => {
    try {
      const [locations, activeTrip] = await Promise.all([
        api.get<SavedLocation[]>('/customer/me/locations').catch(() => [] as SavedLocation[]),
        api.get<ActiveTrip | null>('/trips/active').catch(() => null),
      ]);
      setSaved(locations);
      setActive(activeTrip);
    } catch {
      /* offline: keep last state */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // ── destinations (deduped by address so keys are always unique) ─────────────
  const destinations = useMemo(() => {
    const byAddress = new Map<string, Place & { label: string | null }>();
    for (const s of saved) byAddress.set(s.address, { ...s, label: s.label });
    for (const p of LANDMARKS) if (!byAddress.has(p.address)) byAddress.set(p.address, { ...p, label: null });
    const list = [...byAddress.values()];
    const q = search.trim().toLowerCase();
    return q ? list.filter((p) => p.address.toLowerCase().includes(q) || (p.label ?? '').toLowerCase().includes(q)) : list;
  }, [saved, search]);

  // ── actions ─────────────────────────────────────────────────────────────
  async function chooseDestination(place: Place) {
    setDestination(place);
    setSearch('');
    setBanner(null);
    if (!pickup) {
      setBanner({ message: 'Turn on location or pick a saved place as your pickup.', tone: 'info' });
      return;
    }
    setBusy('quote');
    try {
      const q = await api.post<Quote>('/trips/estimate', { pickup, destination: place, passengers: 1 });
      setQuote(q);
      setPhase('quoted');
    } catch (e) {
      setBanner({ message: e instanceof ApiError ? e.message : 'We could not price this trip right now.', tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  async function createTrip(): Promise<string | null> {
    if (!quote) return null;
    const created = await api.post<{ tripId: string }>(
      '/trips',
      { quoteId: quote.quoteId, paymentMethod: 'cash' },
      `${quote.quoteId}-create`,
    );
    return created.tripId;
  }

  async function bookNow() {
    if (!quote) return;
    setBusy('book');
    setBanner(null);
    try {
      const tripId = await createTrip();
      if (!tripId) return;
      await api.post(`/trips/${tripId}/accept-fare`, {});
      router.push({ pathname: '/trip', params: { id: tripId } });
      resetFlow();
    } catch (e) {
      setBanner({ message: e instanceof ApiError ? e.message : 'We could not book this trip.', tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  async function startNegotiation() {
    if (!quote) return;
    setBusy('offer');
    setBanner(null);
    try {
      const tripId = await createTrip();
      if (!tripId) return;
      const [t, n] = await Promise.all([
        api.get<TripView>(`/trips/${tripId}`),
        api.get<NegotiationView | null>(`/trips/${tripId}/negotiation`),
      ]);
      setTrip(t);
      setNegotiation(n);
      setPhase('negotiate');
    } catch (e) {
      setBanner({ message: e instanceof ApiError ? e.message : 'We could not start a negotiation.', tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  const reloadTrip = useCallback(async () => {
    if (!trip) return;
    try {
      const [t, n] = await Promise.all([
        api.get<TripView>(`/trips/${trip.id}`),
        api.get<NegotiationView | null>(`/trips/${trip.id}/negotiation`),
      ]);
      setTrip(t);
      setNegotiation(n);
      if (t.fareLocked) {
        router.push({ pathname: '/trip', params: { id: t.id } });
        resetFlow();
      }
    } catch {
      /* keep last */
    }
  }, [trip, router]);

  async function submitOffer() {
    const naira = Number(offer.replace(/[^0-9]/g, ''));
    if (!naira || !trip) return;
    setBusy('offer');
    setBanner(null);
    try {
      const r = await api.post<{ outcome: string; message: string }>(`/trips/${trip.id}/negotiate`, {
        amountMinor: naira * 100,
      });
      setOffer('');
      if (r.outcome === 'accepted') {
        router.push({ pathname: '/trip', params: { id: trip.id } });
        resetFlow();
        return;
      }
      setBanner({ message: r.message, tone: r.outcome === 'rejected' || r.outcome === 'limit_reached' ? 'danger' : 'info' });
      await reloadTrip();
    } catch (e) {
      setBanner({ message: e instanceof ApiError ? e.message : 'We could not send your offer.', tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  async function acceptCurrent() {
    if (!trip) return;
    setBusy('accept');
    setBanner(null);
    try {
      const pending = negotiation?.pendingOffer?.party === 'company' ? negotiation.pendingOffer.id : undefined;
      await api.post(`/trips/${trip.id}/accept-fare`, pending ? { offerId: pending } : {});
      router.push({ pathname: '/trip', params: { id: trip.id } });
      resetFlow();
    } catch (e) {
      setBanner({ message: e instanceof ApiError ? e.message : 'We could not confirm that fare.', tone: 'danger' });
      await reloadTrip();
    } finally {
      setBusy(null);
    }
  }

  async function cancelFlow() {
    if (trip) await api.post(`/trips/${trip.id}/cancel`, { reason: 'fare_too_high' }).catch(() => undefined);
    resetFlow();
  }

  function resetFlow() {
    setPhase('choose');
    setDestination(null);
    setQuote(null);
    setTrip(null);
    setNegotiation(null);
    setOffer('');
    setBanner(null);
  }

  // Poll while an offer is with the company; tick the countdown for a pending one.
  useEffect(() => {
    const waiting = negotiation?.status === 'AWAITING_COMPANY';
    if (waiting && !pollRef.current) pollRef.current = setInterval(() => void reloadTrip(), 5000);
    if (!waiting && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [negotiation?.status, reloadTrip]);

  useEffect(() => {
    const pending = negotiation?.pendingOffer;
    if (!pending) return;
    const tick = () => {
      const s = Math.max(0, Math.floor((new Date(pending.expiresAt).getTime() - Date.now()) / 1000));
      setRemaining(s);
      if (s === 0) void reloadTrip();
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [negotiation?.pendingOffer, reloadTrip]);

  const greeting = profile?.fullName?.split(' ')[0] ?? 'there';
  const currentFare = negotiation?.companyPositionMinor ?? trip?.quotedFareMinor ?? quote?.fareMinor ?? 0;
  const awaitingCompany = negotiation?.status === 'AWAITING_COMPANY';
  const pendingCompany = negotiation?.pendingOffer?.party === 'company';
  const offersLeft = negotiation?.offersRemaining ?? 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.surfaceMuted }} edges={['top']}>
      {/* ── MAP HERO ──────────────────────────────────────────────────────── */}
      <View style={{ flex: 1, backgroundColor: theme.color.surfaceMuted, overflow: 'hidden' }}>
        {/* top bar */}
        <View style={{ paddingHorizontal: theme.layout.screenPadding, paddingTop: theme.spacing.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View>
            <Label variant="caption" tone="muted">Hello, {greeting}</Label>
            <Label variant="h2">Book a ride</Label>
          </View>
          <Pressable onPress={() => router.push('/profile')} hitSlop={10} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: theme.color.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Label variant="bodyStrong" tone="inverse">{greeting.charAt(0).toUpperCase()}</Label>
          </Pressable>
        </View>

        {/* stylised route panel (a real map drops in here on native builds) */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.spacing.xl }}>
          <RouteGlyph hasDestination={!!destination} />
          {destination ? (
            <Label variant="bodyStrong" center style={{ marginTop: theme.spacing.lg }} numberOfLines={2}>
              {destination.address}
            </Label>
          ) : (
            <Label variant="body" tone="muted" center style={{ marginTop: theme.spacing.lg }}>
              Pick where you're going to see your fare
            </Label>
          )}
        </View>
      </View>

      {/* ── ACTIVE TRIP PILL (a driver is on the way) ─────────────────────── */}
      {active ? (
        <Pressable
          onPress={() => router.push({ pathname: '/trip', params: { id: active.id } })}
          style={{ position: 'absolute', top: 96, left: theme.layout.screenPadding, right: theme.layout.screenPadding, backgroundColor: theme.color.primary, borderRadius: theme.radius.lg, padding: theme.spacing.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', ...theme.shadow.card }}
        >
          <View style={{ flex: 1 }}>
            <Label variant="caption" tone="inverse">{active.statusLabel}</Label>
            <Label variant="bodyStrong" tone="inverse" numberOfLines={1}>{active.destination.address}</Label>
          </View>
          <Label variant="bodyStrong" tone="inverse">{active.fareLabel}</Label>
        </Pressable>
      ) : null}

      {/* ── SHEET ─────────────────────────────────────────────────────────── */}
      <View style={{ backgroundColor: theme.color.surface, borderTopLeftRadius: theme.radius['2xl'], borderTopRightRadius: theme.radius['2xl'], marginTop: -theme.radius['2xl'], maxHeight: '62%', ...theme.shadow.sheet }}>
        <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.borderStrong, alignSelf: 'center', marginTop: theme.spacing.sm }} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: theme.layout.screenPadding, paddingBottom: theme.spacing['2xl'] }}>

          {banner ? <View style={{ marginBottom: theme.spacing.md }}><Banner message={banner.message} tone={banner.tone} /></View> : null}

          {/* PHASE: choose destination */}
          {phase === 'choose' ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, marginBottom: theme.spacing.md }}>
                <Dot filled />
                <Label variant="body" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>{pickup?.address ?? 'Set pickup'}</Label>
              </View>
              <Field
                label="Where to?"
                value={search}
                onChangeText={setSearch}
                placeholder="Search a place or landmark"
                autoCorrect={false}
              />
              {busy === 'quote' ? (
                <Label variant="caption" tone="muted" style={{ marginBottom: theme.spacing.sm }}>Getting your fare…</Label>
              ) : null}
              <View style={{ gap: theme.spacing.xs }}>
                {destinations.slice(0, 8).map((place) => (
                  <Pressable
                    key={place.address}
                    onPress={() => chooseDestination(place)}
                    disabled={busy !== null}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.md, opacity: pressed ? 0.6 : 1 })}
                  >
                    <Dot />
                    <View style={{ flex: 1 }}>
                      {place.label ? <Label variant="bodyStrong">{place.label}</Label> : null}
                      <Label variant={place.label ? 'caption' : 'body'} tone={place.label ? 'muted' : 'default'} numberOfLines={1}>
                        {place.address}
                      </Label>
                    </View>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          {/* PHASE: quoted — fare + book / offer */}
          {phase === 'quoted' && quote ? (
            <>
              <Label variant="overline" tone="muted">Your fare</Label>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4, marginBottom: theme.spacing.lg }}>
                <Label variant="fare">{formatMoney(quote.fareMinor)}</Label>
                <Label variant="caption" tone="muted">cash · agreed upfront</Label>
              </View>
              <Button label="Book Now" onPress={bookNow} loading={busy === 'book'} disabled={busy !== null} />
              <View style={{ height: theme.spacing.sm }} />
              <Button label="Make an offer" variant="secondary" onPress={startNegotiation} loading={busy === 'offer'} disabled={busy !== null} />
              <Pressable onPress={resetFlow} disabled={busy !== null} style={{ marginTop: theme.spacing.md, alignItems: 'center' }}>
                <Label variant="caption" tone="muted">Change destination</Label>
              </Pressable>
            </>
          ) : null}

          {/* PHASE: negotiate */}
          {phase === 'negotiate' && trip ? (
            <>
              <Label variant="overline" tone="muted">{pendingCompany ? 'Our offer' : 'Current fare'}</Label>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4 }}>
                <Label variant="fare">{formatMoney(currentFare)}</Label>
                {negotiation && negotiation.originalFareMinor !== currentFare ? (
                  <Label variant="caption" tone="muted">was {formatMoney(negotiation.originalFareMinor)}</Label>
                ) : null}
              </View>

              {pendingCompany ? (
                <View style={{ marginTop: theme.spacing.sm }}>
                  <Badge label={remaining <= 0 ? 'Offer expired' : `Expires in ${humanizeCountdown(remaining)}`} tone={remaining < 60 ? 'danger' : 'neutral'} />
                </View>
              ) : null}

              {awaitingCompany ? (
                <Label variant="caption" tone="muted" style={{ marginTop: theme.spacing.md }}>
                  Reviewing your offer of {formatMoney(negotiation?.customerPositionMinor ?? 0)} — usually under a minute.
                </Label>
              ) : null}

              {negotiation && negotiation.timeline.length > 0 ? (
                <View style={{ marginTop: theme.spacing.lg, gap: theme.spacing.sm }}>
                  {negotiation.timeline.map((e) => (
                    <View key={e.id} style={{ alignSelf: e.party === 'customer' ? 'flex-end' : 'flex-start', backgroundColor: e.party === 'customer' ? theme.color.primary : theme.color.surfaceMuted, borderRadius: theme.radius.lg, paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
                      <Label variant="caption" tone={e.party === 'customer' ? 'inverse' : 'muted'}>
                        {e.party === 'customer' ? 'You' : 'TransportCo'}
                      </Label>
                      <Label variant="bodyStrong" tone={e.party === 'customer' ? 'inverse' : 'default'}>{formatMoney(e.amountMinor)}</Label>
                    </View>
                  ))}
                </View>
              ) : null}

              {!awaitingCompany && offersLeft > 0 ? (
                <View style={{ marginTop: theme.spacing.lg }}>
                  <Field
                    label={`I'd rather pay (₦) · ${offersLeft} left`}
                    value={offer}
                    onChangeText={(v) => setOffer(v.replace(/[^0-9]/g, ''))}
                    keyboardType="number-pad"
                    placeholder={String(Math.round((currentFare * 0.9) / 100))}
                  />
                  <Button label="Send offer" variant="secondary" onPress={submitOffer} loading={busy === 'offer'} disabled={busy !== null || offer.length === 0} />
                </View>
              ) : null}

              <View style={{ height: theme.spacing.lg }} />
              <Button label={`Accept ${formatMoney(currentFare)}`} onPress={acceptCurrent} loading={busy === 'accept'} disabled={busy !== null || awaitingCompany || (pendingCompany && remaining <= 0)} />
              <Pressable onPress={cancelFlow} disabled={busy !== null} style={{ marginTop: theme.spacing.md, alignItems: 'center' }}>
                <Label variant="caption" tone="muted">Cancel</Label>
              </Pressable>
            </>
          ) : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

// ── small monochrome primitives ───────────────────────────────────────────
function Dot({ filled }: { filled?: boolean }) {
  return (
    <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: theme.color.text, backgroundColor: filled ? theme.color.text : 'transparent' }} />
  );
}

/** A stylised A→B route glyph standing in for the live map inside Expo Go. */
function RouteGlyph({ hasDestination }: { hasDestination: boolean }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: theme.color.text }} />
      <View style={{ width: 3, height: 46, backgroundColor: hasDestination ? theme.color.text : theme.color.borderStrong, marginVertical: 4, borderRadius: 2 }} />
      <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: hasDestination ? theme.color.text : theme.color.borderStrong }} />
    </View>
  );
}
