/**
 * End-to-end walkthrough of the first vertical slice, against a running API and
 * a real database.
 *
 * Register -> quote -> negotiate (rejected, then reviewed) -> admin counters ->
 * customer accepts -> fare locks -> dispatch recommends -> admin assigns ->
 * driver drives -> cash collected -> customer rates.
 *
 * Run with the API listening on :4000. Not a test suite — a smoke walk that
 * proves the wiring, and prints what the system actually did at each step.
 */
const BASE = 'http://localhost:4000';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, { token, body, idempotencyKey } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await response.json().catch(() => null);
  return { status: response.status, ok: payload?.ok === true, data: payload?.data, error: payload?.error };
}

const naira = (minor) => `NGN ${(minor / 100).toLocaleString('en-NG')}`;

/**
 * Sign-in is rate-limited to 10 attempts per 15 minutes per IP, and one run of
 * this walkthrough uses five. Running it repeatedly WILL hit that limit — which
 * is the limiter working, not a failure. Say so plainly rather than crashing on
 * an undefined token.
 */
function requireAuth(label, response) {
  if (response.ok) return response.data.tokens.accessToken;

  if (response.status === 429) {
    console.log(`
  RATE LIMITED on ${label}: ${response.error?.message ?? ''}`);
    console.log(`  Retry in ~${response.error?.retryAfterSeconds ?? '?'}s. Five sign-ins per run,`);
    console.log('  ten allowed per 15 minutes per IP. This is the limiter working as designed.');
    process.exit(2);
  }

  console.log(`
  ABORT: ${label} failed — ${JSON.stringify(response.error)}`);
  process.exit(1);
}

