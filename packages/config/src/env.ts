import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Finds the nearest `.env`, walking up from the working directory.
 *
 * In a monorepo the process usually starts in `services/api` while the `.env`
 * lives at the workspace root, and dotenv only looks in the current directory.
 * Walking up means one `.env` at the root serves every package — which is what
 * the README tells people to create.
 *
 * A `.env` closer to the process wins, so a package can still override.
 */
function loadNearestDotenv(startDirectory: string = process.cwd()): void {
  let directory = resolve(startDirectory);

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(directory, '.env');

    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }

    const parent = dirname(directory);
    if (parent === directory) break; // reached the filesystem root
    directory = parent;
  }

  // No file found: fall back to the ambient environment, which is how this runs
  // in CI and in production containers.
  loadDotenv();
}

/**
 * Environment configuration, validated once at boot.
 *
 * Rules this file enforces:
 *  - The process refuses to start with an invalid or missing required variable.
 *    A misconfigured payment key must fail loudly on deploy, not silently at
 *    the first customer transaction.
 *  - Production has stricter requirements than development (real JWT secret,
 *    real provider keys when a live provider is selected).
 *  - Nothing here is ever logged. `describeConfig()` returns a redacted view.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())));

const port = z.coerce.number().int().min(1).max(65_535);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: port.default(4000),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: booleanish.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(64).default(8),

  AUTH_PROVIDER: z.enum(['local', 'supabase']).default('local'),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  GOOGLE_MAPS_API_KEY: z.string().optional(),
  GOOGLE_MAPS_PROVIDER: z.enum(['mock', 'google']).default('mock'),

  PAYMENT_PROVIDER_DEFAULT: z.enum(['mock', 'paystack', 'flutterwave']).default('mock'),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  PAYSTACK_WEBHOOK_SECRET: z.string().optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_PUBLIC_KEY: z.string().optional(),
  FLUTTERWAVE_WEBHOOK_HASH: z.string().optional(),
  PAYMENT_CURRENCY: z.literal('NGN').default('NGN'),

  NOTIFICATIONS_DRIVER: z.enum(['log', 'live']).default('log'),
  EXPO_PUSH_ACCESS_TOKEN: z.string().optional(),
  SMS_PROVIDER: z.enum(['none', 'termii', 'twilio']).default('none'),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().default('TransportCo'),
  EMAIL_PROVIDER: z.enum(['none', 'resend', 'smtp']).default('none'),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('no-reply@transportco.example'),
  WHATSAPP_PROVIDER: z.enum(['none', 'meta']).default('none'),
  WHATSAPP_API_KEY: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),

  REALTIME_DRIVER: z.enum(['socketio', 'supabase']).default('socketio'),
  REALTIME_PATH: z.string().default('/realtime'),

  OPS_EMERGENCY_HOTLINE: z.string().default('+2340000000000'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(60).default(86_400),
});

export type AppEnv = z.infer<typeof envSchema>;

/** Cross-field rules that a flat schema cannot express. */
function assertConsistency(env: AppEnv): string[] {
  const problems: string[] = [];

  if (env.AUTH_PROVIDER === 'supabase' && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) {
    problems.push('AUTH_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  if (env.GOOGLE_MAPS_PROVIDER === 'google' && !env.GOOGLE_MAPS_API_KEY) {
    problems.push('GOOGLE_MAPS_PROVIDER=google requires GOOGLE_MAPS_API_KEY');
  }
  if (env.PAYMENT_PROVIDER_DEFAULT === 'paystack' && (!env.PAYSTACK_SECRET_KEY || !env.PAYSTACK_WEBHOOK_SECRET)) {
    problems.push('PAYMENT_PROVIDER_DEFAULT=paystack requires PAYSTACK_SECRET_KEY and PAYSTACK_WEBHOOK_SECRET');
  }
  if (env.PAYMENT_PROVIDER_DEFAULT === 'flutterwave' && (!env.FLUTTERWAVE_SECRET_KEY || !env.FLUTTERWAVE_WEBHOOK_HASH)) {
    problems.push('PAYMENT_PROVIDER_DEFAULT=flutterwave requires FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_HASH');
  }

  if (env.NODE_ENV === 'production') {
    // Guardrails that only matter once real customers and real money exist.
    if (env.PAYMENT_PROVIDER_DEFAULT === 'mock') {
      problems.push('PAYMENT_PROVIDER_DEFAULT=mock is not allowed in production');
    }
    if (env.GOOGLE_MAPS_PROVIDER === 'mock') {
      problems.push('GOOGLE_MAPS_PROVIDER=mock is not allowed in production');
    }
    if (env.JWT_SECRET.includes('change-me')) {
      problems.push('JWT_SECRET still holds its placeholder value');
    }
    if (env.CORS_ALLOWED_ORIGINS.some((origin) => origin === '*')) {
      problems.push('CORS_ALLOWED_ORIGINS may not be a wildcard in production');
    }
  }

  return problems;
}

let cached: AppEnv | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cached) return cached;

  loadNearestDotenv();
  const parsed = envSchema.safeParse({ ...process.env, ...source });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const problems = assertConsistency(parsed.data);
  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test helper — never call this from application code. */
export function resetEnvCache(): void {
  cached = null;
}

const SECRET_PATTERN = /(SECRET|KEY|TOKEN|PASSWORD|HASH)$/;

/** Redacted snapshot, safe to log at boot so ops can confirm what is active. */
export function describeConfig(env: AppEnv): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      SECRET_PATTERN.test(key) && typeof value === 'string' && value.length > 0 ? '[redacted]' : value,
    ]),
  );
}
