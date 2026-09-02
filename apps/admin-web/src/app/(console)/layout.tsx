import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BRAND } from '@transportco/config';
import { currentUser } from '@/lib/api';
import { SignOutButton } from '@/components/SignOutButton';
import { NavLink } from '@/components/NavLink';

/**
 * Console shell.
 *
 * The navigation is filtered by the signed-in user's PERMISSIONS, so a
 * dispatcher never sees a Payroll link they would only be refused at. Hiding it
 * is courtesy; the API refusing it is the actual control.
 */
const NAVIGATION = [
  { href: '/dashboard', label: 'Dashboard', permission: 'trip:read' },
  { href: '/dispatch', label: 'Dispatch', permission: 'trip:read' },
  { href: '/negotiations', label: 'Negotiations', permission: 'negotiation:read' },
  { href: '/trips', label: 'Trips', permission: 'trip:read' },
  { href: '/drivers', label: 'Drivers', permission: 'driver:read' },
  { href: '/customers', label: 'Customers', permission: 'customer:read' },
  { href: '/pricing', label: 'Pricing', permission: 'pricing:read' },
  { href: '/reports', label: 'Reports', permission: 'report:read' },
] as const;

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();

  // A cookie can outlive its session (revoked roles, password reset). Verifying
  // against the API on every console render is what makes that take effect.
  if (!user) redirect('/login');

  const visible = NAVIGATION.filter((item) => user.permissions.includes(item.permission));

  return (
    <div className="min-h-screen lg:flex">
      <aside className="border-b border-ink-200 bg-ink-900 lg:min-h-screen lg:w-[248px] lg:shrink-0 lg:border-b-0">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-500 text-sm font-bold text-white">
            {BRAND.monogram}
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold text-white">{BRAND.name}</p>
            <p className="text-[11px] text-ink-400">Operations</p>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible lg:pb-6">
          {visible.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-ink-200 bg-white px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-800">
              {user.roles.map((role) => role.replace(/_/g, ' ')).join(', ') || 'Staff'}
            </p>
            <p className="text-xs text-ink-500">Rivers State operations</p>
          </div>
          <SignOutButton />
        </header>

        <main className="min-w-0 flex-1 p-5 lg:p-7">{children}</main>
      </div>
    </div>
  );
}
