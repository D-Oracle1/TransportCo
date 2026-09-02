'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistance } from '@transportco/utils';

/**
 * Driver assignment panel.
 *
 * Shows the RANKED recommendation with its reasoning, and lets the dispatcher
 * assign anyone — including an ineligible driver's reasons for exclusion, so
 * an empty board is never unexplained.
 *
 * Choosing someone other than the top candidate is a first-class action, not a
 * workaround. The API records it as an override so dispatch quality can be
 * reviewed later against what operations actually chose.
 */

interface Candidate {
  driverId: string;
  fullName: string;
  rating: number | null;
  distanceToPickupMetres: number | null;
  etaToPickupSeconds: number | null;
  score: number;
  eligible: boolean;
  exclusionReasons: string[];
  workload: { score: number; completedTripsToday: number; scheduledTripsNext4h: number };
  vehicle: { plateNumber: string; make: string; model: string } | null;
  factors: Array<{ code: string; label: string; detail: string; contribution: number }>;
}

interface Recommendation {
  candidates: Candidate[];
  recommended: Candidate | null;
}

export function AssignPanel({ tripId, reference }: { tripId: string; reference: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Recommendation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);

  async function load() {
    setOpen(true);
    if (data) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/proxy/admin/dispatch/trips/${tripId}/recommendations`);
      const payload = (await response.json()) as
        | { ok: true; data: Recommendation }
        | { ok: false; error: { message: string } };

      if (!payload.ok) {
        setError(payload.error.message);
        return;
      }
      setData(payload.data);
    } catch {
      setError('Could not load driver recommendations.');
    } finally {
      setLoading(false);
    }
  }

  async function assign(driverId: string, wasRecommended: boolean) {
    setAssigning(driverId);
    setError(null);

    try {
      const response = await fetch(`/api/proxy/admin/dispatch/trips/${tripId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driverId,
          reason: wasRecommended ? 'initial_assignment' : 'admin_override',
        }),
      });

      const payload = (await response.json()) as
        | { ok: true; data: { driverName: string } }
        | { ok: false; error: { message: string } };

      if (!payload.ok) {
        // Most failures here are real and useful: the driver just went offline,
        // or another dispatcher got there first.
        setError(payload.error.message);
        return;
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError('The assignment could not be saved. Check your connection and try again.');
    } finally {
      setAssigning(null);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={load}>
        Assign driver
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink-800">Assign a driver to {reference}</p>
        <button type="button" className="text-sm text-ink-500 hover:text-ink-800" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {loading ? <p className="py-6 text-center text-sm text-ink-500">Scoring drivers…</p> : null}

      {error ? (
        <p role="alert" className="mb-3 rounded-md bg-danger-100 px-3 py-2 text-sm text-danger-700">
          {error}
        </p>
      ) : null}

      {data ? (
        <ul className="space-y-2">
          {data.candidates.map((candidate) => {
            const isRecommended = data.recommended?.driverId === candidate.driverId;

            return (
              <li
                key={candidate.driverId}
                className={`rounded-md border bg-white p-3 ${
                  isRecommended ? 'border-brand-400 ring-1 ring-brand-200' : 'border-ink-200'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                      {candidate.fullName}
                      {isRecommended ? (
                        <span className="badge bg-brand-100 text-brand-700">Recommended</span>
                      ) : null}
                      {!candidate.eligible ? (
                        <span className="badge bg-danger-100 text-danger-700">Unavailable</span>
                      ) : null}
                    </p>

                    <p className="mt-0.5 text-xs text-ink-500">
                      {candidate.distanceToPickupMetres != null
                        ? formatDistance(candidate.distanceToPickupMetres)
                        : 'No recent location'}
                      {candidate.etaToPickupSeconds != null
                        ? ` · ~${Math.round(candidate.etaToPickupSeconds / 60)} min away`
                        : ''}
                      {candidate.vehicle ? ` · ${candidate.vehicle.plateNumber}` : ' · no vehicle'}
                      {candidate.rating != null ? ` · ${candidate.rating.toFixed(1)}★` : ''}
                    </p>

                    {/* The arithmetic, in plain words. A dispatcher who cannot
                        see why will not trust the ranking. */}
                    <p className="mt-1 text-xs text-ink-500">
                      {candidate.factors
                        .filter((factor) => factor.code !== 'vehicle_readiness')
                        .map((factor) => factor.detail)
                        .join(' · ')}
                    </p>

                    {candidate.exclusionReasons.length > 0 ? (
                      <p className="mt-1 text-xs font-medium text-danger-700">
                        {candidate.exclusionReasons.map((reason) => reason.replace(/_/g, ' ')).join(', ')}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular text-sm font-bold text-ink-700">{candidate.score.toFixed(0)}</span>
                    <button
                      type="button"
                      className={isRecommended ? 'btn-primary' : 'btn-ghost'}
                      disabled={assigning !== null || !candidate.eligible}
                      onClick={() => assign(candidate.driverId, isRecommended)}
                    >
                      {assigning === candidate.driverId
                        ? 'Assigning…'
                        : isRecommended
                          ? 'Assign'
                          : 'Assign anyway'}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}

          {data.candidates.length === 0 ? (
            <li className="py-6 text-center text-sm text-ink-500">
              No drivers are on shift. Bring a driver online before assigning this trip.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
