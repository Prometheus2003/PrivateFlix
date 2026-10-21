/**
 * Security headers middleware.
 * Applied to all responses via Next.js config.
 *
 * @module lib/security-headers
 * @security
 *   - CSP: restricts script/style/media sources to 'self'
 *   - Frame protection: prevents clickjacking
 *   - Robots: prevents indexing of any page
 *   - HSTS: enforces HTTPS in production
 *   - Referrer: limits information leakage
 */

import type { NextConfig } from "next";

/**
 * Security headers to apply to all responses.
 */
export const securityHeaders = [
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Robots-Tag",
    value: "noindex, nofollow, nosnippet",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

/**
 * Security headers for production (adds HSTS).
 */
export const productionSecurityHeaders = [
  ...securityHeaders,
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

/**
 * Get the appropriate security headers for the current environment.
 */
export function getSecurityHeaders(): Array<{ key: string; value: string }> {
  if (process.env.NODE_ENV === "production") {
    return productionSecurityHeaders;
  }
  return securityHeaders;
}

/**
 * Apply security headers to a Next.js config object.
 * Use this in next.config.ts.
 */
export function withSecurityHeaders(config: NextConfig): NextConfig {
  const existingHeaders = config.headers;

  return {
    ...config,
    async headers() {
      const customHeaders = existingHeaders ? await existingHeaders() : [];

      return [
        ...customHeaders,
        {
          // Apply to all routes
          source: "/:path*",
          headers: getSecurityHeaders(),
        },
      ];
    },
  };
}
