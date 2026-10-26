# Resumable upload API

Implemented 2026-10-25. This supersedes the endpoint backlog in RESUMABLE_UPLOAD_PROGRESS.md. The browser upload UI and maintenance of recorded uploads are now implemented; see OWNER_UPLOAD_WORKFLOW.md for current behavior and storage-only orphan limitations.

All operations require the owner's live session cookie. Mutations also require the exact configured APP_URL origin. Responses are private/no-store, and storage keys, multipart IDs, and ETags remain server-side.

1. POST `/api/media/upload/start` with JSON `{ filename, mime, totalBytes, checksum }`. The checksum is the full file's lowercase SHA-256 hex digest. The response contains `uploadId`, `mediaId`, `partSize` (8 MiB), and `partCount`. At most three uploads may be active across the existing streaming and multipart flows.
2. PUT `/api/media/upload/:id/parts/:part` with a raw binary body, `Content-Type: application/octet-stream`, exact `Content-Length`, and `X-Part-Sha256` containing that part's lowercase SHA-256. Part numbers begin at one. Every part except the final one must be exactly 8 MiB. Parts may arrive out of order; send one request at a time per upload.
3. GET `/api/media/upload/:id?page=1` to resume. Each page contains up to 100 confirmed receipts, with part number, size, and checksum. Pending writes are excluded. Compare these receipts with the selected local file before sending missing parts. Changed bytes cannot replace a previously reserved part; start a new upload instead.
4. POST `/api/media/upload/:id/complete` with no body. All receipts must exist. The server freezes the manifest, completes S3 assembly, streams the complete object through length, signature, and whole-file checksum verification, rechecks authentication, and atomically marks it UPLOADED with one metadata job. Completion can be retried after a lost response. UPLOADED does not mean the media is decoded or ready for playback.
5. POST `/api/media/upload/:id/cancel` with no body. Cancellation is repeatable, marks the upload terminal, records cleanup intent, and attempts S3 abort/deletion. Once completion starts, retry completion instead; an object that fails verification becomes FAILED and can then be cancelled.

## Concurrency and recovery

A database operation token serializes requests across application instances before buffering part bodies. Busy operations return 409 and Retry-After. A 30-minute initial lease permits cloud promotion and recovery after a process dies. Completion renews its fenced lease for another 15 minutes before whole-file verification. Every write is fenced by its token; a late request cannot commit progress under a replaced lease. Part checksums are saved before S3 writes and remain immutable, so late storage retries cannot replace a part with different content. Confirmed retries do not increment the byte counter or rewrite storage.

Part reads have a two-minute deadline and use at most one 8 MiB buffer per active upload. Final object verification streams with a ten-minute deadline. A revoked session cannot commit a part receipt or finalize media. Retry an interrupted part with identical bytes. After completion has started, only completion retries are accepted; part writes are frozen.

The binary routes live below the existing proxy exclusion for `/api/media/upload`, avoiding Next proxy body buffering. Authentication and origin checks run in the handlers.

## Remaining reliability work

Cleanup jobs run automatically while the Node app is running. Eligible multipart uploads expire after 24 hours of inactivity; frozen completion manifests are preserved for retry. See OWNER_UPLOAD_WORKFLOW.md for delays, retry limits, and deployment requirements. An interruption between S3 multipart creation and recording its ID can leave orphaned S3 parts; bucket lifecycle/reconciliation must be configured before production deployment. S3 abort races with an already in-flight write also require repeated cleanup. These limitations are not a claim of production readiness.

## Validation

The additive database migration was applied on the isolated PostgreSQL 18 test database. Unit/database coverage includes out-of-order parts, duplicate receipts, transport failures, changed retries, incomplete manifests, checksum failure, lost completion responses, concurrent cancellation, expired-lease fencing, session revocation, and active-upload limits. The production HTTP scenario uploads an 11 MiB file in two parts, retries a confirmed part, resumes progress, completes twice, checks the persisted checksum, and checks anonymous object denial against real MinIO.
Verification result: 132 unit/database tests, 3 live MinIO tests, and 12 production Chromium/API tests passed (147 total). Production build, typecheck, lint, and formatting passed.
