import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
test("production upload streams beyond the proxy buffer limit into private MinIO", async ({
  request,
}) => {
  test.skip(
    process.env.PRIVATEFLIX_SECURITY_TEST !== "1" ||
      process.env.PRIVATEFLIX_STORAGE_TEST !== "1",
    "Requires isolated PostgreSQL and MinIO",
  );
  if (
    new URL(process.env.DATABASE_URL!).pathname !==
      "/privateflix_security_test" ||
    process.env.S3_ENDPOINT !== "http://127.0.0.1:19000"
  )
    throw new Error("Only disposable test services are permitted");
  const db = new PrismaClient();
  try {
    let owner = await db.user.findFirst({ select: { id: true } });
    owner ??= await db.user.create({
      data: {
        email: "upload-http@example.test",
        username: "upload-http",
        passwordHash: "unused",
      },
      select: { id: true },
    });
    const token = randomBytes(32).toString("hex");
    await db.session.create({
      data: {
        userId: owner.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const data = Buffer.alloc(11 * 1024 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
    const headers = {
      Origin: "https://localhost:3319",
      Cookie: "privateflix_session=" + token,
      "X-Filename": "upload.png",
      "Content-Type": "image/png",
    };
    const response = await request.post("/api/media/upload", {
      headers,
      data,
      timeout: 60000,
    });
    expect(response.status()).toBe(201);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = await response.json();
    expect(body.media.fileSize).toBe(data.length);
    expect(body.media.processingStatus).toBe("UPLOADED");
    expect(body.media).not.toHaveProperty("storageKey");
    const progress = await request.get("/api/media/upload/" + body.uploadId, {
      headers: { Cookie: "privateflix_session=" + token },
    });
    expect(progress.status()).toBe(200);
    expect(progress.headers()["cache-control"]).toContain("no-store");
    const progressBody = await progress.json();
    expect(progressBody.upload.bytesUploaded).toBe(data.length);
    expect(progressBody.upload.status).toBe("UPLOADED");
    expect(progressBody.upload).not.toHaveProperty("storageUploadId");
    expect(
      (await request.get("/api/media/upload/" + body.uploadId)).status(),
    ).toBe(401);
    const stored = await db.media.findUniqueOrThrow({
      where: { id: body.media.id },
    });
    expect(stored.checksum).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
    const multipart = await request.post("/api/media/upload/start", {
      headers: { Origin: headers.Origin, Cookie: headers.Cookie },
      data: {
        filename: "resumed.png",
        mime: "image/png",
        totalBytes: data.length,
        checksum: createHash("sha256").update(data).digest("hex"),
      },
    });
    expect(multipart.status()).toBe(201);
    const started = await multipart.json();
    const base = "/api/media/upload/" + started.uploadId;
    for (const number of [2, 1, 1]) {
      const chunk = data.subarray(
        (number - 1) * started.partSize,
        number * started.partSize,
      );
      const sent = await request.put(base + "/parts/" + number, {
        headers: {
          Origin: headers.Origin,
          Cookie: headers.Cookie,
          "Content-Type": "application/octet-stream",
          "X-Part-Sha256": createHash("sha256").update(chunk).digest("hex"),
        },
        data: chunk,
      });
      expect(sent.status()).toBe(200);
    }
    const resumed = await request.get(base, {
      headers: { Cookie: headers.Cookie },
    });
    const resumedBody = await resumed.json();
    expect(resumedBody.upload.bytesUploaded).toBe(data.length);
    expect(resumedBody.upload.parts).toHaveLength(2);
    for (let retry = 0; retry < 2; retry++) {
      const completed = await request.post(base + "/complete", {
        headers: { Origin: headers.Origin, Cookie: headers.Cookie },
      });
      expect(completed.status()).toBe(200);
    }
    const completedMedia = await db.media.findUniqueOrThrow({
      where: { id: started.mediaId },
    });
    expect(completedMedia.checksum).toBe(stored.checksum);
    expect(
      (
        await fetch(
          process.env.S3_ENDPOINT +
            "/" +
            process.env.S3_BUCKET +
            "/" +
            completedMedia.storageKey,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          process.env.S3_ENDPOINT +
            "/" +
            process.env.S3_BUCKET +
            "/" +
            stored.storageKey,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request.post("/api/media/upload", {
          headers: { "Content-Type": "image/png" },
          data: Buffer.alloc(8),
        })
      ).status(),
    ).toBe(401);
  } finally {
    await db.$disconnect();
  }
});
