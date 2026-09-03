import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, LayoutAnimation, Platform, Pressable, ScrollView, TextInput, UIManager, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { formatMoney, humanizeCountdown } from '@transportco/utils';
import { Badge, Banner, Button, Field, Label, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Home — the whole ride on one screen.
 *
 * A map fills the screen; a collapsible sheet floats over it and carries the
 * customer from pickup + destination -> fare -> book or negotiate, never
 * changing pages. Only the live trip gets a screen of its own.
 */

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
const animate = () => LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));

interface Place { latitude: number; longitude: number; address: string; label?: string | null }
interface SavedLocation extends Place { id: string; label: string }
interface ActiveTrip { id: string; statusLabel: string; fareLabel: string; destination: { address: string } }
interface Quote { quoteId: string; fareMinor: number }
interface TripView { id: string; quotedFareMinor: number; fareLocked: boolean }
interface NegotiationView {
  status: string;
  originalFareMinor: number;
  companyPositionMinor: number;
  customerPositionMinor: number | null;
  offersRemaining: number;
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

interface TrackingTrip {
  id: string;
  status: string;
  statusLabel: string;
  quotedFareMinor: number;
  finalFareMinor: number | null;
  pickup: { address: string };
  destination: { address: string };
  driver: { name: string; vehicle: { make: string; model: string; color: string; plateNumber: string } | null } | null;
}

type Phase = 'choose' | 'quoted' | 'negotiate' | 'tracking';
type Editing = 'from' | 'to' | null;

export default function Home() {
  const router = useRouter();
  const { profile } = useSession();

  const [pickup, setPickup] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [active, setActive] = useState<ActiveTrip | null>(null);

  const [editing, setEditing] = useState<Editing>(null);
  const [search, setSearch] = useState('');
  const [phase, setPhase] = useState<Phase>('choose');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [trip, setTrip] = useState<TripView | null>(null);
  const [negotiation, setNegotiation] = useState<NegotiationView | null>(null);
  const [offer, setOffer] = useState('');
  const [busy, setBusy] = useState<null | 'quote' | 'book' | 'offer' | 'accept'>(null);
  const [banner, setBanner] = useState<{ message: string; tone: 'info' | 'danger' | 'success' } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tracking: after booking, the sheet flips to a black card instead of a page.
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [tracking, setTracking] = useState<TrackingTrip | null>(null);
  const flip = useRef(new Animated.Value(0)).current;

  function enterTracking(tripId: string) {
    setBanner(null);
    setTrackingId(tripId);
    setPhase('tracking');
    setEditing(null);
    Animated.timing(flip, { toValue: 1, duration: 550, useNativeDriver: true }).start();
  }
  function leaveTracking() {
    Animated.timing(flip, { toValue: 0, duration: 380, useNativeDriver: true }).start(() => {
      setTrackingId(null);
      setTracking(null);
      resetFlow();
      void load();
    });
  }
  // Returns whether the cancellation actually succeeded. The pill and the
  // tracking card are only torn down on a real success, so a rejected reason
  // (or a network error) leaves the ride — and the picker — in place.
  async function cancelRide(reason: string, note: string): Promise<boolean> {
    if (!trackingId) return false;
    setBusy('accept');
    try {
      await api.post(`/trips/${trackingId}/cancel`, { reason, note: note || undefined });
      setBusy(null);
      setActive(null);
      leaveTracking();
      return true;
    } catch {
      setBusy(null);
      return false;
    }
  }

  useEffect(() => {
    if (!trackingId) return;
    const pull = () => { void api.get<TrackingTrip>(`/trips/${trackingId}`).then(setTracking).catch(() => undefined); };
    pull();
    const t = setInterval(pull, 6000);
    return () => clearInterval(t);
  }, [trackingId]);

  useEffect(() => {
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setPickup((p) => p ?? { latitude: pos.coords.latitude, longitude: pos.coords.longitude, address: 'Current location' });
      } catch { /* pick a pickup manually */ }
    })();
  }, []);

  const load = useCallback(async () => {
    const [locations, activeTrip] = await Promise.all([
      api.get<SavedLocation[]>('/customer/me/locations').catch(() => [] as SavedLocation[]),
      api.get<ActiveTrip | null>('/trips/active').catch(() => null),
    ]);
    setSaved(locations);
    setActive(activeTrip);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const places = useMemo(() => {
    const byAddress = new Map<string, Place>();
    for (const s of saved) byAddress.set(s.address, { ...s, label: s.label });
    for (const p of LANDMARKS) if (!byAddress.has(p.address)) byAddress.set(p.address, { ...p, label: null });
    const list = [...byAddress.values()];
    const q = search.trim().toLowerCase();
    return q ? list.filter((p) => p.address.toLowerCase().includes(q) || (p.label ?? '').toLowerCase().includes(q)) : list;
  }, [saved, search]);

  async function quoteFor(pu: Place, dest: Place) {
    setBusy('quote');
    setBanner(null);
    try {
      const q = await api.post<Quote>('/trips/estimate', { pickup: pu, destination: dest, passengers: 1 });
      setQuote(q);
      animate();
      setPhase('quoted');
      setEditing(null);
    } catch (e) {
      setBanner({ message: e instanceof ApiError ? e.message : 'We could not price this trip right now.', tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  function pick(place: Place) {
    setSearch('');
    if (editing === 'from') {
      setPickup(place);
      if (destination) void quoteFor(place, destination);
      else { animate(); setEditing(null); }
    } else {
      setDestination(place);
      if (pickup) void quoteFor(pickup, place);
      else { animate(); setEditing('from'); }
    }
  }

  async function useCurrentLocation() {
    setBanner(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setBanner({ message: 'Turn on location access to use your current spot.', tone: 'info' }); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const here: Place = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, address: 'Current location' };
      setPickup(here);
      setSearch('');
      if (destination) void quoteFor(here, destination);
      else { animate(); setEditing(null); }
    } catch {
      setBanner({ message: 'We could not get your location.', tone: 'danger' });
    }
  }

  function startEditing(which: Editing) { animate(); setEditing(which); setSearch(''); }

  async function createTrip(): Promise<string | null> {
    if (!quote) return null;
    const created = await api.post<{ tripId: string }>('/trips', { quoteId: quote.quoteId, paymentMethod: 'cash' }, `${quote.quoteId}-create`);
    return created.tripId;
  }
  async function bookNow() {
    if (!quote) return;
    setBusy('book'); setBanner(null);
    try {
      const tripId = await createTrip();
      if (!tripId) return;
      await api.post(`/trips/${tripId}/accept-fare`, {});
      enterTracking(tripId);
    } catch (e) { setBanner({ message: e instanceof ApiError ? e.message : 'We could not book this trip.', tone: 'danger' }); }
    finally { setBusy(null); }
  }
  async function startNegotiation() {
    if (!quote) return;
    setBusy('offer'); setBanner(null);
    try {
      const tripId = await createTrip();
      if (!tripId) return;
      const [t, n] = await Promise.all([api.get<TripView>(`/trips/${tripId}`), api.get<NegotiationView | null>(`/trips/${tripId}/negotiation`)]);
      setTrip(t); setNegotiation(n); animate(); setPhase('negotiate');
    } catch (e) { setBanner({ message: e instanceof ApiError ? e.message : 'We could not start a negotiation.', tone: 'danger' }); }
    finally { setBusy(null); }
  }
  const reloadTrip = useCallback(async () => {
    if (!trip) return;
    try {
      const [t, n] = await Promise.all([api.get<TripView>(`/trips/${trip.id}`), api.get<NegotiationView | null>(`/trips/${trip.id}/negotiation`)]);
      setTrip(t); setNegotiation(n);
      if (t.fareLocked) { enterTracking(t.id); }
    } catch { /* keep */ }
  }, [trip, router]);
  async function submitOffer() {
    const naira = Number(offer.replace(/[^0-9]/g, ''));
    if (!naira || !trip) return;
    setBusy('offer'); setBanner(null);
    try {
      const r = await api.post<{ outcome: string; message: string }>(`/trips/${trip.id}/negotiate`, { amountMinor: naira * 100 });
      setOffer('');
      if (r.outcome === 'accepted') { enterTracking(trip.id); return; }
      setBanner({ message: r.message, tone: r.outcome === 'rejected' || r.outcome === 'limit_reached' ? 'danger' : 'info' });
      await reloadTrip();
    } catch (e) { setBanner({ message: e instanceof ApiError ? e.message : 'We could not send your offer.', tone: 'danger' }); }
    finally { setBusy(null); }
  }
  async function acceptCurrent() {
    if (!trip) return;
    setBusy('accept'); setBanner(null);
    try {
      const pending = negotiation?.pendingOffer?.party === 'company' ? negotiation.pendingOffer.id : undefined;
      await api.post(`/trips/${trip.id}/accept-fare`, pending ? { offerId: pending } : {});
      enterTracking(trip.id);
    } catch (e) { setBanner({ message: e instanceof ApiError ? e.message : 'We could not confirm that fare.', tone: 'danger' }); await reloadTrip(); }
    finally { setBusy(null); }
  }
  async function cancelFlow() {
    if (trip) await api.post(`/trips/${trip.id}/cancel`, { reason: 'fare_too_high' }).catch(() => undefined);
    resetFlow();
  }
  function resetFlow() { animate(); setPhase('choose'); setDestination(null); setQuote(null); setTrip(null); setNegotiation(null); setOffer(''); setBanner(null); setEditing(null); }

  useEffect(() => {
    const waiting = negotiation?.status === 'AWAITING_COMPANY';
    if (waiting && !pollRef.current) pollRef.current = setInterval(() => void reloadTrip(), 5000);
    if (!waiting && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [negotiation?.status, reloadTrip]);
  useEffect(() => {
    const pending = negotiation?.pendingOffer;
    if (!pending) return;
    const tick = () => { const s = Math.max(0, Math.floor((new Date(pending.expiresAt).getTime() - Date.now()) / 1000)); setRemaining(s); if (s === 0) void reloadTrip(); };
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [negotiation?.pendingOffer, reloadTrip]);

  const currentFare = negotiation?.companyPositionMinor ?? trip?.quotedFareMinor ?? quote?.fareMinor ?? 0;
  const awaitingCompany = negotiation?.status === 'AWAITING_COMPANY';
  const pendingCompany = negotiation?.pendingOffer?.party === 'company';
  const offersLeft = negotiation?.offersRemaining ?? 0;
  const initial = (profile?.fullName ?? 'You').charAt(0).toUpperCase();

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.surfaceMuted }}>
      {/* ── MAP ──────────────────────────────────────────────────────────── */}
      <MapCanvas hasRoute={!!destination} />

      {/* floating top controls */}
      <SafeAreaView edges={['top']} style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: theme.layout.screenPadding, paddingTop: theme.spacing.sm }}>
          <View style={{ backgroundColor: theme.color.surface, borderRadius: theme.radius.pill, paddingHorizontal: theme.spacing.md, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6, ...theme.shadow.card }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.text }} />
            <Label variant="caption" tone="secondary">Drivers nearby</Label>
          </View>
          <Pressable onPress={() => router.push('/profile')} hitSlop={8} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: theme.color.surface, alignItems: 'center', justifyContent: 'center', ...theme.shadow.card }}>
            <Label variant="bodyStrong">{initial}</Label>
          </Pressable>
        </View>
      </SafeAreaView>

      {/* active trip pill — tapping flips the sheet into the black tracking card
          (see enterTracking), rather than pushing to the full-page trip screen */}
      {active && phase !== 'tracking' ? (
        <Pressable onPress={() => enterTracking(active.id)} style={{ position: 'absolute', top: 100, left: theme.layout.screenPadding, right: theme.layout.screenPadding, backgroundColor: theme.color.primary, borderRadius: theme.radius.lg, padding: theme.spacing.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', ...theme.shadow.card }}>
          <View style={{ flex: 1 }}>
            <Label variant="caption" tone="inverse">{active.statusLabel}</Label>
            <Label variant="bodyStrong" tone="inverse" numberOfLines={1}>{active.destination.address}</Label>
          </View>
          <Label variant="bodyStrong" tone="inverse">{active.fareLabel}</Label>
        </Pressable>
      ) : null}

      {/* ── TRACKING — the sheet flips to a black card after booking ─────── */}
      {phase === 'tracking' ? (
        <TrackingFlip
          flip={flip}
          from={pickup?.address ?? ''}
          to={destination?.address ?? ''}
          fareMinor={quote?.fareMinor ?? trip?.quotedFareMinor ?? 0}
          trip={tracking}
          onCancel={cancelRide}
          onOpen={() => { if (trackingId) router.push({ pathname: '/trip', params: { id: trackingId } }); }}
          onDone={leaveTracking}
          busy={busy === 'accept'}
        />
      ) : null}

      {/* ── COLLAPSIBLE SHEET ────────────────────────────────────────────── */}
      {phase !== 'tracking' ? (
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: theme.color.surface, borderTopLeftRadius: theme.radius['2xl'], borderTopRightRadius: theme.radius['2xl'], maxHeight: editing ? '82%' : '58%', ...theme.shadow.sheet }}>
        <Pressable onPress={() => { animate(); setEditing((e) => (e ? null : 'to')); }} hitSlop={12} style={{ alignItems: 'center', paddingTop: theme.spacing.sm, paddingBottom: 2 }}>
          <View style={{ width: 44, height: 5, borderRadius: 3, backgroundColor: theme.color.borderStrong }} />
        </Pressable>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: theme.layout.screenPadding, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing['2xl'] }}>
          <SafeAreaView edges={['bottom']}>
            <Label variant="h2">Book a ride</Label>

            {banner ? <View style={{ marginTop: theme.spacing.md }}><Banner message={banner.message} tone={banner.tone} /></View> : null}

            {/* FROM / TO — the two inputs */}
            {phase === 'choose' ? (
              <View style={{ marginTop: theme.spacing.md, backgroundColor: theme.color.surfaceMuted, borderRadius: theme.radius.lg, padding: theme.spacing.sm }}>
                <FromToRow active={editing === 'from'} icon="ring" label="From" value={pickup?.address ?? 'Set pickup'} placeholder={!pickup} onPress={() => startEditing('from')} />
                <View style={{ height: 1, backgroundColor: theme.color.border, marginLeft: 34 }} />
                <FromToRow active={editing === 'to'} icon="dot" label="To" value={destination?.address ?? 'Where to?'} placeholder={!destination} onPress={() => startEditing('to')} />
              </View>
            ) : null}

            {/* SEARCH + LIST (only while editing a field) */}
            {phase === 'choose' && editing ? (
              <View style={{ marginTop: theme.spacing.md }}>
                <Field
                  label={editing === 'from' ? 'Enter pickup' : 'Enter destination'}
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search a place or landmark"
                  autoCorrect={false}
                  autoFocus
                />
                {editing === 'from' ? (
                  <Pressable onPress={useCurrentLocation} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.md, opacity: pressed ? 0.6 : 1 })}>
                    <View style={{ width: 34, alignItems: 'center' }}>
                      <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 4, borderColor: theme.color.text }} />
                    </View>
                    <Label variant="bodyStrong">Use my current location</Label>
                  </Pressable>
                ) : null}
                {busy === 'quote' ? <Label variant="caption" tone="muted" style={{ paddingVertical: theme.spacing.sm }}>Getting your fare…</Label> : null}
                {places.slice(0, 7).map((place) => (
                  <Pressable key={place.address} onPress={() => pick(place)} disabled={busy !== null} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.md, opacity: pressed ? 0.6 : 1 })}>
                    <View style={{ width: 34, alignItems: 'center' }}><Marker kind="dot" /></View>
                    <View style={{ flex: 1 }}>
                      {place.label ? <Label variant="bodyStrong">{place.label}</Label> : null}
                      <Label variant={place.label ? 'caption' : 'body'} tone={place.label ? 'muted' : 'default'} numberOfLines={1}>{place.address}</Label>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {/* QUOTED */}
            {phase === 'quoted' && quote ? (
              <>
                <View style={{ marginTop: theme.spacing.md, backgroundColor: theme.color.surfaceMuted, borderRadius: theme.radius.lg, padding: theme.spacing.md }}>
                  <RouteSummary from={pickup?.address ?? ''} to={destination?.address ?? ''} onEdit={resetFlow} />
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: theme.spacing.lg, marginBottom: theme.spacing.md }}>
                  <Label variant="fare">{formatMoney(quote.fareMinor)}</Label>
                  <Label variant="caption" tone="muted">cash · agreed upfront</Label>
                </View>
                <Button label="Book Now" onPress={bookNow} loading={busy === 'book'} disabled={busy !== null} />
                <View style={{ height: theme.spacing.sm }} />
                <Button label="Make an offer" variant="secondary" onPress={startNegotiation} loading={busy === 'offer'} disabled={busy !== null} />
              </>
            ) : null}

            {/* NEGOTIATE */}
            {phase === 'negotiate' && trip ? (
              <>
                <Label variant="overline" tone="muted" style={{ marginTop: theme.spacing.md }}>{pendingCompany ? 'Our offer' : 'Current fare'}</Label>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4 }}>
                  <Label variant="fare">{formatMoney(currentFare)}</Label>
                  {negotiation && negotiation.originalFareMinor !== currentFare ? <Label variant="caption" tone="muted">was {formatMoney(negotiation.originalFareMinor)}</Label> : null}
                </View>
                {pendingCompany ? <View style={{ marginTop: theme.spacing.sm }}><Badge label={remaining <= 0 ? 'Offer expired' : `Expires in ${humanizeCountdown(remaining)}`} tone="neutral" /></View> : null}
                {awaitingCompany ? <Label variant="caption" tone="muted" style={{ marginTop: theme.spacing.md }}>Reviewing your offer of {formatMoney(negotiation?.customerPositionMinor ?? 0)} — usually under a minute.</Label> : null}
                {negotiation && negotiation.timeline.length > 0 ? (
                  <View style={{ marginTop: theme.spacing.lg, gap: theme.spacing.sm }}>
                    {negotiation.timeline.map((e) => (
                      <View key={e.id} style={{ alignSelf: e.party === 'customer' ? 'flex-end' : 'flex-start', backgroundColor: e.party === 'customer' ? theme.color.primary : theme.color.surfaceMuted, borderRadius: theme.radius.lg, paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
                        <Label variant="caption" tone={e.party === 'customer' ? 'inverse' : 'muted'}>{e.party === 'customer' ? 'You' : 'PEGO'}</Label>
                        <Label variant="bodyStrong" tone={e.party === 'customer' ? 'inverse' : 'default'}>{formatMoney(e.amountMinor)}</Label>
                      </View>
                    ))}
                  </View>
                ) : null}
                {!awaitingCompany && offersLeft > 0 ? (
                  <View style={{ marginTop: theme.spacing.lg }}>
                    <Field label={`I'd rather pay (₦) · ${offersLeft} left`} value={offer} onChangeText={(v) => setOffer(v.replace(/[^0-9]/g, ''))} keyboardType="number-pad" placeholder={String(Math.round((currentFare * 0.9) / 100))} />
                    <Button label="Send offer" variant="secondary" onPress={submitOffer} loading={busy === 'offer'} disabled={busy !== null || offer.length === 0} />
                  </View>
                ) : null}
                <View style={{ height: theme.spacing.lg }} />
                <Button label={`Accept ${formatMoney(currentFare)}`} onPress={acceptCurrent} loading={busy === 'accept'} disabled={busy !== null || awaitingCompany || (pendingCompany && remaining <= 0)} />
                <Pressable onPress={cancelFlow} disabled={busy !== null} style={{ marginTop: theme.spacing.md, alignItems: 'center' }}><Label variant="caption" tone="muted">Cancel</Label></Pressable>
              </>
            ) : null}
          </SafeAreaView>
        </ScrollView>
      </View>
      ) : null}
    </View>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────────
