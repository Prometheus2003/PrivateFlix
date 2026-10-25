ALTER TABLE "processing_jobs" ADD COLUMN "leaseToken" UUID,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
CREATE INDEX "processing_jobs_type_status_idx" ON "processing_jobs"("type", "status");
