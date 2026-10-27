import "server-only";
import { z } from "zod";
import { getEnv } from "@/lib/validation/env";
import { DriveClient } from "./drive-client";

export interface DriveStatus {
  connectionStatus: "connected" | "unavailable";
  checkedAt: string;
  capacityBytes: number | null;
  usedBytes: number | null;
}
// Bound repeated status checks; neither credentials nor Google identifiers leave
// this module. A successful check verifies the folder as well as token access.
let cached: { until: number; result: DriveStatus } | undefined;
let pending: Promise<DriveStatus> | undefined;
export async function checkDriveStatus(): Promise<DriveStatus> {
  if (cached && cached.until > Date.now()) return cached.result;
  if (pending) return pending;
  pending = (async () => {
    const result: DriveStatus = {
      connectionStatus: "unavailable",
      checkedAt: new Date().toISOString(),
      capacityBytes: null,
      usedBytes: null,
    };
    try {
      const env = getEnv();
      const deadline = AbortSignal.timeout(12000);
      const client = new DriveClient(
        {
          clientId: env.GOOGLE_DRIVE_CLIENT_ID!,
          clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET!,
          refreshToken: env.GOOGLE_DRIVE_REFRESH_TOKEN!,
          folderId: env.GOOGLE_DRIVE_FOLDER_ID!,
        },
        (input, options) =>
          fetch(input, {
            ...options,
            signal: AbortSignal.any([deadline, options?.signal ?? deadline]),
          }),
      );
      const [response] = await Promise.all([
        client.request(
          "https://www.googleapis.com/drive/v3/about?fields=storageQuota",
          {
            signal: AbortSignal.timeout(10000),
          },
        ),
        client.assertPrivateFolder(),
      ]);
      if (!response.ok) throw new Error("Drive check unavailable");
      const bytes = z.coerce.number().int().nonnegative().safe();
      const quota = z
        .object({
          storageQuota: z.object({
            limit: bytes.optional(),
            usage: bytes.optional(),
          }),
        })
        .parse(await response.json()).storageQuota;
      result.connectionStatus = "connected";
      result.capacityBytes = quota.limit ?? null;
      result.usedBytes = quota.usage ?? null;
    } catch {
      // An expired grant, shared folder or provider failure has the same safe UI
      // result. Do not expose Google error bodies, identifiers or tokens.
    }
    cached = { until: Date.now() + 30000, result };
    return result;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
