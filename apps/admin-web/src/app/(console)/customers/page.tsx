import Link from 'next/link';
import { tryGet } from '@/lib/api';
import { Card, EmptyState, ErrorState, Money, PageHeader, StatusBadge, TimeAgo } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface CustomerRow {
  id: string;
  reference: string;
  full_name: string;
  phone: string;
  email: string | null;
  status: string;
  rating: number | null;
  total_trips: number;
  outstanding: number;
  created_at: string;
}

/**
 * Customer list.
 *
 * Phone numbers arrive masked unless the signed-in role holds
 * `customer:read_pii`. The masking happens on the SERVER — this page renders
 * whatever it is given and has no way to unmask.
 */
export default async function CustomersPage({ searchParams }: { searchParams: { search?: string } }) {
  const query = new URLSearchParams({ pageSize: '25' });
  if (searchParams.search) query.set('search', searchParams.search);

  const customers = await tryGet<{ items: CustomerRow[]; total: number }>(
    `/admin/customers?${query.toString()}`,
    { items: [], total: 0 },
  );

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={`${customers.data.total} accounts`}
        action={
          <form action="/customers" className="flex gap-2">
            <input
              name="search"
              className="input w-64"
              placeholder="Name, phone or reference"
              defaultValue={searchParams.search ?? ''}
            />
            <button type="submit" className="btn-ghost">
              Search
            </button>
          </form>
        }
      />

      <Card>
        {customers.error ? (
          <ErrorState message={customers.error} />
        ) : customers.data.items.length === 0 ? (
          <EmptyState title="No customers match" hint="Try a different search term." />
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th>Trips</th>
                  <th>Rating</th>
                  <th>Outstanding</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {customers.data.items.map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      <Link
                        href={`/customers/${customer.id}`}
                        className="font-semibold text-brand-600 hover:underline"
                      >
                        {customer.full_name}
                      </Link>
                      <p className="text-xs text-ink-500">{customer.reference}</p>
                    </td>
                    <td className="tabular text-sm">{customer.phone}</td>
                    <td>
                      <StatusBadge status={customer.status} />
                    </td>
                    <td className="tabular">{customer.total_trips}</td>
                    <td className="tabular">
                      {customer.rating ? `${Number(customer.rating).toFixed(1)}★` : '—'}
                    </td>
                    <td>
                      {customer.outstanding > 0 ? (
                        <Money minor={customer.outstanding} className="text-danger-700" />
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td>
                      <TimeAgo at={customer.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