function Marker({ kind }: { kind: 'ring' | 'dot' }) {
  return kind === 'ring'
    ? <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 3, borderColor: theme.color.text }} />
    : <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: theme.color.text }} />;
}

function FromToRow({ active, icon, label, value, placeholder, onPress }: { active: boolean; icon: 'ring' | 'dot'; label: string; value: string; placeholder?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.md, paddingHorizontal: theme.spacing.sm }}>
      <View style={{ width: 22, alignItems: 'center' }}><Marker kind={icon} /></View>
      <View style={{ flex: 1 }}>
        <Label variant="overline" tone="muted">{label}</Label>
        <Label variant="bodyStrong" tone={placeholder ? 'muted' : 'default'} numberOfLines={1}>{value}</Label>
      </View>
      {active ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.color.text }} /> : null}
    </Pressable>
  );
}

function RouteSummary({ from, to, onEdit }: { from: string; to: string; onEdit: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <View style={{ width: 22, alignItems: 'center' }}>
        <Marker kind="ring" />
        <View style={{ width: 2, height: 18, backgroundColor: theme.color.borderStrong, marginVertical: 3 }} />
        <Marker kind="dot" />
      </View>
      <View style={{ flex: 1, marginLeft: theme.spacing.sm, gap: theme.spacing.lg }}>
        <Label variant="body" numberOfLines={1}>{from}</Label>
        <Label variant="body" numberOfLines={1}>{to}</Label>
      </View>
      <Pressable onPress={onEdit} hitSlop={8}><Label variant="caption" tone="muted">Edit</Label></Pressable>
    </View>
  );
}

