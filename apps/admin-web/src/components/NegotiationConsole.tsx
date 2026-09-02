'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatMoney, humanizeCountdown } from '@transportco/utils';

/**
 * The negotiation workspace.
 *
 * Everything a dispatcher needs to make one decision, on one screen: the
 * company's fare, the customer's offer, the internal floor, how many rounds the
 * customer has left, and a live countdown to expiry.
 *
 * The countdown is DISPLAY ONLY. Expiry is decided by the server; when it runs
 * out here the controls disable and the operator is told to refresh rather than
 * being allowed to act on a dead offer.
 */

interface Offer {
  id: string;
  sequence: number;
  party: 'customer' | 'company';
  actorName: string | null;
  amountMinor: number;
  message: string | null;
  status: string;
  createdAt: string;
}

export interface NegotiationDetail {
  negotiationId: string;
  tripId: string;
  status: string;
  originalFareMinor: number;
  companyPositionMinor: number;
  customerPositionMinor: number | null;
  finalFareMinor: number | null;
  roundsUsed: number;
  maxRounds: number;
  offersRemaining: number;
  floorMinor?: number;
  autoAcceptAtOrAboveMinor?: number;
  maxDiscountPercent?: number;
  pendingOffer: { id: string; party: string; amountMinor: number; expiresAt: string; expiresInSeconds: number } | null;
  timeline: Offer[];
}

