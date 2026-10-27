import "server-only";
import type { Prisma } from "@prisma/client";
import { authError } from "@/lib/auth/http";
export async function ownedPlaylist(
  tx: Prisma.TransactionClient,
  ownerId: string,
  id: string,
) {
  const playlist = await tx.playlist.findFirst({
    where: { id, ownerId },
    select: { id: true, name: true, description: true },
  });
  if (!playlist) throw authError(404, "Playlist not found");
  return playlist;
}
export const playlistLock = (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(7253408)`;
