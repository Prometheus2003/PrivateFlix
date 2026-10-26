# PrivateFlix — Project Status

Updated: 2026-10-26.
Current work: Phase 6 original-file streaming and browser playback implemented and verified. Phase 7 richer frontend and library features are next. Optional HLS/transcoding remains disabled; production deployment is not yet complete.

## Implemented

- Single-owner setup, login/logout, session management, offline recovery, origin protection, durable throttling, nonce CSP, and private API responses.
- Private S3 storage with verified anonymous-deny policy, streamed uploads, paginated media listing, and authenticated resumable multipart upload APIs.
- Responsive owner interface with setup/sign-in, library metadata cards, upload progress, pause, resume across reloads, checksum validation, confirmed cancellation, and sign-out. File hashing uses bounded 8 MiB chunks; no auth secrets are stored in browser storage.
- Automatic maintenance while the Node app is running: expire eligible uploads after 24 hours of inactivity, execute delayed cleanup, recover interrupted jobs, and retry storage failures within bounds. Active uploads and successful media are protected.
- Zod upgraded to 4.6.7 to fix the reported runtime advisory. Full dependency audit currently has no findings.
- Separate constrained FFmpeg/FFprobe worker with Redis/BullMQ delivery, durable database jobs, lease-protected publication, bounded retries, checksum verification and processing states. Successful PNG/MP4 processing and corrupt-media failure verified against real services.
- Authenticated owner-only thumbnail streaming and responsive library thumbnails. Dimensions, codec and supported video duration/bitrate are recorded; object keys remain server-only. Enable the `processing` Compose profile to run the worker.
- Authenticated original-file streaming and downloads with byte ranges, seeking, suffix requests, HEAD, If-Range and private headers. Active transfers stop after session revocation/expiry or media deletion; browser cancellation closes storage streams.
- Responsive video/photo viewer with native playback controls, original download and keyboard dismissal. Browser playback, seeking, downloads and desktop/mobile layouts verified with real fixtures.

## Remaining

Phase 7: richer dashboard/library, organization, search/filtering, collections, favorites, history and settings. Optional transcoding and protected HLS remain unimplemented; keep `ENABLE_TRANSCODING=false`. Ready files can play when supported by the browser, with original download available for other codecs. Refresh the library to see completed processing.

Before production: reconcile orphaned multipart uploads and thumbnails, handle cleanup exhaustion and abandoned worker directories operationally, configure work-volume quotas, validate the full Linux deployment and TLS, and complete backup/restore and reliability checks. Frozen completion manifests remain available for explicit retry instead of automatic expiry. HEIC and unusual codec variants are not certified; unsupported files fail processing while preserving their originals.

## References

- [Owner workflow and maintenance](docs/OWNER_UPLOAD_WORKFLOW.md)
- [Media processing, operation and verification](docs/MEDIA_PROCESSING.md)
- [Streaming, playback and local preview](docs/STREAMING.md)
- [Multipart API contract](docs/MULTIPART_API.md)
- [Earlier security/storage verification](docs/SECURITY_STORAGE_PROGRESS.md) — historical; current behavior is described above.

Verification: 176 unit/database tests (including the final case-insensitive range test), 3 live MinIO tests, 3 live processing/range tests, and 14 production browser/API tests passed (196 total). Phase 6 database checks ran on PostgreSQL 16 in Docker; existing storage/upload/auth browser regressions ran against the separate PostgreSQL 18 test cluster. Production app build, typecheck, lint and formatting passed. Desktop and mobile player screenshots were visually reviewed. Dependencies are unchanged from the zero-finding Phase 5 audit. These results do not certify the unfinished production deployment or TLS.

Local preview on this workstation: `http://localhost:3000`, backed by the development Compose services. PostgreSQL uses host port 55432 because 5432 was occupied. The app and worker remain running; VS Code has the repository open. Owner setup uses the local `.env` setup token; no owner password is preselected.
