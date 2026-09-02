import { z } from 'zod';

/**
 * Shared primitives. Client and server import the SAME schemas, so a form that
 * passes validation in the app cannot be rejected by the API for a different
 * reason — and the server still re-validates everything it receives.
 */

export const uuidSchema = z.string().uuid();

export const phoneSchema = z
  .string()
  .trim()
  .min(10, 'Enter a valid phone number')
  .max(20)
  .regex(/^[+0-9][0-9\s-]{8,}$/, 'Enter a valid phone number');

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');

export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128)
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number');

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'Enter your full name')
  .max(120)
  .regex(/^[\p{L}][\p{L}\s'.-]*$/u, 'Name contains unsupported characters');

export const otpSchema = z.string().trim().regex(/^\d{4,8}$/, 'Enter the code we sent you');

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const placeSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  address: z.string().trim().min(3).max(255),
  placeId: z.string().max(255).nullish(),
});

/** Amounts arrive as integers in minor units. Never a float, never a string. */
export const minorAmountSchema = z
  .number()
  .int('Amount must be a whole number of kobo')
  .nonnegative();

export const positiveMinorAmountSchema = minorAmountSchema.refine((value) => value > 0, {
  message: 'Amount must be greater than zero',
});

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Free text from users. Trimmed and length-bounded; escaping happens at render. */
export const freeTextSchema = (max = 500) => z.string().trim().max(max);

export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime());
