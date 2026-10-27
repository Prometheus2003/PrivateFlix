# PrivateFlix — Project Status

Updated: 2026-10-27.
Current work: Phase 7 library browsing and organization implemented using UI UX Pro Max guidance and the installed 21st MCP. Playback history/resume and account/session settings UI remain. Google Drive account authorization and a live Google upload/playback test are still required before enabling Drive on this workstation. Optional HLS/transcoding remains disabled; production deployment is not yet complete.

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
- Optional Google Drive destination for new uploads and thumbnails, with narrow owner OAuth access, a private folder, durable object/revision mapping, verified streaming promotion from MinIO, lost-response recovery and bounded cleanup of temporary local copies. Existing S3 media keeps its original provider. Drive download ranges, retained revisions, redirect credential boundaries and timeouts are tested with mocked Google responses; no real Google account has been connected yet.
- Owner-only storage settings panel with configuration status and setup guidance. Local connection command uses PKCE/state and saves credentials atomically in ignored `.env`; it preserves existing Drive connections and never prints tokens.
- Interactive library above the upload form: debounced literal search, video/photo/favorite/collection filters, stable sorting and pagination, grid/list layouts, saved favorites, collection creation/editing/membership and confirmed grouping-only deletion. Native accessible dialogs, mutation error feedback, responsive controls and quiet processing-status refresh are included. Organization APIs use existing database models; no migration is needed.

## Remaining

Remaining frontend work: playback history/resume and account/session settings. Tags, playlists, nested collections and bulk editing remain future work. Optional transcoding and protected HLS remain unimplemented; keep `ENABLE_TRANSCODING=false`. Ready files can play when supported by the browser, with original download available for other codecs. The library checks pending processing states every five seconds while visible and idle; manual Refresh also updates pending uploads.

Before production: reconcile orphaned multipart uploads and thumbnails, handle cleanup exhaustion and abandoned worker directories operationally, configure work-volume quotas, validate the full Linux deployment and TLS, and complete backup/restore and reliability checks. Frozen completion manifests remain available for explicit retry instead of automatic expiry. HEIC and unusual codec variants are not certified; unsupported files fail processing while preserving their originals.

## References

- [Owner workflow and maintenance](docs/OWNER_UPLOAD_WORKFLOW.md)
- [Media processing, operation and verification](docs/MEDIA_PROCESSING.md)
- [Streaming, playback and local preview](docs/STREAMING.md)
- [Google Drive storage and account setup](docs/GOOGLE_DRIVE.md)
- [Interactive library and organization API](docs/LIBRARY_ORGANIZATION.md)
- [Multipart API contract](docs/MULTIPART_API.md)
- [Earlier security/storage verification](docs/SECURITY_STORAGE_PROGRESS.md) — historical; current behavior is described above.

Phase 6 verification: 176 unit/database tests (including the final case-insensitive range test), 3 live MinIO tests, 3 live processing/range tests, and 14 production browser/API tests passed (196 total). Phase 6 database checks ran on PostgreSQL 16 in Docker; existing storage/upload/auth browser regressions ran against the separate PostgreSQL 18 test cluster. Production app build, typecheck, lint and formatting passed. Desktop and mobile player screenshots were visually reviewed. Dependencies are unchanged from the zero-finding Phase 5 audit. These results do not certify the unfinished production deployment or TLS.

Drive phase verification: 250 unit/database tests passed on isolated PostgreSQL 16, including mocked Drive/OAuth transport and durable registry concurrency/publication checks. Three live MinIO checks and three live processing/range checks passed. All thirteen production auth/upload/browser regressions passed; the additional playback/storage-panel scenario passed in both production and development (270 distinct checks overall). Production app and worker builds, type checking, lint, formatting and whitespace checks passed. Desktop/mobile synthetic-fixture screenshots were reviewed. The browser tests caught and resolved cold development endpoint timing and ambiguous status selectors; upload and storage announcements now have separate accessible labels. The additive migration is applied locally, the preview and updated worker are running, and existing owner/media data is preserved. Actual Google account access, capacity, uploads and playback remain unverified until the owner completes OAuth setup; Drive is not enabled in the workstation's `.env`.

Library phase verification: 274 unit/database tests passed on isolated PostgreSQL 16, including 24 organization/auth/concurrency checks. Three live MinIO and three live processing/range tests passed. Fourteen production auth/upload/library browser scenarios passed, plus the playback scenario in both production and development (295 distinct checks overall). The organization scenario also passed in development, covering failed-save feedback, focus restoration, persistence, collection editing and deletion preserving originals, 375px/390px phone layouts, landscape/list mode and reduced motion. Screenshot review caught and resolved a compressed phone collection heading; final desktop/mobile synthetic screenshots were reviewed. Production build/type checking, lint, formatting and whitespace checks passed. Existing storage and uploads were preserved, and dependencies/schema are unchanged in this phase. The new interface is available in the local preview; Google OAuth setup and the remaining frontend/deployment work above are still outstanding.

Local preview on this workstation: `http://localhost:3000`, backed by the development Compose services. PostgreSQL uses host port 55432 because 5432 was occupied. The app and worker remain running; VS Code has the repository open. Owner setup uses the local `.env` setup token; no owner password is preselected.

Playback follow-up: fixed a development-only Strict Mode lifecycle bug that removed the video's source. Verified the source is restored, the local stream returns 206, and the development browser playback/seek/download test passes. Processing verification now runs browser coverage in both development and production by default; the runner explicitly selects the matching Node environment. The accompanying 176 unit/database and 3 live processing tests also passed.
