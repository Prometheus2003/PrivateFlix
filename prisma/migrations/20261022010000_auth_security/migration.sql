-- Fail safely if a legacy database has multiple owners; never delete accounts.
ALTER TABLE "users" ADD COLUMN "ownerSlot" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "users" ADD CONSTRAINT "users_ownerSlot_check" CHECK ("ownerSlot" = 1);
CREATE UNIQUE INDEX "users_ownerSlot_key" ON "users"("ownerSlot");
CREATE TABLE "auth_throttles" ("scope" TEXT NOT NULL PRIMARY KEY, "attempts" INTEGER NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL);
