import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '@transportco/config/env';

/**
 * Configuration guardrails.
 *
 * These are a security control, not a convenience: they are what stops a
 * production deployment from quietly running on a mock payment provider or a
 * placeholder signing secret. A misconfigured deploy must fail on the deploy,
 * not at the first customer transaction.
 */

const VALID_SECRET = 'a-sufficiently-long-development-secret-value-32';

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/transportco',
    JWT_SECRET: VALID_SECRET,
    ...overrides,
  };
}

beforeEach(() => {
  resetEnvCache();
});

describe('required configuration', () => {
  it('accepts a valid development configuration', () => {
    const config = loadEnv(env());

    expect(config.NODE_ENV).toBe('development');
    expect(config.PAYMENT_PROVIDER_DEFAULT).toBe('mock');
  });

  it('refuses a short signing secret', () => {
    expect(() => loadEnv(env({ JWT_SECRET: 'too-short' }))).toThrow(/at least 32 characters/);
  });

  it('parses the CORS allowlist into a list', () => {
    const config = loadEnv(
      env({ CORS_ALLOWED_ORIGINS: 'http://localhost:3000, https://ops.transportco.example' }),
    );

    expect(config.CORS_ALLOWED_ORIGINS).toEqual([
      'http://localhost:3000',
      'https://ops.transportco.example',
    ]);
  });
});

describe('cross-field consistency', () => {
  it('requires a maps key when the Google provider is selected', () => {
    expect(() => loadEnv(env({ GOOGLE_MAPS_PROVIDER: 'google' }))).toThrow(/GOOGLE_MAPS_API_KEY/);
  });

  it('requires a webhook secret alongside a Paystack key', () => {
    expect(() =>
      loadEnv(env({ PAYMENT_PROVIDER_DEFAULT: 'paystack', PAYSTACK_SECRET_KEY: 'sk_test_x' })),
    ).toThrow(/PAYSTACK_WEBHOOK_SECRET/);
  });

  it('requires Supabase credentials when Supabase auth is selected', () => {
    expect(() => loadEnv(env({ AUTH_PROVIDER: 'supabase' }))).toThrow(/SUPABASE_URL/);
  });
});

describe('production guardrails', () => {
  const production = (overrides: Record<string, string> = {}) =>
    env({
      NODE_ENV: 'production',
      PAYMENT_PROVIDER_DEFAULT: 'paystack',
      PAYSTACK_SECRET_KEY: 'sk_live_x',
      PAYSTACK_WEBHOOK_SECRET: 'whsec_x',
      GOOGLE_MAPS_PROVIDER: 'google',
      GOOGLE_MAPS_API_KEY: 'maps_key',
      CORS_ALLOWED_ORIGINS: 'https://ops.transportco.example',
      ...overrides,
    });

  it('accepts a fully configured production environment', () => {
    expect(() => loadEnv(production())).not.toThrow();
  });

  it('refuses to run on a mock payment provider', () => {
    expect(() => loadEnv(production({ PAYMENT_PROVIDER_DEFAULT: 'mock' }))).toThrow(
      /mock is not allowed in production/,
    );
  });

  it('refuses to run on a mock maps provider', () => {
    expect(() => loadEnv(production({ GOOGLE_MAPS_PROVIDER: 'mock' }))).toThrow(
      /mock is not allowed in production/,
    );
  });

  it('refuses a placeholder signing secret', () => {
    expect(() =>
      loadEnv(production({ JWT_SECRET: 'change-me-to-a-long-random-string-at-least-32-chars' })),
    ).toThrow(/placeholder/);
  });

  it('refuses a wildcard CORS origin', () => {
    expect(() => loadEnv(production({ CORS_ALLOWED_ORIGINS: '*' }))).toThrow(/wildcard/);
  });
});

describe('redaction', () => {
  it('never returns a secret in the describable config', async () => {
    const { describeConfig } = await import('@transportco/config/env');
    const described = describeConfig(loadEnv(env()));

    expect(described.JWT_SECRET).toBe('[redacted]');
    expect(described.DATABASE_URL).toBeTypeOf('string');
  });
});
