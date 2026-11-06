import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseEnv as parseEnvFile } from "node:util";
import { envSchema, parseEnv } from "@/lib/validation/env-schema";
import {
  BackupError,
  exportMedia,
  restoreObjects,
  verifyMedia,
} from "./media-archive";

let stage = "parse command";

async function main() {
  const [action, path, envFile, ...extra] = process.argv.slice(2);
  if (
    !path ||
    !isAbsolute(path) ||
    extra.length ||
    (action === "verify"
      ? envFile !== undefined
      : (action !== "export" && action !== "restore") || !envFile)
  )
    throw new BackupError(
      "Use media:backup -- export|restore <absolute-archive-folder> <env-file>, or verify <absolute-archive-folder>",
    );

  stage = "verify archive";
  if (action === "verify") {
    const snapshot = await verifyMedia(path);
    console.info(`Verified ${snapshot.entries} archive objects.`);
    return;
  }

  stage = "load explicit connection configuration";
  const settings = parseEnvFile(await readFile(envFile!, "utf8"));
  const env = parseEnv(settings);
  const database = new URL(env.DATABASE_URL);
  const schema = database.searchParams.get("schema") ?? "public";
  if (schema !== "public")
    throw new BackupError(
      "Media backup requires the PrivateFlix public database schema",
    );
  if (
    action === "restore" &&
    (!/^\/privateflix_restore_[a-z0-9_]+$/.test(database.pathname) ||
      !/^privateflix-restore-[a-z0-9-]+$/.test(env.S3_BUCKET) ||
      env.STORAGE_PROVIDER !== "s3" ||
      env.GOOGLE_DRIVE_REFRESH_TOKEN)
  )
    throw new BackupError(
      "Restore requires a dedicated privateflix_restore_* database, a new privateflix-restore-* S3 bucket and S3-only configuration",
    );

  for (const name of Object.keys(envSchema.shape)) delete process.env[name];
  for (const name of Object.keys(envSchema.shape)) {
    if (settings[name] !== undefined) process.env[name] = settings[name];
  }

  const { prisma } = await import("@/lib/db/prisma");
  const { createS3StorageAdapter } = await import("@/lib/storage/s3");
  const {
    assertSnapshotMatches,
    backupOwner,
    mediaReferences,
    switchToRestoredObjects,
  } = await import("./library");
  try {
    if (action === "export") {
      stage = "read source library and export media";
      const folder = join(await realpath(dirname(path)), basename(path));
      const fromCheckout = relative(await realpath(process.cwd()), folder);
      if (
        !isAbsolute(fromCheckout) &&
        fromCheckout !== ".." &&
        !fromCheckout.startsWith(".." + sep)
      )
        throw new BackupError(
          "Choose a new archive folder outside the PrivateFlix checkout",
        );
      const { createStorage } = await import("@/lib/storage");
      const ownerId = await backupOwner();
      const snapshot = await exportMedia(
        folder,
        ownerId,
        mediaReferences(ownerId),
        createStorage(createS3StorageAdapter(undefined, "read-only")),
        (proposed) => assertSnapshotMatches(folder, proposed),
      );
      console.info(`Exported ${snapshot.entries} archive objects.`);
      return;
    }

    stage = "verify archive";
    const snapshot = await verifyMedia(path);
    stage = "verify restored database inventory";
    const [target] = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name
    `;
    if ("/" + target?.name !== database.pathname)
      throw new BackupError(
        "Connected database does not match the restore destination",
      );
    await assertSnapshotMatches(path, snapshot);
    stage = "copy and verify objects in the new bucket";
    await restoreObjects(
      path,
      snapshot,
      createS3StorageAdapter(undefined, "new-bucket"),
    );
    stage = "switch the restored database to verified objects";
    await switchToRestoredObjects(path, snapshot);
    console.info(`Restored and verified ${snapshot.entries} objects.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof BackupError ? ` ${error.message}.` : "";
  console.error(`Media backup could not ${stage}.${message}`);
  process.exitCode = 1;
});
