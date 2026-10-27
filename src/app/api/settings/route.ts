import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { libraryBody, libraryJson } from "@/lib/media/library-http";
import {
  defaultPreferences,
  preferencesSchema,
} from "@/lib/validation/preferences";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const stored = await prisma.appSetting.findUnique({
      where: { key: `preferences:${user.id}` },
    });
    let preferences = defaultPreferences;
    if (stored) {
      try {
        preferences = preferencesSchema.parse(JSON.parse(stored.value));
      } catch {
        /* Safe defaults for old configuration. */
      }
    }
    return libraryJson({ preferences });
  } catch (error) {
    return authFailure(error);
  }
}
export async function PUT(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const preferences = await libraryBody(request, preferencesSchema);
    await prisma.appSetting.upsert({
      where: { key: `preferences:${user.id}` },
      create: {
        key: `preferences:${user.id}`,
        value: JSON.stringify(preferences),
      },
      update: { value: JSON.stringify(preferences) },
    });
    return libraryJson({ preferences });
  } catch (error) {
    return authFailure(error);
  }
}