(async () => {
  const stamp = Date.now().toString().slice(-7);
  const phone = `080${stamp}1`.slice(0, 11);

  console.log('\n=== 1. CUSTOMER REGISTRATION ===');
  const registration = await call('POST', '/auth/register', {
    body: { fullName: 'Ada Test', phone, password: 'Passw0rd1', email: `ada${stamp}@example.com` },
  });
  if (!registration.ok) requireAuth('customer registration', registration);
  check('register returns 201', registration.status === 201);
  check('development OTP returned', typeof registration.data?.devOtp === 'string');

  const verification = await call('POST', '/auth/verify-otp', {
    body: { phone, code: registration.data.devOtp, purpose: 'phone_verification' },
  });
  if (!verification.ok) requireAuth('OTP verification', verification);
  check('OTP verification returns a session', Boolean(verification.data.session));
  const customerToken = verification.data.session.tokens.accessToken;

  console.log('\n=== 2. FARE QUOTE (server-computed) ===');
  const quote = await call('POST', '/trips/estimate', {
    token: customerToken,
    body: {
      pickup: { latitude: 4.8156, longitude: 7.0498, address: 'Rumuola, Port Harcourt' },
      destination: { latitude: 4.8087, longitude: 7.0134, address: 'GRA Phase 2, Port Harcourt' },
      passengers: 1,
    },
  });
  check('quote created', quote.ok, quote.ok ? naira(quote.data.fareMinor) : JSON.stringify(quote.error));

  const quoteJson = JSON.stringify(quote.data);
  check('quote does NOT leak the floor', !quoteJson.includes('floor'), 'no floorMinor in customer payload');
  check('quote does NOT leak the auto-accept threshold', !quoteJson.includes('autoAccept'));
  check('breakdown is itemised', Array.isArray(quote.data.breakdown) && quote.data.breakdown.length >= 3);

  const quotedFare = quote.data.fareMinor;

  console.log('\n=== 3. TRIP CREATION ===');
  const trip = await call('POST', '/trips', {
    token: customerToken,
    idempotencyKey: `slice-${stamp}`,
    body: { quoteId: quote.data.quoteId, paymentMethod: 'cash' },
  });
  check('trip created', trip.status === 201, trip.ok ? trip.data.reference : JSON.stringify(trip.error));
  const tripId = trip.data.tripId;

  const replay = await call('POST', '/trips', {
    token: customerToken,
    idempotencyKey: `slice-${stamp}`,
    body: { quoteId: quote.data.quoteId, paymentMethod: 'cash' },
  });
  check('idempotent retry replays, does not duplicate', replay.data?.tripId === tripId);

  console.log('\n=== 4. NEGOTIATION ===');
  const lowball = await call('POST', `/trips/${tripId}/negotiate`, {
    token: customerToken,
    body: { amountMinor: Math.round(quotedFare * 0.5) },
  });
  check('offer below the floor is auto-rejected', lowball.data?.outcome === 'rejected', lowball.data?.message);
  check('rejection message hides the floor', !/(floor|minimum acceptable)/i.test(lowball.data?.message ?? ''));

  const midband = await call('POST', `/trips/${tripId}/negotiate`, {
    token: customerToken,
    body: { amountMinor: Math.round(quotedFare * 0.88) },
  });
  check('mid-band offer goes to a human', midband.data?.outcome === 'under_review', midband.data?.message);
  check('offers remaining is reported', midband.data?.offersRemaining === 0);

  const customerView = await call('GET', `/trips/${tripId}/negotiation`, { token: customerToken });
  check(
    'customer negotiation view omits internal thresholds',
    customerView.data.floorMinor === undefined && customerView.data.autoAcceptAtOrAboveMinor === undefined,
  );

  console.log('\n=== 5. ADMIN COUNTERS ===');
  const dispatcher = await call('POST', '/auth/login', {
    body: { identifier: 'chidi@transportco.example', password: 'TransportCo123' },
  });
  const dispatcherToken = requireAuth('dispatcher sign-in', dispatcher);
  check('dispatcher signs in', dispatcher.ok);

  const queue = await call('GET', '/admin/negotiations/queue', { token: dispatcherToken });
  const queued = queue.data?.find((item) => item.tripId === tripId);
  check('offer appears in the review queue', Boolean(queued), queued ? `${queued.discountPercent}% off` : '');
  check('admin DOES see the floor', typeof queued?.floorMinor === 'number', queued ? naira(queued.floorMinor) : '');

  const counterAmount = Math.round((quotedFare * 0.88 + quotedFare) / 2 / 100) * 100;
  const counter = await call('POST', `/admin/negotiations/${queued.negotiationId}/respond`, {
    token: dispatcherToken,
    body: { action: 'counter', counterAmountMinor: counterAmount, note: 'Meeting the customer part-way' },
  });
  check('admin counteroffer accepted', counter.ok, counter.ok ? naira(counter.data.counterAmountMinor) : JSON.stringify(counter.error));

  const belowFloor = await call('POST', `/admin/negotiations/${queued.negotiationId}/respond`, {
    token: dispatcherToken,
    body: { action: 'counter', counterAmountMinor: Math.round(quotedFare * 0.4) },
  });
  check(
    'below-floor counter refused without override',
    !belowFloor.ok && belowFloor.error?.code === 'validation_failed',
    belowFloor.error?.message,
  );

  console.log('\n=== 6. CUSTOMER ACCEPTS — FARE LOCKS ===');
  const view = await call('GET', `/trips/${tripId}/negotiation`, { token: customerToken });
  check('customer sees the counteroffer', view.data.pendingOffer?.amountMinor === counterAmount);
  check('countdown is server-provided', typeof view.data.pendingOffer?.expiresInSeconds === 'number',
    `${view.data.pendingOffer?.expiresInSeconds}s left`);

  const accept = await call('POST', `/trips/${tripId}/accept-fare`, {
    token: customerToken,
    body: { offerId: view.data.pendingOffer.id },
  });
  check('fare accepted and locked', accept.ok && accept.data.status === 'FARE_LOCKED', accept.ok ? accept.data.finalFareLabel : JSON.stringify(accept.error));

  const afterLock = await call('POST', `/trips/${tripId}/negotiate`, {
    token: customerToken,
    body: { amountMinor: 100000 },
  });
  check('no further negotiation once locked', !afterLock.ok, afterLock.error?.code);

  console.log('\n=== 7. DRIVER GOES ONLINE ===');
  const driver = await call('POST', '/auth/login', {
    body: { identifier: '+2348040000001', password: 'TransportCo123' },
  });
  const driverToken = requireAuth('driver sign-in', driver);
  check('driver signs in', driver.ok);

  const online = await call('POST', '/drivers/me/state', { token: driverToken, body: { state: 'AVAILABLE' } });
  check('driver goes online', online.ok && online.data.state === 'AVAILABLE');

  const ping = await call('POST', '/drivers/me/location', {
    token: driverToken,
    body: { latitude: 4.8200, longitude: 7.0450, recordedAt: new Date().toISOString() },
  });
  check('location ping accepted', ping.ok && ping.data.accepted === 1);

  console.log('\n=== 8. DISPATCH ===');
  const board = await call('GET', '/admin/dispatch/board', { token: dispatcherToken });
  const onBoard = board.data?.find((item) => item.tripId === tripId);
  check('trip appears on the dispatch board', Boolean(onBoard));

  const recommendations = await call('GET', `/admin/dispatch/trips/${tripId}/recommendations`, { token: dispatcherToken });
  const recommended = recommendations.data?.recommended;
  check('a driver is recommended', Boolean(recommended), recommended ? `${recommended.fullName} score ${recommended.score}` : 'none');
  check('recommendation explains itself', (recommended?.factors ?? []).length === 5,
    (recommended?.factors ?? []).map((f) => f.detail).join(' | '));

  const assign = await call('POST', `/admin/dispatch/trips/${tripId}/assign`, {
    token: dispatcherToken,
    body: { driverId: recommended.driverId, reason: 'initial_assignment' },
  });
  check('driver assigned', assign.ok, assign.ok ? assign.data.driverName : JSON.stringify(assign.error));

  console.log('\n=== 9. THE DRIVE ===');
  for (const [action, expected] of [
    ['start_pickup', 'DRIVER_EN_ROUTE'],
    ['arrived', 'DRIVER_ARRIVED'],
    ['start_trip', 'TRIP_STARTED'],
    ['complete_trip', 'TRIP_COMPLETED'],
  ]) {
    const result = await call('POST', `/drivers/me/trips/${tripId}/actions`, {
      token: driverToken,
      // Arrival is location-verified: send the pickup point.
      body: { action, latitude: 4.8156, longitude: 7.0498 },
    });
    check(`driver: ${action}`, result.ok && result.data.status === expected,
      result.ok ? result.data.status : JSON.stringify(result.error));
  }

  const driverTrip = await call('GET', `/drivers/me/trips/${tripId}`, { token: driverToken });
  const driverJson = JSON.stringify(driverTrip.data);
  check('driver payload has no negotiation data', !driverJson.includes('negotiation'));
  check('driver payload has no quoted fare', !driverJson.includes('quotedFare'));
  check('driver sees a masked customer phone', /\*\*\*\*/.test(driverTrip.data.customerMaskedPhone ?? ''),
    driverTrip.data.customerMaskedPhone);

  console.log('\n=== 10. CASH ===');
  const wrongAmount = await call('POST', `/drivers/me/trips/${tripId}/cash`, {
    token: driverToken,
    body: { amountMinor: 100000 },
  });
  check('cash below the locked fare is refused', !wrongAmount.ok, wrongAmount.error?.message);

  const cash = await call('POST', `/drivers/me/trips/${tripId}/cash`, {
    token: driverToken,
    body: { amountMinor: accept.data.finalFareMinor },
  });
  check('correct cash amount recorded', cash.ok, cash.ok ? 'payment settled' : JSON.stringify(cash.error));

  console.log('\n=== 11. RATING & LOYALTY ===');
  const afterPayment = await call('GET', `/trips/${tripId}`, { token: customerToken });
  check('trip moved to REVIEW_PENDING', afterPayment.data.status === 'REVIEW_PENDING', afterPayment.data.status);
  check('trip marked paid', afterPayment.data.paymentStatus === 'paid');

  const review = await call('POST', `/trips/${tripId}/review`, {
    token: customerToken,
    body: { driverRating: 5, comment: 'Smooth trip' },
  });
  check('rating recorded', review.ok);

  const finalTrip = await call('GET', `/trips/${tripId}`, { token: customerToken });
  check('trip COMPLETED', finalTrip.data.status === 'COMPLETED', finalTrip.data.statusLabel);

  const loyalty = await call('GET', '/customer/me/loyalty', { token: customerToken });
  const expectedPoints = Math.floor(accept.data.finalFareMinor / 100000) * 10;
  check('loyalty points awarded on the PAID fare', loyalty.data.balancePoints === expectedPoints,
    `${loyalty.data.balancePoints} points for ${naira(accept.data.finalFareMinor)}`);

  console.log('\n=== 12. AUTHORISATION BOUNDARIES ===');
  const dispatcherPayroll = await call('GET', '/admin/payroll/periods', { token: dispatcherToken });
  check('dispatcher cannot read payroll', dispatcherPayroll.status === 403, dispatcherPayroll.error?.code);

  const customerAdmin = await call('GET', '/admin/dashboard', { token: customerToken });
  check('customer cannot reach the admin API', customerAdmin.status === 403);

  const driverNegotiation = await call('GET', `/admin/negotiations/${queued.negotiationId}`, { token: driverToken });
  check('driver cannot read a negotiation', driverNegotiation.status === 403);

  const otherCustomer = await call('GET', '/trips/00000000-0000-4000-8000-000000000000', { token: customerToken });
  check('unknown/foreign trip is not found', otherCustomer.status === 404);

  console.log('\n=== 13. AUDIT TRAIL ===');
  const superAdmin = await call('POST', '/auth/login', {
    body: { identifier: 'amaka@transportco.example', password: 'TransportCo123' },
  });
  const superAdminToken = requireAuth('super admin sign-in', superAdmin);
  const audit = await call('GET', `/admin/audit-logs?pageSize=50`, { token: superAdminToken });
  const actions = (audit.data?.items ?? []).map((row) => row.action);
  check('fare lock audited', actions.includes('fare.locked'));
  check('driver assignment audited', actions.includes('trip.driver_assigned'));
  check('negotiation response audited', actions.includes('negotiation.responded'));

  console.log(`\n${'='.repeat(46)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(46));
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('\nWALKTHROUGH CRASHED:', error);
  process.exit(1);
});
