import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("server-only", () => ({}));
import { prisma } from "@/lib/db/prisma";
import { driveObjectRegistry as registry } from "@/lib/storage/drive-registry";
const enabled = process.env.PRIVATEFLIX_SECURITY_TEST === "1";
describe.skipIf(!enabled)("durable Drive publication registry", () => {
  beforeEach(async () => {
    if (
      new URL(process.env.DATABASE_URL!).pathname !==
      "/privateflix_security_test"
    )
      throw new Error("Test database required");
    await prisma.driveObject.deleteMany();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("elects one Drive ID under simultaneous reservations and rejects stale verification", async () => {
    const key = `drive/${randomUUID()}`;
    const [a, b] = await Promise.all([
      registry.reserve(key, "candidate-a"),
      registry.reserve(key, "candidate-b"),
    ]);
    expect(a.fileId).toBe(b.fileId);
    expect(a.verifiedMd5).toBeNull();
    await expect(
      registry.verify(key, "stale-id", "a".repeat(32), 10, "revision-a"),
    ).rejects.toThrow("state conflict");
    await registry.verify(key, a.fileId, "a".repeat(32), 10, "revision-a");
    await registry.verify(key, a.fileId, "a".repeat(32), 10, "revision-a");
    await expect(
      registry.verify(key, a.fileId, "b".repeat(32), 10, "revision-a"),
    ).rejects.toThrow("state conflict");
    await expect(
      registry.verify(key, a.fileId, "a".repeat(32), 10, "revision-b"),
    ).rejects.toThrow("state conflict");
    expect(await registry.find(key)).toMatchObject({
      verifiedMd5: "a".repeat(32),
      verifiedSize: 10,
      revisionId: "revision-a",
    });
  });
  it("limits reconciliation to twenty older, verified, pending staging copies", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.driveObject.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        key: `drive/old-${i}`,
        fileId: `old-${i}`,
        createdAt: old,
        verifiedMd5: "a".repeat(32),
        verifiedSize: BigInt(10),
        revisionId: "revision",
      })),
    });
    await prisma.driveObject.createMany({
      data: [
        {
          key: "drive/recent",
          fileId: "recent",
          verifiedMd5: "a".repeat(32),
          verifiedSize: BigInt(10),
          revisionId: "revision",
        },
        { key: "drive/unverified", fileId: "unverified", createdAt: old },
        {
          key: "drive/cleaned",
          fileId: "cleaned",
          createdAt: old,
          verifiedMd5: "a".repeat(32),
          verifiedSize: BigInt(10),
          revisionId: "revision",
          stagingPending: false,
        },
      ],
    });
    const pending = await registry.pending();
    expect(pending).toHaveLength(20);
    expect(pending.every((value) => value.key.startsWith("drive/old-"))).toBe(
      true,
    );
    for (const value of pending) await registry.stagingRemoved(value.key);
    expect(await registry.pending()).toHaveLength(5);
    await registry.remove("drive/old-0");
    expect(await registry.find("drive/old-0")).toBeNull();
  });
});
