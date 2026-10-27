import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { getEnv } from "@/lib/validation/env";
import { checkDriveStatus } from "@/lib/storage/drive-status";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
    const query = z
      .object({ verify: z.enum(["true", "false"]).default("false") })
      .strict()
      .safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!query.success) throw authError(400, "Invalid storage request");
    const env = getEnv();
    const configured = Boolean(
      env.GOOGLE_DRIVE_CLIENT_ID &&
        env.GOOGLE_DRIVE_CLIENT_SECRET &&
        env.GOOGLE_DRIVE_REFRESH_TOKEN &&
        env.GOOGLE_DRIVE_FOLDER_ID,
    );
    const checked =
      configured && query.data.verify === "true"
        ? await checkDriveStatus()
        : null;
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
        checkedAt: null,
        capacityBytes: null,
        usedBytes: null,
        ...checked,
        maxUploadBytes: env.MAX_UPLOAD_SIZE,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
