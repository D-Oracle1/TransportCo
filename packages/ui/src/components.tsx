import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { formatMoney } from '@transportco/utils';
import { theme } from './theme';

/**
 * Shared mobile primitives.
 *
 * Design rules that both apps inherit from here rather than re-deciding:
 *  - Every tappable target is at least 48dp. These are used one-handed, often
 *    while moving, sometimes on a bumpy road.
 *  - Every async control has an explicit loading state and stays disabled while
 *    busy, so a double-tap cannot double-submit.
 *  - Errors say what to do next, not just what went wrong.
 */

// --- Button ----------------------------------------------------------------

type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  fullWidth = true,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const palette: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
    primary: { bg: theme.color.primary, fg: theme.color.onPrimary },
    accent: { bg: theme.color.accent, fg: theme.color.onAccent },
    secondary: { bg: theme.color.surfaceMuted, fg: theme.color.text },
    ghost: { bg: 'transparent', fg: theme.color.primary, border: theme.color.borderStrong },
    danger: { bg: theme.color.danger, fg: theme.color.textInverse },
  };

  const tone = palette[variant];
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: tone.bg, opacity: inactive ? 0.55 : pressed ? 0.85 : 1 },
        tone.border ? { borderWidth: 1, borderColor: tone.border } : null,
        fullWidth ? { alignSelf: 'stretch' } : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={tone.fg} />
      ) : (
        <Text style={[styles.buttonLabel, { color: tone.fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

// --- Layout ----------------------------------------------------------------

export function Screen({
  children,
  scroll = false,
  padded = true,
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const content = (
    <View style={[padded ? { padding: theme.layout.screenPadding } : null, { flex: scroll ? 0 : 1 }, style]}>
      {children}
    </View>
  );

  if (!scroll) return <View style={styles.screen}>{content}</View>;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
    >
      {content}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function Row({
  children,
  style,
  gap = theme.spacing.sm,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  gap?: number;
}) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

// --- Typography ------------------------------------------------------------

type TextTone = 'default' | 'secondary' | 'muted' | 'inverse' | 'danger' | 'success' | 'accent';

export function Label({
  children,
  variant = 'body',
  tone = 'default',
  center = false,
  style,
  ...textProps
}: TextProps & {
  children: ReactNode;
  variant?: keyof typeof theme.text;
  tone?: TextTone;
  center?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const tones: Record<TextTone, string> = {
    default: theme.color.text,
    secondary: theme.color.textSecondary,
    muted: theme.color.textMuted,
    inverse: theme.color.textInverse,
    danger: theme.color.danger,
    success: theme.color.success,
    accent: theme.color.accentDark,
  };

  return (
    <Text
      {...textProps}
      style={[theme.text[variant], { color: tones[tone] }, center ? { textAlign: 'center' } : null, style]}
    >
      {children}
    </Text>
  );
}

/** The fare display. Always the largest thing on a screen that shows a price. */
export function Fare({ minor, caption }: { minor: number; caption?: string }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={[theme.text.fare, { color: theme.color.text }]}>{formatMoney(minor)}</Text>
      {caption ? (
        <Text style={[theme.text.caption, { color: theme.color.textMuted, marginTop: 2 }]}>{caption}</Text>
      ) : null}
    </View>
  );
}

// --- Input -----------------------------------------------------------------

export function Field({
  label,
  error,
  hint,
  ...inputProps
}: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  return (
    <View style={{ marginBottom: theme.spacing.lg }}>
      <Text style={[theme.text.overline, { color: theme.color.textMuted, marginBottom: 6 }]}>{label}</Text>
      <TextInput
        {...inputProps}
        placeholderTextColor={theme.color.textMuted}
        style={[
          styles.input,
          error ? { borderColor: theme.color.danger } : null,
          inputProps.style,
        ]}
      />
      {error ? (
        <Text style={[theme.text.caption, { color: theme.color.danger, marginTop: 5 }]}>{error}</Text>
      ) : hint ? (
        <Text style={[theme.text.caption, { color: theme.color.textMuted, marginTop: 5 }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

// --- Status ----------------------------------------------------------------

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
}) {
  const palette = {
    neutral: { bg: theme.color.surfaceMuted, fg: theme.color.textSecondary },
    success: { bg: theme.color.successBg, fg: theme.color.success },
    warning: { bg: theme.color.warningBg, fg: theme.color.warning },
    danger: { bg: theme.color.dangerBg, fg: theme.color.danger },
    info: { bg: theme.color.infoBg, fg: theme.color.info },
    accent: { bg: theme.color.accentLight, fg: theme.color.accentDark },
  }[tone];

  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      <Text style={[theme.text.caption, { color: palette.fg, fontWeight: '600' }]}>{label}</Text>
    </View>
  );
}

/** Full-screen loading. Used only where there is genuinely nothing to show yet. */
export function Loading({ message }: { message?: string }) {
  return (
    <View style={styles.centered}>
      <ActivityIndicator size="large" color={theme.color.primary} />
      {message ? (
        <Text style={[theme.text.body, { color: theme.color.textSecondary, marginTop: theme.spacing.md }]}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Error state with a retry. Never leaves the user at a dead end: every failure
 * offers the next action.
 */
export function ErrorView({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <View style={styles.centered}>
      <Text style={[theme.text.h3, { color: theme.color.text, textAlign: 'center' }]}>{title}</Text>
      <Text
        style={[
          theme.text.body,
          { color: theme.color.textSecondary, textAlign: 'center', marginTop: 6, marginBottom: theme.spacing.lg },
        ]}
      >
        {message}
      </Text>
      {onRetry ? <Button label={retryLabel} onPress={onRetry} variant="secondary" fullWidth={false} /> : null}
    </View>
  );
}

export function EmptyView({ title, message }: { title: string; message?: string }) {
  return (
    <View style={styles.centered}>
      <Text style={[theme.text.h3, { color: theme.color.text, textAlign: 'center' }]}>{title}</Text>
      {message ? (
        <Text
          style={[theme.text.body, { color: theme.color.textSecondary, textAlign: 'center', marginTop: 6 }]}
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}

/** Inline banner for offline state and warnings that must not block the screen. */
export function Banner({
  message,
  tone = 'warning',
}: {
  message: string;
  tone?: 'warning' | 'danger' | 'info' | 'success';
}) {
  const palette = {
    warning: { bg: theme.color.warningBg, fg: theme.color.warning },
    danger: { bg: theme.color.dangerBg, fg: theme.color.danger },
    info: { bg: theme.color.infoBg, fg: theme.color.info },
    success: { bg: theme.color.successBg, fg: theme.color.success },
  }[tone];

  return (
    <View style={[styles.banner, { backgroundColor: palette.bg }]}>
      <Text style={[theme.text.caption, { color: palette.fg, fontWeight: '600' }]}>{message}</Text>
    </View>
  );
}

/** Bottom sheet container used for the fare, negotiation and trip panels. */
export function Sheet({ children }: { children: ReactNode }) {
  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHandle} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.color.background,
  },
  button: {
    minHeight: theme.layout.minTouchTarget,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    paddingVertical: theme.spacing.md,
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    ...theme.shadow.card,
  },
  divider: {
    height: 1,
    backgroundColor: theme.color.border,
    marginVertical: theme.spacing.md,
  },
  input: {
    minHeight: theme.layout.minTouchTarget,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    fontSize: 16, // 16 keeps iOS from zooming the viewport on focus
    color: theme.color.text,
    backgroundColor: theme.color.surface,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  banner: {
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  sheet: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    paddingHorizontal: theme.layout.screenPadding,
    paddingBottom: theme.spacing['2xl'],
    paddingTop: theme.spacing.sm,
    ...theme.shadow.sheet,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.color.borderStrong,
    alignSelf: 'center',
    marginBottom: theme.spacing.md,
  },
});
