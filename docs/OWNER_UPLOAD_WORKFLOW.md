# Owner upload workflow

Updated 2026-10-25.

The starter homepage has been replaced with a responsive owner interface. First run shows setup with the server-held setup token; later visits show sign-in. Authenticated owners see a paginated media list and an upload panel. No credentials or session tokens are persisted in browser storage.

Uploads calculate SHA-256 incrementally in 8 MiB chunks, then send fixed-size parts sequentially. Pause stops the current request. After a refresh, the owner can select the same local file to resume; its full checksum must match the persisted upload. Confirmed parts are checked and skipped. Frozen completion manifests offer a separate verification retry. Cancelling an upload requires a confirmation dialog. Signing out clears the visible library.

The media cards show metadata and processing state, not fake thumbnails or playback. Uploaded media is awaiting the Phase 5 processing worker.

## Maintenance

The Node app starts a maintenance timer once per process through Next instrumentation. It runs every minute while the application is running, with no overlapping passes in one process. Each pass considers at most 100 abandoned uploads and 20 cleanup jobs; database claims coordinate cleanup across processes.

Multipart uploads inactive for 24 hours are cancelled if no active operation lease or frozen completion manifest exists. Expiration and cleanup intent are persisted atomically. Cleanup waits 30 minutes to allow in-flight requests to settle, aborts the stored multipart upload, and removes the failed original object. Successful media and active uploads are never deleted by this cleanup path. Storage failures retry after 30 minutes, up to the job retry limit (normally three). A cleanup worker interrupted for over an hour can be reclaimed. Exhausted jobs remain FAILED for operator inspection; records and opaque keys remain available for audit.

This scheduled pass requires a long-running Node deployment; it is not a serverless scheduler. Shutdown stops it and the next running instance resumes durable jobs.

## Remaining production work

An interruption before an S3 multipart ID is saved can still leave storage-only orphan parts. S3 lifecycle rules or storage reconciliation remain required before production deployment. Frozen completion manifests are deliberately preserved for verification retries instead of automatically deleted. Cleanup failure alerting, manual retry controls, backup/restore, and full Linux deployment validation remain part of reliability work.

## Verification

The unit/database suite covers incremental hashing, pause, expiration, active lease protection, frozen manifest protection, idempotent cleanup, successful media protection, retry limits, and private pending-upload listing. Browser coverage uses real isolated PostgreSQL and MinIO for setup, uploading 11 MiB, pausing after the first part, reloading, resuming, confirmed cancellation, desktop/mobile layout, logout, and login. The local HTTP test runner models canonical HTTPS proxy headers; this does not certify the production TLS/Caddy deployment.

The runtime validation dependency was upgraded to Zod 4.6.7 to resolve its reported memory-exhaustion advisory. The full dependency audit is clean at this verification date.
Final verification: 156 tests passed across unit/database, live storage, and browser suites. Production build, typecheck, lint, formatting, and full dependency audit passed.
