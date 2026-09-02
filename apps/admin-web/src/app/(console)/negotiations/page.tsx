import Link from 'next/link';
import { tryGet } from '@/lib/api';
import { Card, EmptyState, ErrorState, Money, PageHeader, TimeAgo } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface QueueItem {
  negotiationId: string;
  tripId: string;
  tripReference: string;
  customerName: string;
  customerRating: number | null;
  originalFareMinor: number;
  customerOfferMinor: number;
  floorMinor: number;
  companyPositionMinor: number;
  discountPercent: number;
  roundsUsed: number;
  maxRounds: number;
  pickupAddress: string;
  destinationAddress: string;
  distanceMetres: number;
  expiresAt: string;
}

/**
 * The negotiation queue.
 *
 * Ordered by EXPIRY, not by arrival: the offer about to lapse is the one that
 * costs a customer if nobody looks at it.
 */
export default async function NegotiationsPage() {
  const queue = await tryGet<QueueItem[]>('/admin/negotiations/queue', []);

  return (
    <>
      <PageHeader
        title="Negotiations"
        subtitle="Offers that fell between automatic acceptance and automatic rejection."
      />

      <Card title={`Awaiting a decision (${queue.data.length})`}>
        {queue.error ? (
          <ErrorState message={queue.error} />
        ) : queue.data.length === 0 ? (
          <EmptyState
            title="Nothing waiting"
            hint="Offers close to our price are accepted automatically; offers below the floor are declined automatically. Only the middle band reaches this queue."
          />
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Trip</th>
                  <th>Route</th>
                  <th>System fare</th>
                  <th>Customer offer</th>
                  <th>Minimum</th>
                  <th>Discount</th>
                  <th>Rounds</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.data.map((item) => (
                  <tr key={item.negotiationId}>
                    <td>
                      <p className="font-semibold text-ink-800">{item.tripReference}</p>
                      <p className="text-xs text-ink-500">
                        {item.customerName}
                        {item.customerRating ? ` · ${Number(item.customerRating).toFixed(1)}★` : ''}
                      </p>
                    </td>
                    <td className="max-w-[220px]">
                      <p className="truncate text-xs text-ink-600">{item.pickupAddress}</p>
                      <p className="truncate text-xs text-ink-500">→ {item.destinationAddress}</p>
                    </td>
                    <td><Money minor={item.originalFareMinor} /></td>
                    <td><Money minor={item.customerOfferMinor} className="text-accent-700" /></td>
                    {/* Internal figure — visible to staff with negotiation:read only. */}
                    <td><Money minor={item.floorMinor} className="text-ink-500" /></td>
                    <td className="tabular">{item.discountPercent}%</td>
                    <td className="tabular text-ink-500">
                      {item.roundsUsed}/{item.maxRounds}
                    </td>
                    <td><TimeAgo at={item.expiresAt} /></td>
                    <td>
                      <Link href={`/negotiations/${item.negotiationId}`} className="btn-primary">
                        Review
                      </Link>
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
