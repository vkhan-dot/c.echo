import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const PUBLIC_PATHS = ['/login', '/auth/callback', '/api', '/logo.svg', '/room']

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Check for access token in cookie
  const token = request.cookies.get('centras_access')?.value

  if (!token) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.webp).*)'],
}
