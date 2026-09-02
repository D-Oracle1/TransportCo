import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from '@/lib/api';

/**
 * Authenticated proxy for client components.
 *
 * Interactive parts of the console (assigning a driver, countering an offer)
 * post here; this attaches the httpOnly access token and forwards to the API.
 * The token therefore never has to be readable by the browser.
 *
 * Only the paths the console actually uses are forwarded — an open proxy
 * carrying a privileged token would be a gift to anyone who found it.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

const ALLOWED_PREFIXES = ['admin/', 'auth/me'];

async function forward(request: Request, path: string[]): Promise<NextResponse> {
  const target = path.join('/');

  if (!ALLOWED_PREFIXES.some((prefix) => target.startsWith(prefix))) {
    return NextResponse.json({ ok: false, error: { message: 'Not allowed' } }, { status: 403 });
  }

  const token = cookies().get(ACCESS_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ ok: false, error: { message: 'Not signed in' } }, { status: 401 });
  }

  const url = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text();

  const response = await fetch(`${API_BASE}/${target}${url.search}`, {
    method: request.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(request.headers.get('idempotency-key')
        ? { 'Idempotency-Key': request.headers.get('idempotency-key')! }
        : {}),
    },
    body,
    cache: 'no-store',
  });

  const payload = await response.text();

  return new NextResponse(payload, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
  });
}

export async function GET(request: Request, context: { params: { path: string[] } }) {
  return forward(request, context.params.path);
}
export async function POST(request: Request, context: { params: { path: string[] } }) {
  return forward(request, context.params.path);
}
export async function PATCH(request: Request, context: { params: { path: string[] } }) {
  return forward(request, context.params.path);
}
export async function DELETE(request: Request, context: { params: { path: string[] } }) {
  return forward(request, context.params.path);
}
