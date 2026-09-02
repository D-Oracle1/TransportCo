import Link from 'next/link';
import { formatMoney } from '@transportco/utils';
import { tryGet } from '@/lib/api';
import { Card, EmptyState, ErrorState, Money, PageHeader, Stat, StatusBadge, TimeAgo } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface DashboardStats {
  activeTrips: number;
  pendingNegotiations: number;
  unassignedTrips: number;
  scheduledTrips: number;
  drivers: { available: number; busy: number; offline: number };
  completedToday: number;
  cancelledToday: number;
  revenueTodayMinor: number;
  outstandingTotalMinor: number;
  openTickets: number;
  openIncidents: number;
  openFraudSignals: number;
}

interface BoardItem {
  tripId: string;
  reference: string;
  customerName: string;
  pickupAddress: string;
  fareMinor: number;
  waitingSeconds: number;
  recommended: { name: string; distanceLabel: string; workload: string } | null;
}

interface QueueItem {
  negotiationId: string;
  tripReference: string;
  customerName: string;
  originalFareMinor: number;
  customerOfferMinor: number;
  discountPercent: number;
  roundsUsed: number;
  maxRounds: number;
  expiresAt: string;
}

/**
 * Operations home.
 *
 * Ordered by what needs a human RIGHT NOW — offers waiting on a decision, trips
 * with no driver, open incidents — and only then by the numbers management
 * cares about. Deliberately no charts: the brief asks not to bury the operator
 * in graphs, and at four vehicles a chart of four data points tells nobody
 * anything.
 */
export default async function DashboardPage() {
  const [stats, board, queue] = await Promise.all([
    tryGet<DashboardStats | null>('/admin/dashboard', null),
    tryGet<BoardItem[]>('/admin/dispatch/board', []),
    tryGet<QueueItem[]>('/admin/negotiations/queue', []),
  ]);

  const s = stats.data;

  return (
    <>
      <PageHeader title="Operations" subtitle="Live view of the Rivers State fleet" />

      {stats.error ? (
        <Card className="mb-6">
          <ErrorState message={stats.error} />
        </Card>
      ) : (
        <>
          {/* Attention first. These three are the ones that cost money or trust
              when they sit unattended. */}
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Offers awaiting decision"
              value={s?.pendingNegotiations ?? 0}
              tone={(s?.pendingNegotiations ?? 0) > 0 ? 'warning' : 'default'}
              hint="Customers waiting on a reply"
            />
            <Stat
              label="Trips without a driver"
              value={s?.unassignedTrips ?? 0}
              tone={(s?.unassignedTrips ?? 0) > 0 ? 'danger' : 'default'}
              hint="Fare locked, nobody assigned"
            />
            <Stat
              label="Open incidents"
              value={s?.openIncidents ?? 0}
              tone={(s?.openIncidents ?? 0) > 0 ? 'danger' : 'default'}
              hint="SOS and safety reports"
            />
            <Stat label="Active trips" value={s?.activeTrips ?? 0} hint="On the road now" />
          </div>

          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Revenue today"
              value={formatMoney(s?.revenueTodayMinor ?? 0)}
              hint={`${s?.completedToday ?? 0} completed, ${s?.cancelledToday ?? 0} cancelled`}
            />
            <Stat
              label="Drivers available"
              value={`${s?.drivers.available ?? 0} / ${
                (s?.drivers.available ?? 0) + (s?.drivers.busy ?? 0) + (s?.drivers.offline ?? 0)
              }`}
              hint={`${s?.drivers.busy ?? 0} on a trip, ${s?.drivers.offline ?? 0} offline`}
            />
            <Stat
              label="Outstanding balances"
              value={formatMoney(s?.outstandingTotalMinor ?? 0)}
              tone={(s?.outstandingTotalMinor ?? 0) > 0 ? 'warning' : 'default'}
              hint="Unpaid cancellation and no-show fees"
            />
            <Stat
              label="Support tickets"
              value={s?.openTickets ?? 0}
              hint={`${s?.scheduledTrips ?? 0} scheduled trips upcoming`}
            />
          </div>
        </>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card
          title="Waiting for a driver"
          action={
            <Link href="/dispatch" className="text-sm font-semibold text-brand-600 hover:underline">
              Open dispatch
            </Link>
          }
        >
          {board.error ? (
            <ErrorState message={board.error} />
          ) : board.data.length === 0 ? (
            <EmptyState title="Every trip has a driver" hint="Nothing is waiting for assignment." />
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Trip</th>
                    <th>Pickup</th>
                    <th>Fare</th>
                    <th>Waiting</th>
                    <th>Recommended</th>
                  </tr>
                </thead>
                <tbody>
                  {board.data.slice(0, 6).map((trip) => (
                    <tr key={trip.tripId}>
                      <td>
                        <Link href={`/trips/${trip.tripId}`} className="font-semibold text-brand-600 hover:underline">
                          {trip.reference}
                        </Link>
                        <p className="text-xs text-ink-500">{trip.customerName}</p>
                      </td>
                      <td className="max-w-[180px] truncate">{trip.pickupAddress}</td>
                      <td>
                        <Money minor={trip.fareMinor} />
                      </td>
                      <td className="tabular text-ink-500">{Math.round(trip.waitingSeconds / 60)} min</td>
                      <td>
                        {trip.recommended ? (
                          <>
                            <span className="font-medium text-ink-800">{trip.recommended.name}</span>
                            <p className="text-xs text-ink-500">
                              {trip.recommended.distanceLabel} · {trip.recommended.workload} load
                            </p>
                          </>
                        ) : (
                          <span className="text-danger-700">No driver available</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Negotiations to decide"
          action={
            <Link href="/negotiations" className="text-sm font-semibold text-brand-600 hover:underline">
              Open console
            </Link>
          }
        >
          {queue.error ? (
            <ErrorState message={queue.error} />
          ) : queue.data.length === 0 ? (
            <EmptyState title="No offers waiting" hint="Everything is auto-accepted or already settled." />
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Trip</th>
                    <th>Our fare</th>
                    <th>Their offer</th>
                    <th>Discount</th>
                    <th>Round</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.data.slice(0, 6).map((item) => (
                    <tr key={item.negotiationId}>
                      <td>
                        <Link
                          href={`/negotiations/${item.negotiationId}`}
                          className="font-semibold text-brand-600 hover:underline"
                        >
                          {item.tripReference}
                        </Link>
                        <p className="text-xs text-ink-500">{item.customerName}</p>
                      </td>
                      <td>
                        <Money minor={item.originalFareMinor} />
                      </td>
                      <td>
                        <Money minor={item.customerOfferMinor} className="text-accent-700" />
                      </td>
                      <td className="tabular">{item.discountPercent}%</td>
                      <td className="tabular text-ink-500">
                        {item.roundsUsed}/{item.maxRounds}
                      </td>
                      <td>
                        <TimeAgo at={item.expiresAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {(s?.openFraudSignals ?? 0) > 0 ? (
        <Card className="mt-5" title="Risk signals">
          <div className="px-5 py-4 text-sm text-ink-600">
            <StatusBadge status="failed" />{' '}
            <span className="ml-2">
              {s?.openFraudSignals} open signal(s) need review. Check Reports → Risk.
            </span>
          </div>
        </Card>
      ) : null}
    </>
  );
}
