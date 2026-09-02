import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatDistance } from '@transportco/utils';
import { tryGet } from '@/lib/api';
import { Card, EmptyState, Money, PageHeader, Stat, StatusBadge, TimeAgo } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface DriverDetail {
  driver: Record<string, string | number | null>;
  trips: Array<{
    id: string;
    reference: string;
    status: string;
    final_fare_minor: number | null;
    created_at: string;
  }>;
  reviews: Array<{ driver_rating: number; comment: string | null; created_at: string }>;
  incidents: Array<{ id: string; reference: string; type: string; status: string; created_at: string }>;
  performanceThisMonth: { trips: number; distance: number; minutes: number } | null;
}

export default async function DriverDetailPage({ params }: { params: { id: string } }) {
  const detail = await tryGet<DriverDetail | null>(`/admin/drivers/${params.id}`, null);
  if (!detail.data) notFound();

  const driver = detail.data.driver;
  const performance = detail.data.performanceThisMonth;

  return (
    <>
      <PageHeader
        title={String(driver.full_name)}
        subtitle={`${String(driver.employee_id)} · ${String(driver.job_title)} · ${String(
          driver.employment_status,
        )}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={String(driver.state)} />
            <Link href="/drivers" className="btn-ghost">
              All drivers
            </Link>
          </div>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Trips this month" value={performance?.trips ?? 0} />
        <Stat label="Distance this month" value={formatDistance(performance?.distance ?? 0)} />
        <Stat label="Hours on duty" value={Math.round((performance?.minutes ?? 0) / 60)} />
        <Stat
          label="Rating"
          value={driver.rating ? `${Number(driver.rating).toFixed(1)}★` : 'Not rated'}
          hint={`${String(driver.rating_count ?? 0)} ratings`}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Recent trips">
          {detail.data.trips.length === 0 ? (
            <EmptyState title="No trips yet" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Trip</th>
                  <th>Status</th>
                  <th>Fare</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.trips.map((trip) => (
                  <tr key={trip.id}>
                    <td>
                      <Link
                        href={`/trips/${trip.id}`}
                        className="font-semibold text-brand-600 hover:underline"
                      >
                        {trip.reference}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={trip.status} />
                    </td>
                    <td>
                      <Money minor={trip.final_fare_minor} />
                    </td>
                    <td>
                      <TimeAgo at={trip.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="space-y-5">
          <Card title="Vehicle">
            <div className="p-5 text-sm text-ink-700">
              {driver.plate_number ? (
                <>
                  <p className="font-semibold text-ink-900">
                    {String(driver.color)} {String(driver.make)} {String(driver.model)}
                  </p>
                  <p className="tabular mt-1 text-ink-600">{String(driver.plate_number)}</p>
                </>
              ) : (
                <p className="text-danger-700">
                  No vehicle assigned — this driver cannot be dispatched.
                </p>
              )}
            </div>
          </Card>

          <Card title="Recent ratings">
            {detail.data.reviews.length === 0 ? (
              <EmptyState title="No ratings yet" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {detail.data.reviews.map((review, index) => (
                  <li key={index} className="px-5 py-3">
                    <div className="flex items-center justify-between">
                      <span className="tabular text-sm font-semibold">{review.driver_rating}★</span>
                      <TimeAgo at={review.created_at} />
                    </div>
                    {review.comment ? (
                      <p className="mt-1 text-sm text-ink-600">{review.comment}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Incidents">
            {detail.data.incidents.length === 0 ? (
              <EmptyState title="No incidents recorded" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {detail.data.incidents.map((incident) => (
                  <li key={incident.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <span>
                      {incident.reference} · {incident.type}
                    </span>
                    <StatusBadge status={incident.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
