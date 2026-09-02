import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatDistance, formatDuration, formatMoney } from '@transportco/utils';
import { tryGet } from '@/lib/api';
import { AssignPanel } from '@/components/AssignPanel';
import { Card, EmptyState, Money, PageHeader, StatusBadge, TimeAgo } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface TripDetail {
  trip: {
    id: string;
    reference: string;
    status: string;
    type: string;
    customer_name: string;
    customer_phone: string;
    customer_reference: string;
    driver_name: string | null;
    plate_number: string | null;
    make: string | null;
    model: string | null;
    pickup_address: string;
    destination_address: string;
    passengers: number;
    special_instructions: string | null;
    distance_metres: number;
    duration_seconds: number;
    quoted_fare_minor: number;
    final_fare_minor: number | null;
    fare_locked_at: string | null;
    payment_status: string;
    payment_method: string | null;
    scheduled_pickup_at: string | null;
    created_at: string;
    cancellation_reason: string | null;
    cancellation_fee_minor: number | null;
  };
  history: Array<{
    from_status: string | null;
    to_status: string;
    actor_type: string;
    actor_name: string | null;
    reason: string | null;
    created_at: string;
  }>;
  negotiation: {
    negotiationId: string;
    status: string;
    originalFareMinor: number;
    companyPositionMinor: number;
    customerPositionMinor: number | null;
    finalFareMinor: number | null;
    roundsUsed: number;
    maxRounds: number;
    floorMinor?: number;
    timeline: Array<{ id: string; party: string; amountMinor: number; status: string; createdAt: string }>;
  } | null;
  payments: Array<{
    id: string;
    reference: string;
    method: string;
    provider: string;
    amount_minor: number;
    status: string;
    paid_at: string | null;
  }>;
  assignments: Array<{
    id: string;
    driver_name: string;
    reason: string;
    was_override: boolean;
    recommendation_score: number | null;
    active: boolean;
    created_at: string;
    released_at: string | null;
  }>;
}

/**
 * The full operational record of one trip.
 *
 * This is the page a support agent opens when a customer calls, so everything
 * that answers "what actually happened" is here: state history with actors,
 * the negotiation, every assignment including overrides, and every payment
 * attempt.
 */
