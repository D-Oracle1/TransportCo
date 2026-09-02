import { COLORS, LAYOUT, RADII, SPACING, TYPOGRAPHY } from '@transportco/config';

/**
 * Mobile theme.
 *
 * A thin projection of the shared brand tokens into the shapes React Native
 * wants. The customer app and the driver app import the SAME theme, so a fare
 * reads at the same weight in both and a rebrand is one file in
 * `@transportco/config`.
 */
export const theme = {
  color: {
    // Surfaces
    background: COLORS.neutral[50],
    surface: COLORS.neutral[0],
    surfaceMuted: COLORS.neutral[100],
    overlay: 'rgba(11, 14, 16, 0.55)',

    // Brand
    primary: COLORS.primary[500],
    primaryDark: COLORS.primary[700],
    primaryLight: COLORS.primary[100],
    onPrimary: COLORS.neutral[0],

    // Money and negotiation always use the accent, everywhere, in both apps.
    accent: COLORS.accent[500],
    accentDark: COLORS.accent[700],
    accentLight: COLORS.accent[100],
    onAccent: COLORS.neutral[900],

    // Text
    text: COLORS.neutral[900],
    textSecondary: COLORS.neutral[600],
    textMuted: COLORS.neutral[500],
    textInverse: COLORS.neutral[0],

    border: COLORS.neutral[200],
    borderStrong: COLORS.neutral[300],

    success: COLORS.success[500],
    successBg: COLORS.success[100],
    warning: COLORS.warning[500],
    warningBg: COLORS.warning[100],
    danger: COLORS.danger[500],
    dangerBg: COLORS.danger[100],
    info: COLORS.info[500],
    infoBg: COLORS.info[100],
  },

  spacing: SPACING,
  radius: RADII,
  layout: LAYOUT,

  text: {
    display: { fontSize: TYPOGRAPHY.display.size, lineHeight: TYPOGRAPHY.display.lineHeight, fontWeight: '700' as const },
    h1: { fontSize: TYPOGRAPHY.h1.size, lineHeight: TYPOGRAPHY.h1.lineHeight, fontWeight: '700' as const },
    h2: { fontSize: TYPOGRAPHY.h2.size, lineHeight: TYPOGRAPHY.h2.lineHeight, fontWeight: '600' as const },
    h3: { fontSize: TYPOGRAPHY.h3.size, lineHeight: TYPOGRAPHY.h3.lineHeight, fontWeight: '600' as const },
    body: { fontSize: TYPOGRAPHY.body.size, lineHeight: TYPOGRAPHY.body.lineHeight, fontWeight: '400' as const },
    bodyStrong: { fontSize: TYPOGRAPHY.bodyStrong.size, lineHeight: TYPOGRAPHY.bodyStrong.lineHeight, fontWeight: '600' as const },
    caption: { fontSize: TYPOGRAPHY.caption.size, lineHeight: TYPOGRAPHY.caption.lineHeight, fontWeight: '400' as const },
    overline: {
      fontSize: TYPOGRAPHY.overline.size,
      lineHeight: TYPOGRAPHY.overline.lineHeight,
      fontWeight: '600' as const,
      letterSpacing: 0.6,
      textTransform: 'uppercase' as const,
    },
    /** The fare is the point of most screens; it gets its own scale. */
    fare: { fontSize: TYPOGRAPHY.fare.size, lineHeight: TYPOGRAPHY.fare.lineHeight, fontWeight: '700' as const },
  },

  shadow: {
    card: {
      shadowColor: '#0b0e10',
      shadowOpacity: 0.08,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 3,
    },
    sheet: {
      shadowColor: '#0b0e10',
      shadowOpacity: 0.16,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: -6 },
      elevation: 12,
    },
  },
} as const;

export type Theme = typeof theme;
