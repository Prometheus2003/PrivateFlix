ALTER TABLE "uploads"
  ADD COLUMN "expectedChecksum" TEXT,
  ADD COLUMN "completionStarted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "operationToken" UUID,
  ADD COLUMN "operationExpiresAt" TIMESTAMP(3);
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_expected_checksum_check"
  CHECK ("expectedChecksum" IS NULL OR "expectedChecksum" ~ '^[a-f0-9]{64}$');
ALTER TABLE "upload_parts" ALTER COLUMN "etag" DROP NOT NULL;
