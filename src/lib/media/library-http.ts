import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authError, readAuthBody } from "@/lib/auth/http";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const collectionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
  })
  .strict();
export const libraryJson = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export function libraryId(value: string): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) throw authError(400, "Invalid resource ID");
  return result.data;
}
export async function libraryBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = schema.safeParse(await readAuthBody(request));
  if (!result.success) throw authError(400, "Invalid library request");
  return result.data;
}
