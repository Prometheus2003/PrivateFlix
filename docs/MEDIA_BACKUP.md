# Media backup and recovery

The media backup command copies the originals, thumbnails and previews
referenced by PrivateFlix. It reads from MinIO or Google Drive according to each
file's saved location, including libraries that use both. It also copies
verified originals whose processing failed. The command streams files one at a
time and checks original sizes and any saved checksums.

## Make a backup

1. Let pending uploads, processing and deletions finish. Stop PrivateFlix and
   its worker for the backup window. Leave PostgreSQL and object storage
   available. Pause other changes to the media storage folder or bucket.
2. In a restricted, encrypted directory outside the checkout, create a new
   dated directory for this backup. Keep the PostgreSQL dump and its checksum
   there using the [database backup guide](DATABASE_BACKUP.md). Keep the
   server's configuration and credential recovery material in separate protected
   storage.
3. From the checkout, run the media export with the source configuration file.
   The parent directory must exist and the media subdirectory must be new.
   The export needs working Drive authorization if any backed-up files are in
   Drive. It reads the registered revisions and checks their downloaded bytes
   against the checksums saved by Drive.

```powershell
npm run media:backup -- export "X:\privateflix-backups\2026-11-07\media" ".env"
npm run media:backup -- verify "X:\privateflix-backups\2026-11-07\media"
```

Keep the database dump and the verified media directory from the same
maintenance window together. The media directory contains private file bytes
and an inventory. The command relies on the destination's encryption and access
controls. Once the database dump and media export finish, you can restart the
source app and worker. Verification of the media directory can run while the
source app is back online.

The export creates `complete.json` after checking that the media inventory
still matches the database. If export fails or verification reports a mismatch,
use a new backup directory on the next attempt. Keep an earlier verified backup
until its replacement passes verification. Each archive is a full copy, so allow
space for the original library and the number of backups you plan to retain.
Deleting a file from the live library does not erase earlier backups containing
that file.

## Restore to a fresh private S3 bucket

1. Verify the PostgreSQL dump checksum and restore it into an empty database
   named `privateflix_restore_<name>` using the [database guide](DATABASE_BACKUP.md).
   Keep the target app and worker stopped. Give the backup command access to the
   target database over a private connection.
2. Create a dedicated restore environment file with the restored database URL,
   new session secret, and the destination S3 endpoint and credentials. Set
   `STORAGE_PROVIDER=s3` and use a new bucket name beginning with
   `privateflix-restore-`. The command creates the bucket and checks its privacy
   policy. Use an isolated endpoint or credentials scoped to that bucket, and
   leave Google Drive credentials out of the target configuration.
3. Restore the matching media directory.

```powershell
npm run media:backup -- restore "X:\privateflix-backups\2026-11-07\media" "X:\privateflix-recovery\restore.env"
```

Restore verifies the archive and compares its owner, object references, sizes
and available checksums with the target database. It copies the files and reads
them back from the new bucket before switching the database references in a
single transaction. This lets you recover a library without access to the
original Drive folder. The restore clears old sessions, obsolete storage
cleanup jobs and provider upload handles from the restored database. Uploads
that were cancelled or failed before verification remain as history and have
no recovered file.

If copying fails, the new bucket may contain a partial private copy. Use a new
bucket name and a freshly restored database for a subsequent attempt. After a
successful restore, start the app and worker with the target configuration and
check a thumbnail, a photo or video, and a download before using it as your
main library.

Run `npm run test:backup` to exercise the command with disposable PostgreSQL and
MinIO, a simulated Drive connection, and synthetic files. It tests a mixed
library, download of retained Drive revisions, private restored objects, and
refusal of corrupted archives, mismatched databases and existing buckets.