export default async function TripDetailPage({ params }: { params: { id: string } }) {
  const detail = await tryGet<TripDetail | null>(`/admin/trips/${params.id}`, null);
  if (!detail.data) notFound();

  const { trip, history, negotiation, payments, assignments } = detail.data;
  const needsDriver = ['FARE_LOCKED', 'DRIVER_UNAVAILABLE', 'REASSIGNED'].includes(trip.status);

  return (
    <>
      <PageHeader
        title={trip.reference}
        subtitle={`${trip.customer_name} · ${trip.customer_reference}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={trip.status} />
            <Link href="/trips" className="btn-ghost">All trips</Link>
          </div>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <Card title="Trip">
            <dl className="grid gap-4 p-5 sm:grid-cols-2">
              <div>
                <dt className="stat-label">Pickup</dt>
                <dd className="text-sm text-ink-800">{trip.pickup_address}</dd>
              </div>
              <div>
                <dt className="stat-label">Destination</dt>
                <dd className="text-sm text-ink-800">{trip.destination_address}</dd>
              </div>
              <div>
                <dt className="stat-label">Distance / time</dt>
                <dd className="text-sm text-ink-800">
                  {formatDistance(trip.distance_metres)} · {formatDuration(trip.duration_seconds)}
                </dd>
              </div>
              <div>
                <dt className="stat-label">Passengers</dt>
                <dd className="text-sm text-ink-800">{trip.passengers}</dd>
              </div>
              <div>
                <dt className="stat-label">Customer contact</dt>
                <dd className="tabular text-sm text-ink-800">{trip.customer_phone}</dd>
              </div>
              <div>
                <dt className="stat-label">Driver</dt>
                <dd className="text-sm text-ink-800">
                  {trip.driver_name ?? <span className="text-ink-400">Unassigned</span>}
                  {trip.plate_number ? (
                    <span className="text-ink-500">
                      {' '}· {trip.make} {trip.model} ({trip.plate_number})
                    </span>
                  ) : null}
                </dd>
              </div>
              {trip.scheduled_pickup_at ? (
                <div>
                  <dt className="stat-label">Scheduled pickup</dt>
                  <dd className="text-sm text-ink-800">
                    {new Date(trip.scheduled_pickup_at).toLocaleString('en-NG')}
                  </dd>
                </div>
              ) : null}
              {trip.special_instructions ? (
                <div className="sm:col-span-2">
                  <dt className="stat-label">Instructions from the customer</dt>
                  <dd className="text-sm text-ink-800">{trip.special_instructions}</dd>
                </div>
              ) : null}
              {trip.cancellation_reason ? (
                <div className="sm:col-span-2">
                  <dt className="stat-label">Cancellation</dt>
                  <dd className="text-sm text-danger-700">
                    {trip.cancellation_reason.replace(/_/g, ' ')}
                    {trip.cancellation_fee_minor
                      ? ` · fee ${formatMoney(trip.cancellation_fee_minor)}`
                      : ' · no fee'}
                  </dd>
                </div>
              ) : null}
            </dl>

            {needsDriver ? (
              <div className="border-t border-ink-100 px-5 py-4">
                <AssignPanel tripId={trip.id} reference={trip.reference} />
              </div>
            ) : null}
          </Card>

          {negotiation ? (
            <Card
              title="Negotiation"
              action={
                <Link
                  href={`/negotiations/${negotiation.negotiationId}`}
                  className="text-sm font-semibold text-brand-600 hover:underline"
                >
                  Open console
                </Link>
              }
            >
              <div className="grid gap-4 border-b border-ink-100 p-5 sm:grid-cols-4">
                <div>
                  <p className="stat-label">System fare</p>
                  <Money minor={negotiation.originalFareMinor} />
                </div>
                <div>
                  <p className="stat-label">Final fare</p>
                  <Money minor={negotiation.finalFareMinor} />
                </div>
                <div>
                  <p className="stat-label">Rounds used</p>
                  <p className="tabular text-sm font-semibold">
                    {negotiation.roundsUsed}/{negotiation.maxRounds}
                  </p>
                </div>
                <div>
                  <p className="stat-label">Outcome</p>
                  <StatusBadge status={negotiation.status} />
                </div>
              </div>

              <ol className="divide-y divide-ink-100">
                {negotiation.timeline.map((offer) => (
                  <li key={offer.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                    <span className="text-ink-600">
                      {offer.party === 'customer' ? 'Customer offered' : 'TransportCo offered'}
                    </span>
                    <span className="flex items-center gap-3">
                      <Money minor={offer.amountMinor} />
                      <span className="text-xs text-ink-500">{offer.status}</span>
                      <TimeAgo at={offer.createdAt} />
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}

          <Card title="Assignment history">
            {assignments.length === 0 ? (
              <EmptyState title="No driver has been assigned yet" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {assignments.map((assignment) => (
                  <li key={assignment.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <div>
                      <p className="font-medium text-ink-800">
                        {assignment.driver_name}
                        {assignment.active ? (
                          <span className="badge ml-2 bg-success-100 text-success-700">Active</span>
                        ) : null}
                        {assignment.was_override ? (
                          <span className="badge ml-2 bg-warning-100 text-warning-700">Override</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-ink-500">
                        {assignment.reason.replace(/_/g, ' ')}
                        {assignment.recommendation_score != null
                          ? ` · score ${Number(assignment.recommendation_score).toFixed(0)}`
                          : ''}
                      </p>
                    </div>
                    <TimeAgo at={assignment.created_at} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Fare">
            <div className="space-y-3 p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-500">Quoted</span>
                <Money minor={trip.quoted_fare_minor} className="text-ink-600" />
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-500">Agreed</span>
                <Money minor={trip.final_fare_minor} className="text-lg" />
              </div>
              <div className="flex items-baseline justify-between border-t border-ink-100 pt-3">
                <span className="text-sm text-ink-500">Fare locked</span>
                <span className="text-sm font-medium text-ink-800">
                  {trip.fare_locked_at ? new Date(trip.fare_locked_at).toLocaleString('en-NG') : 'Not yet'}
                </span>
              </div>
              <p className="text-xs text-ink-500">
                A locked fare cannot be changed by the driver, the customer, or an ordinary admin action.
              </p>
            </div>
          </Card>

          <Card title="Payments">
            {payments.length === 0 ? (
              <EmptyState title="No payment attempts yet" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {payments.map((payment) => (
                  <li key={payment.id} className="px-5 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-ink-800">{payment.reference}</span>
                      <Money minor={payment.amount_minor} />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-ink-500">
                      <span>
                        {payment.method.replace('_', ' ')} · {payment.provider}
                      </span>
                      <StatusBadge status={payment.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="State history">
            <ol className="divide-y divide-ink-100">
              {history.map((entry, index) => (
                <li key={`${entry.to_status}-${index}`} className="px-5 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status={entry.to_status} />
                    <TimeAgo at={entry.created_at} />
                  </div>
                  <p className="mt-1 text-xs text-ink-500">
                    by {entry.actor_name ?? entry.actor_type}
                    {entry.reason ? ` — ${entry.reason}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
