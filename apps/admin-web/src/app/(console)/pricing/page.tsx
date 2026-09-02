import { formatDistance, formatMoney } from '@transportco/utils';
import type { PricingRuleSet } from '@transportco/types';
import { tryGet } from '@/lib/api';
import { Card, EmptyState, ErrorState, PageHeader, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Pricing configuration.
 *
 * Read-first by design. Publishing a price list changes what every customer is
 * charged from the next quote onward, so the console shows exactly what is live,
 * the full version history, and a worked example — before anyone edits anything.
 *
 * A published version is IMMUTABLE. Editing means publishing a new version; the
 * old one is archived so completed trips can always be re-derived at the price
 * they were actually sold.
 */
export default async function PricingPage() {
  const [active, versions] = await Promise.all([
    tryGet<PricingRuleSet | null>('/admin/pricing/active', null),
    tryGet<PricingRuleSet[]>('/admin/pricing', []),
  ]);

  const rules = active.data;

  // A worked example makes an abstract table concrete: this is what a typical
  // 12 km, 25-minute Port Harcourt trip costs under the live configuration.
  const example = rules
    ? rules.baseFareMinor +
      Math.round((12_000 / 1000) * rules.perKilometreMinor) +
      Math.round((25 * 60 / 60) * rules.perMinuteMinor)
    : 0;

  return (
    <>
      <PageHeader
        title="Pricing"
        subtitle="Every fare in the system comes from this configuration. Published versions are immutable."
      />

      {active.error || !rules ? (
        <Card>
          <ErrorState message={active.error ?? 'No published pricing found'} />
        </Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
          <div className="space-y-5">
            <Card title={`Live: ${rules.name} (v${rules.version})`}>
              <dl className="grid gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
                <Field label="Base fare" value={formatMoney(rules.baseFareMinor)} />
                <Field label="Per kilometre" value={formatMoney(rules.perKilometreMinor)} />
                <Field label="Per minute" value={formatMoney(rules.perMinuteMinor)} />
                <Field label="Minimum fare" value={formatMoney(rules.minimumFareMinor)} />
                <Field
                  label="Maximum fare"
                  value={rules.maximumFareMinor ? formatMoney(rules.maximumFareMinor) : 'No cap'}
                />
                <Field label="Rounding" value={`Up to ${formatMoney(rules.roundToNearestMinor)}`} />
                <Field
                  label="Long distance"
                  value={`${formatMoney(rules.longDistancePerKilometreMinor)}/km beyond ${formatDistance(
                    rules.longDistanceThresholdMetres,
                  )}`}
                />
                <Field
                  label="Extra passengers"
                  value={`${formatMoney(rules.extraPassengerFeeMinor)} beyond ${rules.includedPassengers}`}
                />
                <Field label="Scheduled ride" value={`×${rules.scheduledRideMultiplier}`} />
              </dl>
            </Card>

            <Card title="Time-based adjustments">
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th>Multiplier</th>
                      <th>When</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[rules.peak, rules.night, rules.weekend, rules.publicHoliday].map((rule) => (
                      <tr key={rule.code}>
                        <td className="font-medium text-ink-800">{rule.label}</td>
                        <td className="tabular">×{rule.multiplier}</td>
                        <td className="text-xs text-ink-500">
                          {rule.windows
                            .map(
                              (window) =>
                                `${minuteLabel(window.startMinute)}–${minuteLabel(window.endMinute)}${
                                  window.weekdays?.length ? ` (${window.weekdays.map(dayLabel).join(', ')})` : ''
                                }`,
                            )
                            .join('; ')}
                        </td>
                        <td>
                          <StatusBadge status={rule.enabled ? 'succeeded' : 'unpaid'} />
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="font-medium text-ink-800">Demand</td>
                      <td className="tabular">×{rules.demandMultiplier}</td>
                      <td className="text-xs text-ink-500">
                        Operations-controlled, capped at ×{rules.demandMultiplierMax}
                      </td>
                      <td>
                        <StatusBadge status={rules.demandMultiplier > 1 ? 'pending' : 'unpaid'} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Version history">
              {versions.data.length === 0 ? (
                <EmptyState title="No versions" />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Effective from</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.data.map((version) => (
                      <tr key={version.id}>
                        <td className="tabular font-semibold">v{version.version}</td>
                        <td>{version.name}</td>
                        <td>
                          <StatusBadge status={version.status === 'published' ? 'succeeded' : 'unpaid'} />
                        </td>
                        <td className="text-xs text-ink-500">
                          {new Date(version.effectiveFrom).toLocaleDateString('en-NG')}
                        </td>
                        <td className="max-w-[240px] truncate text-xs text-ink-500">
                          {version.changeNote ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <div className="space-y-5">
            <Card title="Negotiation policy">
              <dl className="space-y-3 p-5 text-sm">
                <Row label="Negotiation" value={rules.negotiation.enabled ? 'Enabled' : 'Disabled'} />
                <Row
                  label="Auto-accept within"
                  value={`${rules.negotiation.autoAcceptDiscountPercent}% of the fare`}
                />
                <Row
                  label="Never go below"
                  value={`${rules.negotiation.maxDiscountPercent}% off the fare`}
                />
                <Row
                  label="Customer offers"
                  value={`${rules.negotiation.maxCustomerRounds} per trip`}
                />
                <Row label="Offer expires after" value={`${rules.negotiation.offerTtlSeconds / 60} minutes`} />
                <Row
                  label="Human review"
                  value={rules.negotiation.adminReviewEnabled ? 'On' : 'Off (auto-counter)'}
                />
              </dl>
            </Card>

            <Card title="Cancellation fees">
              <dl className="space-y-3 p-5 text-sm">
                <Row label="Grace period" value={`${rules.cancellation.gracePeriodSeconds}s`} />
                <Row label="After assignment" value={formatMoney(rules.cancellation.afterAssignmentFeeMinor)} />
                <Row label="Driver en route" value={formatMoney(rules.cancellation.driverEnRouteFeeMinor)} />
                <Row label="Driver arrived" value={formatMoney(rules.cancellation.driverArrivedFeeMinor)} />
                <Row label="No-show" value={formatMoney(rules.cancellation.noShowFeeMinor)} />
                <Row
                  label="Block new trips above"
                  value={formatMoney(rules.cancellation.blockNewTripsAboveOutstandingMinor)}
                />
              </dl>
            </Card>

            <Card title="Worked example">
              <div className="p-5 text-sm">
                <p className="text-ink-600">A 12 km, 25-minute trip off-peak:</p>
                <p className="tabular mt-2 text-2xl font-bold text-ink-900">{formatMoney(example)}</p>
                <p className="mt-2 text-xs text-ink-500">
                  Before rounding and any time-of-day adjustment. The server always recalculates —
                  this figure is illustrative only.
                </p>
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="stat-label">{label}</dt>
      <dd className="tabular mt-0.5 text-sm font-semibold text-ink-900">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-500">{label}</dt>
      <dd className="tabular text-right font-semibold text-ink-900">{value}</dd>
    </div>
  );
}

function minuteLabel(minute: number): string {
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function dayLabel(day: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day] ?? String(day);
}
