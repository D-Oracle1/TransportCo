import type { Metadata, Viewport } from 'next';
import { BRAND } from '@transportco/config';
import './globals.css';

export const metadata: Metadata = {
  title: `${BRAND.name} — Operations`,
  description: 'Operations console for the TransportCo transportation platform.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
