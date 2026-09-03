import { redirect } from 'next/navigation';
import { BRAND } from '@transportco/config';
import { currentUser } from '@/lib/api';
import { SignOutButton } from '@/components/SignOutButton';
import { NavLink } from '@/components/NavLink';

/**
 * Console shell — dark, glassy, icon-rail navigation.
 *
 * Navigation is filtered by the signed-in user's PERMISSIONS: a dispatcher never
 * sees a Payroll link. Hiding it is courtesy; the API refusing it is the control.
 */
const NAVIGATION = [
  { href: '/dashboard', label: 'Home', permission: 'trip:read', icon: '▦' },
  { href: '/dispatch', label: 'Dispatch', permission: 'trip:read', icon: '⇄' },
  { href: '/negotiations', label: 'Offers', permission: 'negotiation:read', icon: '⇅' },
  { href: '/trips', label: 'Trips', permission: 'trip:read', icon: '➜' },
  { href: '/drivers', label: 'Drivers', permission: 'driver:read', icon: '⬢' },
  { href: '/customers', label: 'Riders', permission: 'customer:read', icon: '◎' },
  { href: '/pricing', label: 'Pricing', permission: 'pricing:read', icon: '₦' },
  { href: '/reports', label: 'Reports', permission: 'report:read', icon: '▤' },
] as const;

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const visible = NAVIGATION.filter((item) => user.permissions.includes(item.permission));
  const roleLabel = user.roles.map((role) => role.replace(/_/g, ' ')).join(', ') || 'Staff';
  const initial = (roleLabel[0] ?? 'U').toUpperCase();

  return (
    <div className="flex min-h-screen">
      {/* icon rail */}
      <aside className="sticky top-0 flex h-screen w-[84px] shrink-0 flex-col items-center gap-2 border-r border-white/10 bg-white/[0.03] py-4 backdrop-blur-xl">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-lg font-black text-ink-900">
          {BRAND.monogram}
        </span>
        <nav className="flex w-full flex-1 flex-col items-stretch gap-1 px-2">
          {visible.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} icon={item.icon} />
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* topbar */}
        <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-white/10 bg-white/[0.03] px-6 py-3 backdrop-blur-xl">
          <div className="min-w-0 shrink-0">
            <p className="text-sm font-bold text-white">
              {BRAND.name} <span className="font-normal text-ink-400">Operations</span>
            </p>
            <p className="text-xs text-ink-500">Rivers State</p>
          </div>
          <div className="mx-auto hidden w-full max-w-md md:block">
            <input className="input" placeholder="Search trips, drivers, riders…" aria-label="Search" />
          </div>
          <button
            type="button"
            aria-label="Notifications"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-ink-200 hover:bg-white/10"
          >
            <span aria-hidden>◔</span>
          </button>
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white">
              {initial}
            </span>
            <div className="hidden sm:block">
              <p className="text-xs font-semibold capitalize text-white">{roleLabel}</p>
              <p className="text-[11px] text-ink-500">Signed in</p>
            </div>
          </div>
          <SignOutButton />
        </header>

        <main className="min-w-0 flex-1 p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
