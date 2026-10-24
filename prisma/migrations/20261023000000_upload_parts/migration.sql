ALTER TABLE "uploads" ADD COLUMN "partSize" INTEGER;
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_part_size_check"
  CHECK ("partSize" IS NULL OR "partSize" = 8388608);

CREATE TABLE "upload_parts" (
  "uploadId" UUID NOT NULL,
  "partNumber" INTEGER NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "etag" VARCHAR(1024) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "upload_parts_pkey" PRIMARY KEY ("uploadId", "partNumber"),
  CONSTRAINT "upload_parts_uploadId_fkey" FOREIGN KEY ("uploadId")
    REFERENCES "uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "upload_parts_number_check" CHECK ("partNumber" BETWEEN 1 AND 10000),
  CONSTRAINT "upload_parts_length_check" CHECK ("byteLength" BETWEEN 1 AND 8388608),
  CONSTRAINT "upload_parts_checksum_check" CHECK ("checksum" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "upload_parts_etag_check" CHECK (length("etag") > 0)
);
