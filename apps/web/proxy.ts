import { NextRequest, NextResponse } from "next/server";

function nonce() {
  return crypto.randomUUID().replaceAll("-", "");
}

function contentSecurityPolicy(nonceValue: string, allowEmbedding: boolean) {
  const frameAncestors = allowEmbedding ? "*" : "'self'";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonceValue}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    "upgrade-insecure-requests",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonceValue = nonce();
  const allowEmbedding = request.nextUrl.pathname.startsWith("/embed/");
  const csp = contentSecurityPolicy(nonceValue, allowEmbedding);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonceValue);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
    },
  ],
};
