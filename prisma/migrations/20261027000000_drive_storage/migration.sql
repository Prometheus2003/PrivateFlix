CREATE TABLE "drive_objects" (
  "key" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "verifiedMd5" TEXT,
  "verifiedSize" BIGINT,
  "revisionId" TEXT,
  "stagingPending" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "drive_objects_pkey" PRIMARY KEY ("key")
);
CREATE UNIQUE INDEX "drive_objects_fileId_key" ON "drive_objects"("fileId");
CREATE INDEX "drive_objects_stagingPending_createdAt_idx" ON "drive_objects"("stagingPending", "createdAt");
