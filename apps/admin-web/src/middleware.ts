import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route guard. An unauthenticated request to any console page is bounced to the
 * sign-in screen with its destination preserved, so a bookmarked dispatch board
 * still lands in the right place after signing in.
 *
 * This is a convenience guard only — every API route enforces its own
 * permissions server-side. A middleware check is not an authorisation model.
 */
export function middleware(request: NextRequest): NextResponse {
  const isAuthenticated = Boolean(request.cookies.get('tco_at')?.value);
  const { pathname } = request.nextUrl;

  const isPublic =
    pathname === '/login' || pathname.startsWith('/api/auth') || pathname.startsWith('/_next');

  if (!isAuthenticated && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthenticated && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
