import type { Config } from 'tailwindcss';
import { COLORS, RADII } from '@transportco/config';

/**
 * The console's Tailwind theme is generated from the shared brand tokens in
 * `@transportco/config`, so the admin web, the customer app and the driver app
 * cannot drift apart. Rebranding means editing one file in that package.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: COLORS.primary,
        accent: COLORS.accent,
        ink: COLORS.neutral,
        success: COLORS.success,
        warning: COLORS.warning,
        danger: COLORS.danger,
        info: COLORS.info,
      },
      borderRadius: {
        sm: `${RADII.sm}px`,
        DEFAULT: `${RADII.md}px`,
        md: `${RADII.md}px`,
        lg: `${RADII.lg}px`,
        xl: `${RADII.xl}px`,
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(11, 14, 16, 0.06), 0 8px 24px -12px rgba(11, 14, 16, 0.18)',
      },
    },
  },
  plugins: [],
};

export default config;
