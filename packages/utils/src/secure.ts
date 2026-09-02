import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * SERVER-ONLY helpers. Imported as `@transportco/utils/secure`.
 *
 * Kept out of the main barrel deliberately: the mobile apps bundle
 * `@transportco/utils`, and Metro cannot resolve `node:crypto`. More
 * importantly, nothing here should ever run on a device — an OTP or a
 * reference generated on the client is an OTP the client controls.
 */

export function newId(): string {
  return randomUUID();
}

/** No ambiguous characters: no O/0, no I/1. People read these aloud. */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += REFERENCE_ALPHABET[bytes[i]! % REFERENCE_ALPHABET.length];
  }
  return out;
}

/**
 * Numeric one-time code from a CSPRNG. `Math.random` is never acceptable here —
 * it is seeded predictably enough that OTPs become guessable in bulk.
 */
export function generateOtp(digits = 6): string {
  const max = 10 ** digits;
  const value = randomBytes(4).readUInt32BE(0) % max;
  return String(value).padStart(digits, '0');
}

/** Constant-time comparison for secrets (webhook signatures, token hashes). */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