/** A stylised map standing in for the live map inside Expo Go (a real map view
 *  drops in on a native build). Faint streets, a scatter of nearby drivers, and
 *  the pickup marker at the centre. */
function MapCanvas({ hasRoute }: { hasRoute: boolean }) {
  const streets = [
    { top: '18%', left: '-10%', w: '120%', h: 2, rot: '8deg' },
    { top: '46%', left: '-10%', w: '120%', h: 3, rot: '-5deg' },
    { top: '72%', left: '-10%', w: '120%', h: 2, rot: '4deg' },
    { top: '-10%', left: '30%', w: 2, h: '120%', rot: '10deg' },
    { top: '-10%', left: '66%', w: 3, h: '120%', rot: '-8deg' },
  ] as const;
  const drivers = [
    { top: '30%', left: '24%' }, { top: '38%', left: '70%' }, { top: '58%', left: '40%' }, { top: '64%', left: '78%' }, { top: '26%', left: '52%' },
  ] as const;
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.color.surfaceMuted, overflow: 'hidden' }}>
      {streets.map((s, i) => (
        <View key={i} style={{ position: 'absolute', top: s.top as never, left: s.left as never, width: s.w as never, height: s.h as never, backgroundColor: theme.color.border, transform: [{ rotate: s.rot }] }} />
      ))}
      {drivers.map((d, i) => (
        <View key={i} style={{ position: 'absolute', top: d.top as never, left: d.left as never, width: 26, height: 26, borderRadius: 13, backgroundColor: theme.color.surface, alignItems: 'center', justifyContent: 'center', ...theme.shadow.card }}>
          <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: theme.color.text }} />
        </View>
      ))}
      {/* pickup marker, upper third so the sheet doesn't cover it */}
      <View style={{ position: 'absolute', top: '34%', left: 0, right: 0, alignItems: 'center' }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: theme.color.text, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.surface }} />
        </View>
        {hasRoute ? <View style={{ marginTop: 4, backgroundColor: theme.color.text, paddingHorizontal: 10, paddingVertical: 3, borderRadius: theme.radius.pill }}><Label variant="caption" tone="inverse">Your route</Label></View> : null}
      </View>
    </View>
  );
}

