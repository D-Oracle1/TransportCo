import { cookies } from 'next/headers';
import type { ApiResponse } from '@transportco/types';

/**
 * Server-side API client.
 *
 * ACCESS AND REFRESH TOKENS LIVE IN httpOnly COOKIES and are read only here, on
 * the server. Nothing in the browser can read them, so a cross-site scripting
 * bug in the console cannot walk away with an operations manager's session —
 * which, given this session can refund money and reassign drivers, is the
 * difference that matters.
 *
 * Client components never call the API directly; they go through
 * `/api/proxy/*`, which reattaches the token here.
 */

export const ACCESS_COOKIE = 'tco_at';
export const REFRESH_COOKIE = 'tco_rt';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Next.js cache behaviour. Operational data is never cached. */
  revalidate?: number | false;
  headers?: Record<string, string>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = cookies().get(ACCESS_COOKIE)?.value;

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    // Dispatch boards and negotiation queues are worthless when stale.
    cache: 'no-store',
    next: options.revalidate === undefined ? undefined : { revalidate: options.revalidate },
  });

  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;

  if (!response.ok || !payload || payload.ok === false) {
    const error = payload && payload.ok === false ? payload.error : null;
    throw new ApiError(
      response.status,
      error?.code ?? 'internal_error',
      error?.message ?? 'The request failed',
      error?.details,
    );
  }

  return payload.data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/**
 * Fetches without throwing. Dashboard panels use this so one failing widget
 * degrades to an inline message instead of blanking the whole console.
 */
export async function tryGet<T>(path: string, fallback: T): Promise<{ data: T; error: string | null }> {
  try {
    return { data: await api.get<T>(path), error: null };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : 'Could not load this data';
    return { data: fallback, error: message };
  }
}

export function isAuthenticated(): boolean {
  return Boolean(cookies().get(ACCESS_COOKIE)?.value);
}

export interface SessionUser {
  userId: string;
  principalType: string;
  roles: string[];
  permissions: string[];
}

export async function currentUser(): Promise<SessionUser | null> {
  try {
    return await api.get<SessionUser>('/auth/me');
  } catch {
    return null;
  }
}

export function can(user: SessionUser | null, permission: string): boolean {
  return user?.permissions.includes(permission) ?? false;
}
