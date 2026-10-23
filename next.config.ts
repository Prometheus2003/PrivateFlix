import { withSecurityHeaders } from "./src/lib/security-headers";
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  // Linux container packaging is opt-in; local builds use next start.
  output:
    process.env.PRIVATEFLIX_STANDALONE === "true" ? "standalone" : undefined,
  poweredByHeader: false,
  distDir: process.env.PRIVATEFLIX_BUILD_DIR || ".next",
};
export default withSecurityHeaders(nextConfig);
