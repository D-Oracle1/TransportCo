import Link from 'next/link';
import { tryGet } from '@/lib/api';
import { Card, EmptyState, ErrorState, PageHeader, StatusBadge, TimeAgo, WorkloadPill } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface DriverRow {
  id: string;
  full_name: string;
  phone: string;
  employee_id: string;
  state: string;
  rating: number | null;
  total_trips: number;
  employment_status: string;
  plate_number: string | null;
  last_location_at: string | null;
  active_trips: number;
  completed_today: number;
  scheduled_next_4h: number;
  workloadScore: number;
}

/**
 * Driver roster.
 *
 * Workload is shown beside availability because "available" alone is a
 * misleading signal: a driver who has run eleven trips today is available and
 * still the wrong choice.
 */
export default async function DriversPage() {
  const drivers = await tryGet<DriverRow[]>('/admin/drivers', []);

  return (
    <>
      <PageHeader
        title="Drivers"
        subtitle="Company employees, compensated through payroll — never through commission."
      />

      <Card title={`${drivers.data.length} drivers`}>
        {drivers.error ? (
          <ErrorState message={drivers.error} />
        ) : drivers.data.length === 0 ? (
          <EmptyState title="No drivers yet" hint="Add drivers from the HR module." />
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Vehicle</th>
                  <th>State</th>
                  <th>Workload</th>
                  <th>Today</th>
                  <th>Next 4h</th>
                  <th>Rating</th>
                  <th>Trips</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {drivers.data.map((driver) => (
                  <tr key={driver.id}>
                    <td>
                      <Link
                        href={`/drivers/${driver.id}`}
                        className="font-semibold text-brand-600 hover:underline"
                      >
                        {driver.full_name}
                      </Link>
                      <p className="text-xs text-ink-500">
                        {driver.employee_id} · {driver.employment_status}
                      </p>
                    </td>
                    <td className="text-sm">
                      {driver.plate_number ?? <span className="text-danger-700">None</span>}
                    </td>
                    <td>
                      <StatusBadge status={driver.state} />
                    </td>
                    <td>
                      <WorkloadPill score={driver.workloadScore} />
                    </td>
                    <td className="tabular">{driver.completed_today}</td>
                    <td className="tabular">{driver.scheduled_next_4h}</td>
                    <td className="tabular">
                      {driver.rating ? `${Number(driver.rating).toFixed(1)}★` : '—'}
                    </td>
                    <td className="tabular">{driver.total_trips}</td>
                    <td>
                      <TimeAgo at={driver.last_location_at} />
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