export function NegotiationConsole({
  detail,
  canOverrideFloor,
  tripReference,
}: {
  detail: NegotiationDetail;
  canOverrideFloor: boolean;
  tripReference: string;
}) {
  const router = useRouter();
  const [counter, setCounter] = useState(
    detail.customerPositionMinor
      ? String(
          Math.round(
            (detail.companyPositionMinor + detail.customerPositionMinor) / 2 / 100,
          ),
        )
      : '',
  );
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(detail.pendingOffer?.expiresInSeconds ?? 0);

  useEffect(() => {
    if (!detail.pendingOffer) return;

    const timer = setInterval(() => {
      const seconds = Math.max(
        0,
        Math.floor((new Date(detail.pendingOffer!.expiresAt).getTime() - Date.now()) / 1000),
      );
      setRemaining(seconds);
    }, 1000);

    return () => clearInterval(timer);
  }, [detail.pendingOffer]);

  const expired = detail.pendingOffer !== null && remaining <= 0;
  const closed = ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'].includes(detail.status);

  const counterMinor = Math.round(Number(counter || 0) * 100);
  const belowFloor = detail.floorMinor != null && counterMinor > 0 && counterMinor < detail.floorMinor;

  async function respond(action: 'accept' | 'reject' | 'counter') {
    setBusy(action);
    setError(null);

    try {
      const response = await fetch(`/api/proxy/admin/negotiations/${detail.negotiationId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'counter' ? { counterAmountMinor: counterMinor } : {}),
          overrideFloor: action === 'counter' ? override : false,
          ...(note ? { note } : {}),
        }),
      });

      const payload = (await response.json()) as
        | { ok: true; data: unknown }
        | { ok: false; error: { message: string } };

      if (!payload.ok) {
        setError(payload.error.message);
        return;
      }

      router.refresh();
    } catch {
      setError('That could not be saved. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  const discount =
    detail.customerPositionMinor != null
      ? Math.round(
          ((detail.originalFareMinor - detail.customerPositionMinor) / detail.originalFareMinor) * 1000,
        ) / 10
      : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="card">
        <header className="card-header">
          <h2 className="card-title">Negotiation timeline — {tripReference}</h2>
          {detail.pendingOffer && !closed ? (
            <span
              className={`badge tabular ${
                remaining < 60 ? 'bg-danger-100 text-danger-700' : 'bg-accent-100 text-accent-700'
              }`}
            >
              {expired ? 'Offer expired' : `Expires in ${humanizeCountdown(remaining)}`}
            </span>
          ) : null}
        </header>

        <ol className="space-y-3 p-5">
          {detail.timeline.map((offer) => (
            <li
              key={offer.id}
              className={`flex ${offer.party === 'customer' ? 'justify-start' : 'justify-end'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-3 ${
                  offer.party === 'customer'
                    ? 'bg-ink-100 text-ink-800'
                    : 'bg-brand-500 text-white'
                }`}
              >
                <p className="text-xs opacity-80">
                  {offer.party === 'customer' ? 'Customer' : (offer.actorName ?? 'TransportCo')} ·{' '}
                  {new Date(offer.createdAt).toLocaleTimeString('en-NG', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
                <p className="tabular text-lg font-bold">{formatMoney(offer.amountMinor)}</p>
                {offer.message ? <p className="mt-1 text-sm opacity-90">{offer.message}</p> : null}
                <p className="mt-1 text-[11px] uppercase tracking-wide opacity-70">{offer.status}</p>
              </div>
            </li>
          ))}

          {detail.timeline.length === 0 ? (
            <li className="py-8 text-center text-sm text-ink-500">
              The customer has not made an offer yet.
            </li>
          ) : null}
        </ol>
      </div>

      <div className="space-y-5">
        <div className="card p-5">
          <dl className="space-y-3 text-sm">
            <div className="flex items-baseline justify-between">
              <dt className="text-ink-500">System fare</dt>
              <dd className="tabular font-semibold text-ink-900">
                {formatMoney(detail.originalFareMinor)}
              </dd>
            </div>

            <div className="flex items-baseline justify-between">
              <dt className="text-ink-500">Customer offer</dt>
              <dd className="tabular font-semibold text-accent-700">
                {detail.customerPositionMinor != null
                  ? `${formatMoney(detail.customerPositionMinor)}${discount != null ? ` (−${discount}%)` : ''}`
                  : '—'}
              </dd>
            </div>

            <div className="flex items-baseline justify-between">
              <dt className="text-ink-500">Our position</dt>
              <dd className="tabular font-semibold text-brand-700">
                {formatMoney(detail.companyPositionMinor)}
              </dd>
            </div>

            {/* Internal only. This value is never sent to a customer response. */}
            {detail.floorMinor != null ? (
              <div className="flex items-baseline justify-between border-t border-ink-100 pt-3">
                <dt className="text-ink-500">
                  Minimum acceptable
                  <span className="ml-1 text-[11px] uppercase tracking-wide text-danger-700">internal</span>
                </dt>
                <dd className="tabular font-semibold text-ink-900">{formatMoney(detail.floorMinor)}</dd>
              </div>
            ) : null}

            <div className="flex items-baseline justify-between">
              <dt className="text-ink-500">Customer rounds</dt>
              <dd className="tabular font-semibold text-ink-900">
                {detail.roundsUsed}/{detail.maxRounds}
              </dd>
            </div>
          </dl>
        </div>

        {closed ? (
          <div className="card p-5">
            <p className="text-sm font-semibold text-ink-800">
              {detail.status === 'ACCEPTED'
                ? `Agreed at ${formatMoney(detail.finalFareMinor ?? 0)}`
                : `This negotiation is ${detail.status.toLowerCase()}.`}
            </p>
          </div>
        ) : (
          <div className="card space-y-4 p-5">
            <p className="text-sm font-semibold text-ink-800">Respond</p>

            {error ? (
              <p role="alert" className="rounded-md bg-danger-100 px-3 py-2 text-sm text-danger-700">
                {error}
              </p>
            ) : null}

            {expired ? (
              <p className="rounded-md bg-warning-100 px-3 py-2 text-sm text-warning-700">
                This offer has expired. Refresh to see the current state.
              </p>
            ) : null}

            <div>
              <label className="label" htmlFor="counter">
                Counteroffer (₦)
              </label>
              <input
                id="counter"
                className="input tabular"
                inputMode="numeric"
                value={counter}
                onChange={(event) => setCounter(event.target.value.replace(/[^\d]/g, ''))}
                placeholder="7400"
              />
              {belowFloor ? (
                <p className="mt-1.5 text-xs font-medium text-danger-700">
                  Below the minimum acceptable fare. This needs an explicit override and will be audited.
                </p>
              ) : null}
            </div>

            <div>
              <label className="label" htmlFor="note">
                Note (recorded)
              </label>
              <input
                id="note"
                className="input"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Regular corporate customer"
              />
            </div>

            {belowFloor && canOverrideFloor ? (
              <label className="flex items-start gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={override}
                  onChange={(event) => setOverride(event.target.checked)}
                />
                <span>
                  Override the minimum fare for this trip. This is recorded against my name in the audit log.
                </span>
              </label>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary flex-1"
                disabled={busy !== null || expired || counterMinor <= 0 || (belowFloor && !override)}
                onClick={() => respond('counter')}
              >
                {busy === 'counter' ? 'Sending…' : 'Send counteroffer'}
              </button>

              <button
                type="button"
                className="btn-accent"
                disabled={busy !== null || expired || detail.customerPositionMinor == null}
                onClick={() => respond('accept')}
              >
                {busy === 'accept' ? 'Accepting…' : 'Accept offer'}
              </button>

              <button
                type="button"
                className="btn-ghost"
                disabled={busy !== null || expired}
                onClick={() => respond('reject')}
              >
                {busy === 'reject' ? 'Rejecting…' : 'Reject'}
              </button>
            </div>

            <p className="text-xs text-ink-500">
              Company counteroffers are not limited by the customer&apos;s round cap.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
