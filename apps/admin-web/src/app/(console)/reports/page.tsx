import { formatDuration, formatMoney } from '@transportco/utils';
import { tryGet } from '@/lib/api';
import { Card, ErrorState, PageHeader, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface Kpis {
  trips: { total: number; completed: number; cancelled: number; cancellationRate: number };
  revenue: {
    totalMinor: number;
    averageFareMinor: number;
    perVehicleMinor: number;
    perDriverMinor: number;
  };
  negotiation: {
    total: number;
    negotiated: number;
    accepted: number;
    acceptanceRate: number;
    averageOriginalFareMinor: number;
    averageFinalFareMinor: number;
    averageDiscountPercent: number;
    totalDiscountMinor: number;
  };
  operations: {
    averagePickupSeconds: number;
    averageTripSeconds: number;
    paymentSuccessRate: number;
    supportTickets: number;
    newCustomers: number;
    activeCustomers: number;
  };
  contributionMargin: {
    revenueMinor: number;
    discountMinor: number;
    energyCostMinor: number;
    driverVariableCostMinor: number;
    operationalCostMinor: number;
    paymentFeeMinor: number;
    contributionMarginMinor: number;
    marginPercent: number;
  };
}

/**
 * Management reporting.
 *
 * Built around the one question the negotiation feature has to answer: is
 * discounting winning enough volume to pay for itself? Discount given away sits
 * directly beside contribution margin, so the trade-off is visible rather than
 * inferred.
 */
export default async function ReportsPage() {
  const kpis = await tryGet<Kpis | null>('/admin/reports/kpis', null);

  if (kpis.error || !kpis.data) {
    return (
      <>
        <PageHeader title="Reports" />
        <Card>
          <ErrorState message={kpis.error ?? 'No data yet'} />
        </Card>
      </>
    );
  }

  const { trips, revenue, negotiation, operations, contributionMargin } = kpis.data;

  return (
    <>
      <PageHeader title="Reports" subtitle="This month to date" />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Revenue" value={formatMoney(revenue.totalMinor)} hint={`${trips.completed} completed trips`} />
        <Stat
          label="Contribution margin"
          value={formatMoney(contributionMargin.contributionMarginMinor)}
          hint={`${contributionMargin.marginPercent}% of revenue`}
          tone={contributionMargin.contributionMarginMinor >= 0 ? 'success' : 'danger'}
        />
        <Stat label="Average fare" value={formatMoney(revenue.averageFareMinor)} />
        <Stat
          label="Cancellation rate"
          value={`${trips.cancellationRate}%`}
          tone={trips.cancellationRate > 15 ? 'warning' : 'default'}
          hint={`${trips.cancelled} of ${trips.total}`}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Is negotiation paying for itself?">
          <dl className="space-y-3 p-5 text-sm">
            <Row label="Trips where the customer negotiated" value={String(negotiation.negotiated)} />
            <Row label="Of those, agreed" value={`${negotiation.accepted} (${negotiation.acceptanceRate}%)`} />
            <Row
              label="Average original fare"
              value={formatMoney(negotiation.averageOriginalFareMinor)}
            />
            <Row label="Average final fare" value={formatMoney(negotiation.averageFinalFareMinor)} />
            <Row label="Average discount" value={`${negotiation.averageDiscountPercent}%`} />
            <Row
              label="Total discount given"
              value={formatMoney(negotiation.totalDiscountMinor)}
              emphasis="danger"
            />
          </dl>

          <p className="border-t border-ink-100 px-5 py-3 text-xs text-ink-500">
            A high acceptance rate with a small average discount means the auto-accept band is set
            well. A large total discount with a flat trip count means we are paying for volume we
            would have had anyway.
          </p>
        </Card>

        <Card title="Contribution margin per period">
          <dl className="space-y-3 p-5 text-sm">
            <Row label="Revenue" value={formatMoney(contributionMargin.revenueMinor)} />
            <Row label="Less fuel / energy" value={`−${formatMoney(contributionMargin.energyCostMinor)}`} />
            <Row
              label="Less driver variable cost"
              value={`−${formatMoney(contributionMargin.driverVariableCostMinor)}`}
            />
            <Row
              label="Less operating overhead"
              value={`−${formatMoney(contributionMargin.operationalCostMinor)}`}
            />
            <Row label="Less payment fees" value={`−${formatMoney(contributionMargin.paymentFeeMinor)}`} />
            <div className="flex items-baseline justify-between border-t border-ink-100 pt-3">
              <dt className="font-semibold text-ink-800">Contribution margin</dt>
              <dd className="tabular text-lg font-bold text-ink-900">
                {formatMoney(contributionMargin.contributionMarginMinor)}
              </dd>
            </div>
          </dl>
        </Card>

        <Card title="Operations">
          <dl className="space-y-3 p-5 text-sm">
            <Row label="Average pickup time" value={formatDuration(operations.averagePickupSeconds)} />
            <Row label="Average trip duration" value={formatDuration(operations.averageTripSeconds)} />
            <Row label="Payment success rate" value={`${operations.paymentSuccessRate}%`} />
            <Row label="Support tickets" value={String(operations.supportTickets)} />
          </dl>
        </Card>

        <Card title="Customers & fleet">
          <dl className="space-y-3 p-5 text-sm">
            <Row label="New customers" value={String(operations.newCustomers)} />
            <Row label="Active customers" value={String(operations.activeCustomers)} />
            <Row label="Revenue per vehicle" value={formatMoney(revenue.perVehicleMinor)} />
            <Row label="Revenue per driver" value={formatMoney(revenue.perDriverMinor)} />
          </dl>
        </Card>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: 'danger' | 'success';
}) {
  const tone =
    emphasis === 'danger' ? 'text-danger-700' : emphasis === 'success' ? 'text-success-700' : 'text-ink-900';

  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-500">{label}</dt>
      <dd className={`tabular text-right font-semibold ${tone}`}>{value}</dd>
    </div>
  );
}
