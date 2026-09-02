/**
 * Nigerian phone handling. Everything is stored in E.164 (+2348012345678) so
 * lookups, SMS delivery and duplicate-account detection all agree on one form.
 */
const NG_COUNTRY_CODE = '234';

export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  let value = digits.startsWith('+') ? digits.slice(1) : digits;

  if (value.startsWith('00')) value = value.slice(2);
  if (value.startsWith('0')) value = NG_COUNTRY_CODE + value.slice(1);
  if (value.length === 10 && !value.startsWith(NG_COUNTRY_CODE)) value = NG_COUNTRY_CODE + value;

  if (!/^\d{11,15}$/.test(value)) return null;
  if (value.startsWith(NG_COUNTRY_CODE) && value.length !== 13) return null;
  return `+${value}`;
}

export function isValidPhone(input: string): boolean {
  return normalisePhone(input) !== null;
}

/** "+2348012345678" -> "+234 80 **** 5678". Shown in-trip; full numbers stay server-side. */
export function maskPhone(phone: string): string {
  const normalised = normalisePhone(phone) ?? phone;
  if (normalised.length < 8) return '****';
  const head = normalised.slice(0, 6);
  const tail = normalised.slice(-4);
  return `${head} **** ${tail}`;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '****';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

/**
 * ID, code and OTP generation live in `@transportco/utils/secure` — they need
 * a CSPRNG and must never run on a device.
 */

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Formats a reference from a database sequence, e.g. ("TRP", 1032) -> "TRP-1032". */
export function formatReference(prefix: string, sequence: number, pad = 4): string {
  return `${prefix}-${String(sequence).padStart(pad, '0')}`;
}
