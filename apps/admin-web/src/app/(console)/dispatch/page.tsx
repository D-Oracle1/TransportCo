import Link from 'next/link';
import { tryGet } from '@/lib/api';
import { AssignPanel } from '@/components/AssignPanel';
import { Card, EmptyState, ErrorState, Money, PageHeader, StatusBadge, WorkloadPill } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface BoardItem {
  tripId: string;
  reference: string;
  status: string;
  customerName: string;
  pickupAddress: string;
  destinationAddress: string;
  fareMinor: number;
  scheduledPickupAt: string | null;
  waitingSeconds: number;
  recommended: { driverId: string; name: string; distanceLabel: string; score: number; workload: string } | null;
}

interface LiveDriver {
  driver_id: string;
  full_name: string;
  state: string;
  rating: number | null;
  plate_number: string | null;
  trip_reference: string | null;
  last_location_at: string | null;
}

/**
 * Dispatch board.
 *
 * Two columns of the same problem: work that needs a driver on the left, the
 * drivers themselves on the right. A dispatcher should be able to clear the
 * left column without navigating anywhere.
 */
export default async function DispatchPage() {
  const [board, live] = await Promise.all([
    tryGet<BoardItem[]>('/admin/dispatch/board', []),
    tryGet<{ drivers: LiveDriver[] }>('/admin/live', { drivers: [] }),
  ]);

  const drivers = live.data.drivers ?? [];

  return (
    <>
      <PageHeader
        title="Dispatch"
        subtitle="Assign company drivers to locked fares. The system recommends; you decide."
      />

      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <Card title={`Unassigned trips (${board.data.length})`}>
          {board.error ? (
            <ErrorState message={board.error} />
          ) : board.data.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              hint="Every locked fare has a driver. New requests will appear here automatically."
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {board.data.map((trip) => (
                <li key={trip.tripId} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/trips/${trip.tripId}`}
                          className="font-semibold text-brand-600 hover:underline"
                        >
                          {trip.reference}
                        </Link>
                        <StatusBadge status={trip.status} />
                        {trip.scheduledPickupAt ? (
                          <span className="badge bg-info-100 text-info-700">
                            Scheduled{' '}
                            {new Date(trip.scheduledPickupAt).toLocaleString('en-NG', {
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        ) : null}
                      </div>

                      <p className="mt-1.5 text-sm text-ink-700">
                        <span className="font-medium">{trip.customerName}</span>
                        <span className="text-ink-400"> · </span>
                        {trip.pickupAddress}
                        <span className="text-ink-400"> → </span>
                        {trip.destinationAddress}
                      </p>

                      <p className="mt-1 text-xs text-ink-500">
                        Waiting {Math.round(trip.waitingSeconds / 60)} min
                        {trip.recommended
                          ? ` · Recommended: ${trip.recommended.name} (${trip.recommended.distanceLabel}, ${trip.recommended.workload.toLowerCase()} workload)`
                          : ' · No eligible driver'}
                      </p>
                    </div>

                    <Money minor={trip.fareMinor} className="text-lg" />
                  </div>

                  <AssignPanel tripId={trip.tripId} reference={trip.reference} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Drivers on shift">
          {live.error ? (
            <ErrorState message={live.error} />
          ) : drivers.length === 0 ? (
            <EmptyState title="No drivers online" hint="Drivers appear here once they go online in the app." />
          ) : (
            <ul className="divide-y divide-ink-100">
              {drivers.map((driver) => (
                <li key={driver.driver_id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/drivers/${driver.driver_id}`}
                      className="truncate text-sm font-semibold text-ink-800 hover:text-brand-600"
                    >
                      {driver.full_name}
                    </Link>
                    <p className="text-xs text-ink-500">
                      {driver.plate_number ?? 'No vehicle'}
                      {driver.trip_reference ? ` · on ${driver.trip_reference}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={driver.state} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
