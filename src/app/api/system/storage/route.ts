import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { authFailure } from "@/lib/auth/http";
import { getEnv } from "@/lib/validation/env";

export const runtime = "nodejs";

/** Configuration only. Account access is verified by an actual upload. */
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
    const env = getEnv();
    return NextResponse.json(
      {
        uploadDestination: env.STORAGE_PROVIDER,
        driveConfigured: Boolean(
          env.GOOGLE_DRIVE_CLIENT_ID &&
            env.GOOGLE_DRIVE_CLIENT_SECRET &&
            env.GOOGLE_DRIVE_REFRESH_TOKEN &&
            env.GOOGLE_DRIVE_FOLDER_ID,
        ),
        connectionStatus: "not-checked",
        maxUploadBytes: env.MAX_UPLOAD_SIZE,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
