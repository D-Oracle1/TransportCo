'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Sidebar rail item: an icon tile that knows whether it is the current section. */
export function NavLink({ href, label, icon }: { href: string; label: string; icon: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      title={label}
      className={`group flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[10px] font-medium transition-colors ${
        active ? 'bg-white text-ink-900' : 'text-ink-400 hover:bg-white/10 hover:text-white'
      }`}
    >
      <span className="text-lg leading-none" aria-hidden>
        {icon}
      </span>
      <span className="whitespace-nowrap">{label}</span>
    </Link>
  );
}
