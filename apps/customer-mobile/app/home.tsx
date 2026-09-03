import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutAnimation, Platform, Pressable, ScrollView, UIManager, View } from 'react-native';
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

type Phase = 'choose' | 'quoted' | 'negotiate';
type Editing = 'from' | 'to' | null;

export default function Home() {
  const router = useRouter();
  const { profile } = useSession();

  const [pickup, setPickup] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [active, setActive] = useState<ActiveTrip | null>(null);

  const [editing, setEditing] = useState<Editing>('to');
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
      else { animate(); setEditing('to'); }
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
      else { animate(); setEditing('to'); }
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
      router.push({ pathname: '/trip', params: { id: tripId } });
      resetFlow();
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
      if (t.fareLocked) { router.push({ pathname: '/trip', params: { id: t.id } }); resetFlow(); }
    } catch { /* keep */ }
  }, [trip, router]);
  async function submitOffer() {
    const naira = Number(offer.replace(/[^0-9]/g, ''));
    if (!naira || !trip) return;
    setBusy('offer'); setBanner(null);
    try {
      const r = await api.post<{ outcome: string; message: string }>(`/trips/${trip.id}/negotiate`, { amountMinor: naira * 100 });
      setOffer('');
      if (r.outcome === 'accepted') { router.push({ pathname: '/trip', params: { id: trip.id } }); resetFlow(); return; }
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
      router.push({ pathname: '/trip', params: { id: trip.id } }); resetFlow();
    } catch (e) { setBanner({ message: e instanceof ApiError ? e.message : 'We could not confirm that fare.', tone: 'danger' }); await reloadTrip(); }
    finally { setBusy(null); }
  }
  async function cancelFlow() {
    if (trip) await api.post(`/trips/${trip.id}/cancel`, { reason: 'fare_too_high' }).catch(() => undefined);
    resetFlow();
  }
  function resetFlow() { animate(); setPhase('choose'); setDestination(null); setQuote(null); setTrip(null); setNegotiation(null); setOffer(''); setBanner(null); setEditing('to'); }

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

      {/* active trip pill */}
      {active ? (
        <Pressable onPress={() => router.push({ pathname: '/trip', params: { id: active.id } })} style={{ position: 'absolute', top: 100, left: theme.layout.screenPadding, right: theme.layout.screenPadding, backgroundColor: theme.color.primary, borderRadius: theme.radius.lg, padding: theme.spacing.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', ...theme.shadow.card }}>
          <View style={{ flex: 1 }}>
            <Label variant="caption" tone="inverse">{active.statusLabel}</Label>
            <Label variant="bodyStrong" tone="inverse" numberOfLines={1}>{active.destination.address}</Label>
          </View>
          <Label variant="bodyStrong" tone="inverse">{active.fareLabel}</Label>
        </Pressable>
      ) : null}

      {/* ── COLLAPSIBLE SHEET ────────────────────────────────────────────── */}
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
                        <Label variant="caption" tone={e.party === 'customer' ? 'inverse' : 'muted'}>{e.party === 'customer' ? 'You' : 'TransportCo'}</Label>
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
