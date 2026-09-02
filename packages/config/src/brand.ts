/**
 * Brand tokens.
 *
 * "TransportCo" is a working name. Everything the brand touches — colour, name,
 * logo mark, tone — is defined here and consumed everywhere else. Rebranding is
 * an edit to this file plus swapping the logo asset, not a search across three
 * applications.
 *
 * The palette is deliberately NOT the black/green of the incumbents: a deep
 * teal-slate primary with a warm amber accent, chosen to read as a serious
 * transport operator rather than a consumer marketplace.
 */
export const BRAND = {
  name: 'TransportCo',
  legalName: 'TransportCo Limited',
  shortName: 'TransportCo',
  tagline: 'Agreed fare. Company driver. Every trip.',
  supportEmail: 'support@transportco.example',
  supportPhone: '+2340000000000',
  websiteUrl: 'https://transportco.example',
  /** Single letter/monogram used until a real logo exists. */
  monogram: 'T',
} as const;

export const COLORS = {
  /** Primary — deep teal-slate. Buttons, active states, brand surfaces. */
  primary: {
    50: '#eef6f7',
    100: '#d3e8ea',
    200: '#a7d1d6',
    300: '#6fb2ba',
    400: '#3d8f99',
    500: '#1f6f7a',
    600: '#175862',
    700: '#12454d',
    800: '#0e363c',
    900: '#0a262b',
  },
  /** Accent — warm amber. Fares, negotiation, anything about money. */
  accent: {
    50: '#fff8ec',
    100: '#ffecc9',
    200: '#ffd88f',
    300: '#ffc154',
    400: '#f7a927',
    500: '#e08c0b',
    600: '#b56c06',
    700: '#8c520a',
    800: '#6b3f0e',
    900: '#4d2d0b',
  },
  neutral: {
    0: '#ffffff',
    50: '#f7f8f8',
    100: '#eef0f1',
    200: '#dde1e3',
    300: '#c2c9cc',
    400: '#98a3a8',
    500: '#6d7a80',
    600: '#4f5b61',
    700: '#3a4348',
    800: '#252c30',
    900: '#14191c',
    1000: '#0b0e10',
  },
  success: { 100: '#d9f2e4', 500: '#17915a', 700: '#0e6b41' },
  warning: { 100: '#fdf0d0', 500: '#c98a04', 700: '#8f6103' },
  danger: { 100: '#fbe0dd', 500: '#c94236', 700: '#96281e' },
  info: { 100: '#dbeafe', 500: '#2563eb', 700: '#1d4ed8' },
} as const;

/** 4px base scale — every margin and padding in every app is a multiple of it. */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
} as const;

export const RADII = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/**
 * Type scale. Sizes are in points/px; mobile and web share the same ramp so a
 * fare reads at the same visual weight in both places.
 */
export const TYPOGRAPHY = {
  display: { size: 34, lineHeight: 40, weight: '700' },
  h1: { size: 26, lineHeight: 32, weight: '700' },
  h2: { size: 21, lineHeight: 28, weight: '600' },
  h3: { size: 18, lineHeight: 24, weight: '600' },
  body: { size: 15, lineHeight: 22, weight: '400' },
  bodyStrong: { size: 15, lineHeight: 22, weight: '600' },
  caption: { size: 13, lineHeight: 18, weight: '400' },
  overline: { size: 11, lineHeight: 14, weight: '600' },
  /** Fares get their own scale — the number is the point of most screens. */
  fare: { size: 40, lineHeight: 46, weight: '700' },
} as const;

/** Minimum 48dp touch targets — one-handed use on a bumpy Port Harcourt road. */
export const LAYOUT = {
  minTouchTarget: 48,
  screenPadding: 20,
  bottomSheetHandleHeight: 28,
  maxContentWidth: 1440,
} as const;
