# Owner upload workflow

Updated 2026-10-28.

The starter homepage has been replaced with a responsive owner interface. First run shows setup with the server-held setup token; later visits show sign-in. Authenticated owners see a paginated media list and an upload panel. No credentials or session tokens are persisted in browser storage.

Uploads calculate SHA-256 incrementally in 8 MiB chunks, then send fixed-size parts sequentially. Pause stops the current request. After a refresh, the owner can select the same local file to resume; its full checksum must match the persisted upload. Confirmed parts are checked and skipped. Frozen completion manifests offer a separate verification retry. Cancelling an upload requires a confirmation dialog. Signing out clears the visible library.

The media cards show processing state, private thumbnails and playback for ready
media. The constrained processing worker verifies originals and generates
metadata/thumbnails. Verified originals with terminal processing failures can be
retried from their cards; see [Library workflows](LIBRARY_WORKFLOWS.md).

## Batch upload and history

The upload panel has **Single file / resume** and **Batch upload** modes. Batch
upload accepts a file picker or drag/drop, with up to fifty files per queue. It
checks formats and the server's configured size limit before transfer, then hashes
and uploads one file at a time using the same resumable helper as single uploads.
Each file shows its state and progress; the aggregate shows saved bytes. Hashing
progress is separate from uploaded bytes, and transfer progress advances at part
boundaries. Failures remain visible and can be retried individually. Pause stops
the current operation and leaves later files queued.

The batch queue warns when a verified original with the same SHA-256 and length
already exists. Choose **Upload duplicate** to create a separate private original,
or remove that selection from the queue. Existing files are never overwritten.
An exact matching paused upload is resumed instead of starting another upload;
ambiguous matches require selecting the saved upload below. Duplicate detection
is an owner-only warning, not a global content oracle or a storage deduplication
mechanism. The single-file path retains its direct upload behavior.

File selections stay in the browser tab and are released after success. They are
not saved to browser storage or automatically restored after reload. Saved parts
and checksums persist server-side; **In progress** can resume after reselecting the
original file. Removing an entry from the local queue preserves saved parts.
Cancel the saved upload through its confirmation dialog to remove those parts.

**Upload history** opens a paginated, owner-only list of transfers, dates, byte
counts, current processing states and safe failure explanations. It omits storage
keys, provider identifiers, internal errors and expected checksums. Removed media
has no title/reference in this view. Refresh history to see later worker outcomes.
Setup/sign-in also provide an explicit password visibility toggle.

`POST /api/media/duplicates` accepts `{checksum, totalBytes}` and returns only
`{duplicate}`. It requires authentication, canonical origin and strict validation.
`GET /api/media/upload-history` accepts `page` and `limit` (default twenty, maximum
one hundred). Both return private, noncached responses.

## Maintenance

The Node app starts a maintenance timer once per process through Next instrumentation. It runs every minute while the application is running, with no overlapping passes in one process. Each pass considers at most 100 abandoned uploads and 20 cleanup jobs; database claims coordinate cleanup across processes.

Multipart uploads inactive for 24 hours are cancelled if no active operation lease or frozen completion manifest exists. Expiration and cleanup intent are persisted atomically. Cleanup waits 30 minutes to allow in-flight requests to settle, aborts the stored multipart upload, and removes the failed original object. Successful media and active uploads are never deleted by this cleanup path. Storage failures retry after 30 minutes, up to the job retry limit (normally three). A cleanup worker interrupted for over an hour can be reclaimed. Exhausted jobs remain FAILED for operator inspection; records and opaque keys remain available for audit.

This scheduled pass requires a long-running Node deployment; it is not a serverless scheduler. Shutdown stops it and the next running instance resumes durable jobs.

## Remaining production work

An interruption before an S3 multipart ID is saved can still leave storage-only orphan parts. S3 lifecycle rules or storage reconciliation remain required before production deployment. Frozen completion manifests are deliberately preserved for verification retries instead of automatically deleted. Cleanup failure alerting, manual retry controls, backup/restore, and full Linux deployment validation remain part of reliability work.

## Verification

The unit/database suite covers incremental hashing, pause, expiration, active lease protection, frozen manifest protection, idempotent cleanup, successful media protection, retry limits, and private pending-upload listing. Browser coverage uses real isolated PostgreSQL and MinIO for setup, uploading 11 MiB, pausing after the first part, reloading, resuming, confirmed cancellation, desktop/mobile layout, logout, and login. The local HTTP test runner models canonical HTTPS proxy headers; this does not certify the production TLS/Caddy deployment.

The runtime validation dependency was upgraded to Zod 4.6.7 to resolve its reported memory-exhaustion advisory. The full dependency audit is clean at this verification date.
Historical 2026-10-25 verification: 156 tests passed across unit/database, live
storage, and browser suites. Production build, typecheck, lint, formatting, and
full dependency audit passed. Current verification checkpoints are recorded in
[Project status](../PROJECT_STATUS.md).
