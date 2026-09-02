import { NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/api';

/**
 * Sign-in.
 *
 * The browser posts credentials HERE, not to the API. This route calls the API
 * server-to-server and puts the resulting tokens into httpOnly cookies, so the
 * tokens never touch client JavaScript.
 *
 * It also enforces that only STAFF can use the console: a valid customer or
 * driver credential authenticates fine against the API but has no business
 * holding an operations session.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as { identifier?: string; password?: string };

  if (!body.identifier || !body.password) {
    return NextResponse.json({ ok: false, message: 'Enter your email and password' }, { status: 400 });
  }

  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Pass the real client address through so the API's rate limiting and
      // audit trail record the operator, not this server.
      'X-Forwarded-For': request.headers.get('x-forwarded-for') ?? '',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: { tokens: { accessToken: string; refreshToken: string; expiresAt: string }; user: { principalType: string; permissions: string[] } } }
    | { ok: false; error: { message: string } }
    | null;

  if (!response.ok || !payload || payload.ok === false) {
    return NextResponse.json(
      { ok: false, message: payload && payload.ok === false ? payload.error.message : 'Sign-in failed' },
      { status: response.status === 200 ? 401 : response.status },
    );
  }

  const { tokens, user } = payload.data;

  if (user.principalType !== 'employee' || user.permissions.length === 0) {
    return NextResponse.json(
      { ok: false, message: 'This account does not have access to the operations console' },
      { status: 403 },
    );
  }

  const result = NextResponse.json({ ok: true });
  const secure = process.env.NODE_ENV === 'production';

  result.cookies.set(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(tokens.expiresAt),
  });

  result.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });

  return result;
}
