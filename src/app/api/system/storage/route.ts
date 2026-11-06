import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { getEnv } from "@/lib/validation/env";
import { checkDriveStatus } from "@/lib/storage/drive-status";
import { allocatedLibraryBytes } from "@/lib/media/upload-capacity";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
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
    const limit = env.MAX_LIBRARY_BYTES;
    const [checked, allocated] = await Promise.all([
      configured && query.data.verify === "true" ? checkDriveStatus() : null,
      limit === undefined ? null : allocatedLibraryBytes(prisma, user.id),
    ]);
    return NextResponse.json(
      {
        uploadDestination: env.STORAGE_PROVIDER,
        driveConfigured: configured,
        connectionStatus: "not-checked",
        checkedAt: null,
        capacityBytes: null,
        usedBytes: null,
        ...checked,
        maxUploadBytes: env.MAX_UPLOAD_SIZE,
        libraryLimit:
          limit === undefined || allocated === null
            ? null
            : { bytes: limit, allocatedBytes: Number(allocated) },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
