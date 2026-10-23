/**
 * GET /api/auth/init-status
 *
 * Public endpoint to check if the application has been initialized.
 * Used by the frontend to decide whether to show Setup or Login page.
 *
 * @security
 *   - Public (no auth required) — only returns a boolean
 *   - Does NOT reveal user info, email, or any details
 */
import { NextResponse } from "next/server";
import { isAppInitialized } from "@/lib/auth/require-auth";

export async function GET() {
  try {
    const initialized = await isAppInitialized();

    return NextResponse.json(
      { initialized },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Initialization status unavailable" },
      {
        status: 500,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
