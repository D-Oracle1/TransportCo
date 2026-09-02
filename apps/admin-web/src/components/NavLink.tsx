'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Sidebar link that knows whether it is the current section. */
export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
        active ? 'bg-brand-500 text-white' : 'text-ink-300 hover:bg-ink-800 hover:text-white'
      }`}
    >
      {label}
    </Link>
  );
}
