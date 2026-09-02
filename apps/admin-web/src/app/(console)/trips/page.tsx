import Link from 'next/link';
import { tryGet } from '@/lib/api';
import { Card, EmptyState, ErrorState, Money, PageHeader, StatusBadge, TimeAgo } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface TripRow {
  id: string;
  reference: string;
  status: string;
  type: string;
  pickup_address: string;
  destination_address: string;
  quoted_fare_minor: number;
  final_fare_minor: number | null;
  payment_status: string;
  payment_method: string | null;
  customer_name: string;
  driver_name: string | null;
  created_at: string;
}

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Negotiating', value: 'NEGOTIATING' },
  { label: 'Awaiting driver', value: 'FARE_LOCKED' },
  { label: 'On the road', value: 'TRIP_STARTED' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

export default async function TripsPage({
  searchParams,
}: {
  searchParams: { status?: string; search?: string; page?: string };
}) {
  const query = new URLSearchParams();
  if (searchParams.status) query.set('status', searchParams.status);
  if (searchParams.search) query.set('search', searchParams.search);
  query.set('page', searchParams.page ?? '1');
  query.set('pageSize', '25');

  const trips = await tryGet<{ items: TripRow[]; total: number; page: number; totalPages: number }>(
    `/admin/trips?${query.toString()}`,
    { items: [], total: 0, page: 1, totalPages: 0 },
  );

  return (
    <>
      <PageHeader title="Trips" subtitle={`${trips.data.total} trips`} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => {
          const active = (searchParams.status ?? '') === filter.value;
          const href = filter.value ? `/trips?status=${filter.value}` : '/trips';
          return (
            <Link
              key={filter.label}
              href={href}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                active ? 'bg-brand-500 text-white' : 'bg-white text-ink-600 hover:bg-ink-100'
              }`}
            >
              {filter.label}
            </Link>
          );
        })}

        <form action="/trips" className="ml-auto flex gap-2">
          <input
            name="search"
            className="input w-56"
            placeholder="Reference or customer"
            defaultValue={searchParams.search ?? ''}
          />
          <button type="submit" className="btn-ghost">Search</button>
        </form>
      </div>

      <Card>
        {trips.error ? (
          <ErrorState message={trips.error} />
        ) : trips.data.items.length === 0 ? (
          <EmptyState title="No trips match" hint="Try a different filter or search term." />
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Trip</th>
                  <th>Customer</th>
                  <th>Route</th>
                  <th>Driver</th>
                  <th>Quoted</th>
                  <th>Final</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {trips.data.items.map((trip) => (
                  <tr key={trip.id}>
                    <td>
                      <Link href={`/trips/${trip.id}`} className="font-semibold text-brand-600 hover:underline">
                        {trip.reference}
                      </Link>
                      {trip.type === 'scheduled' ? (
                        <p className="text-xs text-info-700">Scheduled</p>
                      ) : null}
                    </td>
                    <td>{trip.customer_name}</td>
                    <td className="max-w-[240px]">
                      <p className="truncate text-xs text-ink-600">{trip.pickup_address}</p>
                      <p className="truncate text-xs text-ink-500">→ {trip.destination_address}</p>
                    </td>
                    <td>{trip.driver_name ?? <span className="text-ink-400">Unassigned</span>}</td>
                    <td><Money minor={trip.quoted_fare_minor} className="text-ink-500" /></td>
                    <td><Money minor={trip.final_fare_minor} /></td>
                    <td>
                      <StatusBadge status={trip.payment_status} />
                      {trip.payment_method ? (
                        <p className="mt-0.5 text-xs text-ink-500">{trip.payment_method.replace('_', ' ')}</p>
                      ) : null}
                    </td>
                    <td><StatusBadge status={trip.status} /></td>
                    <td><TimeAgo at={trip.created_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {trips.data.totalPages > 1 ? (
        <nav className="mt-4 flex items-center justify-center gap-2 text-sm">
          {trips.data.page > 1 ? (
            <Link href={`/trips?page=${trips.data.page - 1}`} className="btn-ghost">Previous</Link>
          ) : null}
          <span className="tabular text-ink-500">
            Page {trips.data.page} of {trips.data.totalPages}
          </span>
          {trips.data.page < trips.data.totalPages ? (
            <Link href={`/trips?page=${trips.data.page + 1}`} className="btn-ghost">Next</Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
