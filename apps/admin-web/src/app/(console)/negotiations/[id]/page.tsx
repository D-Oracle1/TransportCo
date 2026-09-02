import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser, tryGet } from '@/lib/api';
import { NegotiationConsole, type NegotiationDetail } from '@/components/NegotiationConsole';
import { PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function NegotiationDetailPage({ params }: { params: { id: string } }) {
  const [detail, user] = await Promise.all([
    tryGet<NegotiationDetail | null>(`/admin/negotiations/${params.id}`, null),
    currentUser(),
  ]);

  if (!detail.data) notFound();

  const trip = await tryGet<{ trip: { reference: string } } | null>(
    `/admin/trips/${detail.data.tripId}`,
    null,
  );

  return (
    <>
      <PageHeader
        title="Negotiation"
        subtitle="The customer negotiates with the company. The driver never sees any of this."
        action={
          <Link href="/negotiations" className="btn-ghost">
            Back to queue
          </Link>
        }
      />

      <NegotiationConsole
        detail={detail.data}
        tripReference={trip.data?.trip.reference ?? detail.data.tripId.slice(0, 8)}
        canOverrideFloor={user?.permissions.includes('negotiation:override_floor') ?? false}
      />
    </>
  );
}
