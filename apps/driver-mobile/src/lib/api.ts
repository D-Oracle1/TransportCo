import * as SecureStore from 'expo-secure-store';
import type { ApiResponse, AuthenticatedSession } from '@transportco/types';

/**
 * Mobile API client.
 *
 * Built for the network this app actually runs on. Three behaviours are
 * deliberate:
 *
 *  1. TOKENS LIVE IN SECURE STORE (Keychain / Android Keystore), never in
 *     AsyncStorage, which is plain text on a rooted device.
 *  2. A 401 triggers ONE refresh attempt and replays the original request. Any
 *     concurrent calls wait on that single refresh rather than each firing
 *     their own and racing to invalidate each other's rotated token.
 *  3. Requests time out. A hung fetch on a stalled mobile connection otherwise
 *     leaves a spinner running until the user force-quits.
 */

const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const ACCESS_KEY = 'tco.access';
const REFRESH_KEY = 'tco.refresh';
const TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, string[]>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when retrying the same request might reasonably work. */
  get retryable(): boolean {
    return this.status >= 500 || this.code === 'provider_unavailable' || this.status === 0;
  }
}

export const tokenStore = {
  async get(): Promise<{ access: string | null; refresh: string | null }> {
    const [access, refresh] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_KEY),
      SecureStore.getItemAsync(REFRESH_KEY),
    ]);
    return { access, refresh };
  },

  async set(access: string, refresh: string): Promise<void> {
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, access),
      SecureStore.setItemAsync(REFRESH_KEY, refresh),
    ]);
  },

  async clear(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY),
      SecureStore.deleteItemAsync(REFRESH_KEY),
    ]);
  },
};

let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const { refresh } = await tokenStore.get();
      if (!refresh) return false;

      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });

      const payload = (await response.json()) as ApiResponse<AuthenticatedSession>;
      if (!response.ok || !payload.ok) {
        await tokenStore.clear();
        return false;
      }

      await tokenStore.set(payload.data.tokens.accessToken, payload.data.tokens.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Set for create-style calls so a retry on a dropped connection is safe. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  skipAuth?: boolean;
}

async function send<T>(path: string, options: RequestOptions, isRetry = false): Promise<T> {
  const { access } = options.skipAuth ? { access: null } : await tokenStore.get();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal ?? controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;

    if (response.status === 401 && !isRetry && !options.skipAuth) {
      const refreshed = await refreshSession();
      if (refreshed) return send<T>(path, options, true);
    }

    if (!response.ok || !payload || payload.ok === false) {
      const error = payload && payload.ok === false ? payload.error : null;
      throw new ApiError(
        error?.code ?? 'internal_error',
        error?.message ?? 'Something went wrong. Please try again.',
        response.status,
        error?.details,
        error?.retryAfterSeconds,
      );
    }

    return payload.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    // A network failure is a different problem from a rejected request, and the
    // message the user sees should say so.
    throw new ApiError(
      'internal_error',
      'We could not reach TransportCo. Check your connection and try again.',
      0,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  get: <T>(path: string) => send<T>(path, {}),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    send<T>(path, { method: 'POST', body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  patch: <T>(path: string, body?: unknown) => send<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => send<T>(path, { method: 'DELETE' }),
  public: {
    post: <T>(path: string, body?: unknown) => send<T>(path, { method: 'POST', body, skipAuth: true }),
  },
};
