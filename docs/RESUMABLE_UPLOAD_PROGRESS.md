# Phase 4: upload progress and resumable foundations

Updated: 2026-10-25.

The preceding security/storage work was pushed to main in commit 123ee4e. This increment keeps the existing streaming upload behavior and adds the following building blocks.

- `GET /api/media/upload/:id?page=1` requires a live owner session and returns upload status, committed byte count, media ID, timestamps, and up to 100 part receipts. Responses are private/no-store. Invalid queries return 400 and missing or unowned uploads return 404. Internal storage keys, multipart IDs, and ETags are never selected for this response.
- The additive `20261023000000_upload_parts` migration preserves existing uploads. A nullable part size distinguishes the existing single-request flow. Multipart receipts have a composite primary key, bounded part numbers/lengths, a SHA-256 format constraint, and cascade deletion with the upload. These constraints do not replace endpoint checks for ownership, state, or total length.
- `readUploadPart` buffers at most one fixed 8 MiB part, checks exact boundaries and SHA-256, validates the first part's media signature, and cancels stalled reads through an abort signal. Future callers must combine the request signal with a deadline and enforce concurrency before reading. Existing single-request uploads continue to stream.
- Progress for existing single-request uploads changes at finalization; it does not yet provide live byte-by-byte progress.

## Verification

The migration deployed successfully to the isolated `privateflix_security_test` database on PostgreSQL 18. All 121 unit/database tests passed, including 30 new tests covering boundary calculations, malformed/truncated/changed data, cancellation, authenticated progress, pagination, receipt uniqueness, database constraints, and cascade deletion. A separate live run passed all three MinIO tests and all 12 production Chromium/API tests, including the new progress endpoint. Production build, type checking, lint, and formatting passed. Total: 136 tests passed across the three suites.

## Next implementation

Connect authenticated multipart start, part PUT, completion, and cancellation endpoints. Before enabling them, implement durable state transitions that serialize completion/cancellation with in-flight writes, idempotent retries, expiration and orphan cleanup, and server-side verification of the completed object. Recheck the session before finalization. Keep opaque S3 IDs and ETags server-side and bypass Next proxy body buffering for binary part requests. Add real PostgreSQL/MinIO concurrency and interrupted-request tests, then expose the flow in the frontend.

The schema and chunk reader alone do not make resumable uploads available. Processing workers, playback, frontend screens, backup/restore, and production deployment also remain unfinished.

## Storage regression fixed during verification

The first live rerun exposed an intermittent failure: exact JSON comparison treated reordered policy resources as different. The adapter now sorts only resource arrays before comparison and preserves every other policy field. Tests cover reversed resource order and reject changed grants, missing or duplicated resources, changed conditions, and extra statements. Live storage and anonymous-access checks passed after the fix.