const MUTED_ON_DARK = 'rgba(255,255,255,0.6)';

/** Cancellation reasons — keys must match the API's cancelTripSchema enum. */
const CANCEL_REASONS: { key: string; label: string }[] = [
  { key: 'changed_plans', label: 'Plans changed' },
  { key: 'driver_taking_too_long', label: 'Driver too slow' },
  { key: 'wrong_address', label: 'Wrong address' },
  { key: 'found_another_ride', label: 'Found another ride' },
  { key: 'fare_too_high', label: 'Fare too high' },
  { key: 'safety_concern', label: 'Safety concern' },
  { key: 'other', label: 'Something else' },
];

/** The booking sheet flips over to this on booking: a black card that finds the
 *  driver, shows who's coming, and lets the customer cancel until the driver
 *  moves — no page change. */
function TrackingFlip({ flip, from, to, fareMinor, trip, onCancel, onOpen, onDone, busy }: {
  flip: Animated.Value; from: string; to: string; fareMinor: number;
  trip: TrackingTrip | null; onCancel: (reason: string, note: string) => Promise<boolean>; onOpen: () => void; onDone: () => void; busy: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [failed, setFailed] = useState(false);
  const confirmCancel = async () => {
    if (!reason) return;
    setFailed(false);
    const ok = await onCancel(reason, note.trim());
    if (!ok) setFailed(true); // the card stays open so they can retry
  };
  const closePicker = () => { animate(); setPicking(false); setReason(null); setNote(''); setFailed(false); };
  const frontRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const backRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] });
  // Shared face look. The BACK face flows normally so the card is exactly as
  // tall as its content; the FRONT face is overlaid absolutely on top of it.
  const face = {
    borderTopLeftRadius: theme.radius['2xl'], borderTopRightRadius: theme.radius['2xl'],
    backfaceVisibility: 'hidden', paddingHorizontal: theme.layout.screenPadding, paddingTop: theme.spacing.lg,
  } as const;
  const frontFill = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as const;

  const status = trip?.status ?? 'FARE_LOCKED';
  const cancellable = ['FARE_LOCKED', 'DRIVER_ASSIGNED'].includes(status);
  const done = ['TRIP_COMPLETED', 'REVIEW_PENDING', 'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED'].includes(status);
  const fare = trip?.finalFareMinor ?? trip?.quotedFareMinor ?? fareMinor;
  // Entered from the active-trip pill after a reload? The in-session pickup /
  // destination are gone, so fall back to the addresses on the fetched trip.
  const fromAddr = from || trip?.pickup.address || '';
  const toAddr = to || trip?.destination.address || '';

  return (
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
      {/* FRONT — white summary, flips away (overlaid on the back face) */}
      <Animated.View style={[face, frontFill, { backgroundColor: theme.color.surface, transform: [{ perspective: 1200 }, { rotateY: frontRotate }], ...theme.shadow.sheet }]}>
        <Handle dark={false} />
        <Label variant="h2">{trip?.driver ? 'Your ride' : 'Finding your driver…'}</Label>
        <View style={{ marginTop: theme.spacing.lg }}><RouteMini from={fromAddr} to={toAddr} inverse={false} /></View>
        <Label variant="fare" style={{ marginTop: theme.spacing.lg }}>{formatMoney(fare)}</Label>
      </Animated.View>

      {/* BACK — black tracking card. In normal flow, so it sets the card height. */}
      <Animated.View style={[face, { backgroundColor: theme.color.primaryDark, paddingBottom: theme.spacing['2xl'], transform: [{ perspective: 1200 }, { rotateY: backRotate }], ...theme.shadow.sheet }]}>
        <Handle dark />
        {picking ? (
          /* Why are you cancelling? — reason chips + an optional note. */
          <>
            <Label variant="h2" tone="inverse">Cancel this ride?</Label>
            <Label variant="caption" style={{ color: MUTED_ON_DARK, marginTop: 4 }}>Tell us why — it helps us keep drivers on time.</Label>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm, marginTop: theme.spacing.lg }}>
              {CANCEL_REASONS.map((r) => {
                const on = reason === r.key;
                return (
                  <Pressable key={r.key} onPress={() => setReason(r.key)} style={{ paddingHorizontal: theme.spacing.md, paddingVertical: 9, borderRadius: theme.radius.pill, backgroundColor: on ? theme.color.surface : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: on ? theme.color.surface : 'rgba(255,255,255,0.14)' }}>
                    <Label variant="caption" style={{ color: on ? theme.color.text : 'rgba(255,255,255,0.85)', fontWeight: '600' }}>{r.label}</Label>
                  </Pressable>
                );
              })}
            </View>

            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder={reason === 'other' ? 'Tell us what happened' : 'Add a note (optional)'}
              placeholderTextColor="rgba(255,255,255,0.4)"
              multiline
              style={{ marginTop: theme.spacing.lg, minHeight: 46, borderRadius: theme.radius.md, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm, color: theme.color.surface, fontSize: 15 }}
            />

            {failed ? <Label variant="caption" style={{ color: '#ff8a80', marginTop: theme.spacing.sm }}>We couldn’t cancel just now. Please try again.</Label> : null}

            <View style={{ marginTop: theme.spacing.lg }}>
              <Button label="Confirm cancellation" variant="secondary" onPress={confirmCancel} loading={busy} disabled={!reason || busy} />
              <Pressable onPress={closePicker} disabled={busy} style={{ marginTop: theme.spacing.md, alignItems: 'center' }}><Label variant="caption" style={{ color: MUTED_ON_DARK }}>Keep my ride</Label></Pressable>
            </View>
          </>
        ) : (
          <>
            <Label variant="overline" style={{ color: MUTED_ON_DARK }}>{trip?.driver ? 'Your driver' : 'Finding your driver'}</Label>
            {trip?.driver ? (
              <View style={{ marginTop: theme.spacing.sm, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
                <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' }}>
                  <Label variant="h3" tone="inverse">{trip.driver.name.charAt(0)}</Label>
                </View>
                <View style={{ flex: 1 }}>
                  <Label variant="h3" tone="inverse">{trip.driver.name}</Label>
                  {trip.driver.vehicle ? <Label variant="caption" style={{ color: MUTED_ON_DARK }} numberOfLines={1}>{trip.driver.vehicle.color} {trip.driver.vehicle.make} {trip.driver.vehicle.model} · {trip.driver.vehicle.plateNumber}</Label> : null}
                </View>
              </View>
            ) : (
              <Label variant="h2" tone="inverse" style={{ marginTop: 4 }}>{trip?.statusLabel ?? 'Assigning a company driver'}</Label>
            )}

            <View style={{ marginTop: theme.spacing.lg }}><RouteMini from={fromAddr} to={toAddr} inverse /></View>

            <View style={{ marginTop: theme.spacing.lg, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <View>
                <Label variant="overline" style={{ color: MUTED_ON_DARK }}>Agreed fare</Label>
                <Label variant="h1" tone="inverse">{formatMoney(fare)}</Label>
              </View>
              <Pressable onPress={onOpen} hitSlop={8}><Label variant="caption" style={{ color: MUTED_ON_DARK }}>Full trip ›</Label></Pressable>
            </View>

            <View style={{ marginTop: theme.spacing.lg }}>
              {done ? (
                <Button label="Done" variant="secondary" onPress={onDone} />
              ) : cancellable ? (
                <Button label="Cancel ride" variant="secondary" onPress={() => { animate(); setPicking(true); }} />
              ) : (
                <Label variant="caption" center style={{ color: MUTED_ON_DARK }}>Your driver is on the way — sit tight.</Label>
              )}
            </View>
          </>
        )}
      </Animated.View>
    </View>
  );
}

function Handle({ dark }: { dark: boolean }) {
  return <View style={{ width: 44, height: 5, borderRadius: 3, backgroundColor: dark ? 'rgba(255,255,255,0.25)' : theme.color.borderStrong, alignSelf: 'center', marginBottom: theme.spacing.md }} />;
}

function RouteMini({ from, to, inverse }: { from: string; to: string; inverse: boolean }) {
  const sub = inverse ? { color: 'rgba(255,255,255,0.85)' } : undefined;
  return (
    <View style={{ flexDirection: 'row' }}>
      <View style={{ width: 20, alignItems: 'center', paddingTop: 4 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 3, borderColor: inverse ? theme.color.surface : theme.color.text }} />
        <View style={{ width: 2, height: 16, backgroundColor: inverse ? 'rgba(255,255,255,0.3)' : theme.color.borderStrong, marginVertical: 3 }} />
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: inverse ? theme.color.surface : theme.color.text }} />
      </View>
      <View style={{ flex: 1, marginLeft: theme.spacing.sm, gap: theme.spacing.md }}>
        <Label variant="body" style={sub} numberOfLines={1}>{from}</Label>
        <Label variant="body" style={sub} numberOfLines={1}>{to}</Label>
      </View>
    </View>
  );
}
