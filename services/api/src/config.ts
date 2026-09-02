import { loadEnv, type AppEnv } from '@transportco/config';

/**
 * Boot-time configuration. `loadEnv` throws on anything missing or
 * inconsistent, so an invalid deployment fails at start-up rather than at the
 * first customer request.
 */
export const env: AppEnv = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** West Africa Time. Every pricing window is evaluated against this. */
export const OPERATING_TIMEZONE_OFFSET_MINUTES = 60;
