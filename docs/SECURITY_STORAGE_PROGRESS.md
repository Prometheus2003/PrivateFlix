# PrivateFlix — Security and storage progress

Updated: 2026-10-23 (Asia/Dhaka).

The source checkout is now work/PrivateFlix in the new PrivFlix workspace. The previous checkout is retained. All prior uncommitted source changes were copied; no changes were pushed to GitHub.

## Phase 3 — Authentication backend

Implemented one-owner setup with a server-held bootstrap token, an advisory transaction lock, and a database uniqueness/check constraint. Setup creates the owner, initialization flag, session and audit record atomically.

All auth mutations enforce the canonical APP_URL origin. JSON auth bodies are bounded to 8 KiB and a 10-second read deadline. Opaque 256-bit session tokens are stored only as SHA-256 hashes, expire by idle and absolute deadlines, and rotate at login and password changes. Credential changes, replacement sessions and revocation share a transaction lock. Unknown logins verify the real owner's hash and return the same failure as a wrong password.

PostgreSQL persists and serializes rate-limit reservations across processes. Fixed global scopes prevent attackers from bypassing limits using forged forwarded-IP headers. The default is five attempts per 15 minutes per operation, including successful attempts. This single-owner tradeoff can temporarily lock out the owner; trusted-proxy IP attribution is deliberately not enabled. Offline recovery also clears throttle records.

Added safe active-session listing, password-confirmed session revocation, password-confirmed logout everywhere, and an offline recovery command. ORM and auth failures do not log credential-bearing query inputs.

Nonce-based CSP is passed to Next.js rendering and returned on responses. Pages render dynamically, use private/no-store caching, and receive frame protection, no-sniff, no-index, permissions and referrer headers. Production adds HSTS and Secure session cookies.

### Setup and recovery

1. Run npm run env:init for a new installation; it exclusively creates .env with random secrets and SETUP_TOKEN. Existing configuration is never overwritten.
2. For an existing .env, generate a random 32-byte hexadecimal SETUP_TOKEN using a secret manager and add it privately. Missing SETUP_TOKEN disables setup.
3. POST JSON containing email, username, password and confirmPassword to /api/auth/setup with an Origin equal to APP_URL and X-Setup-Token. Remove the token from the environment after setup and restart. Setup still rejects additional owners at the database level.
4. For recovery, run npm run auth:recover on the server with its database configuration. The terminal prompts hide both password entries. It changes the sole owner's password and revokes all sessions in one transaction. There is no public password-reset endpoint. Automation can pipe a bounded JSON object with password and confirmPassword to npm run auth:recover -- --stdin; do not place passwords in command arguments or shell history.

Apply migrations with npm run db:deploy before starting this version. The owner-slot migration intentionally fails on a legacy database with multiple owners; it never deletes accounts.

## Phase 4 — Private storage and ingestion

Replaced the MinIO JavaScript SDK and its undocumented multipart calls with the typed AWS S3 client and managed streaming upload helper. The backend remains S3-compatible MinIO.

The adapter applies and reads back a bucket policy denying all anonymous operations. A policy failure blocks data operations. It supports streamed writes/reads, conditional ranged reads, supported multipart commands, bounded delete batches and explicit partial-delete errors. Missing-object results are distinguished from authorization or network errors.

POST /api/media/upload now accepts a raw binary body with Content-Type, Content-Length and URI-encoded X-Filename. It requires an owner session and same-origin request. Filenames are display-only; storage paths use server-generated UUIDs. Three concurrent uploads are allowed, each with a ten-minute deadline. The stream checks signatures and exact byte counts, calculates SHA-256, and retains a bounded header buffer. It does not load whole media files into memory.

Unknown or mismatched signatures are rejected, including mismatches between PNG/JPEG, RIFF/WebP/AVI and HEIC/MP4. These conservative signature checks are an ingestion gate, not proof a file can be decoded; successful items remain UPLOADED until the processing phase inspects them.

The server persists media/upload records and durable metadata jobs. It revalidates the session before finalizing. Failures retain an opaque storage key and durable cleanup job, then attempt immediate deletion. Cleanup execution and crash recovery belong to the processing/reliability phases; a process crash can leave a pending upload requiring that worker.

GET /api/media returns owner-filtered, paginated safe metadata. No object keys, storage URLs or credentials appear in its responses.

Remaining Phase 4 work: resumable client upload orchestration, complete upload-progress/cancellation APIs, and resumable-upload failure recovery. Media processing, protected playback and application screens remain later phases; the homepage is still the starter.

## Verification

- Production npm run build passed in the new workspace with approved execution outside the Windows sandbox. This resolves the prior EPERM build blocker.
- 91 unit/database-backed tests passed against an isolated PostgreSQL 18 cluster.
- 12 production Chromium/API tests passed, including owner setup, HttpOnly/SameSite/Secure cookie assertions, session lookup, logout-all, and CSP.
- Production startup/configuration tests passed, including fail-closed invalid configuration.
- Runtime dependency audit previously passed with zero findings. Five development-tooling findings remain in the Next ESLint → fast-glob → micromatch → braces chain; the registry had no patched braces release. The Prisma deepmerge override was checked through generation, migrations and schema validation.
- Docker engine access now works with approved execution. The pinned MinIO development image built successfully. All three live adapter tests passed: stream/range round trips, multipart completion/abort, and anonymous object/list denial. An initial live failure revealed that this MinIO release requires the lowercase aws:principaltype condition key; that compatibility bug was fixed.
- PostgreSQL 16/container-stack, full Linux deployment, processing, playback, restoration and complete product flows are not yet signed off.

Run unit tests with npm test. Integration tests are skipped unless explicitly enabled. npm run test:integration requires DATABASE_URL pointing at a disposable database named privateflix_security_test; it resets test records there. Apply migrations to that database first. Live MinIO tests are separately opt-in and require the isolated loopback endpoint on port 19000.

## Implementation references

The policy uses Anonymous and the exact lowercase condition key supported by the pinned MinIO dependency: [MinIO condition-key source](https://raw.githubusercontent.com/minio/pkg/v3.1.3/policy/condition/keyname.go). Only this MinIO backend has been live-tested; other S3-compatible backends still require compatibility verification. S3 operations use the [AWS JavaScript SDK v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/).

Binary uploads bypass Next.js Proxy body cloning. Authentication, origin checks and no-store responses remain enforced in the upload route; common security headers are applied through Next configuration. This avoids the proxy's default 10 MB in-memory buffer.

Run npm run test:storage after building the development MinIO image. The runner creates a loopback-only ephemeral container with random test credentials, runs adapter tests, and removes the container and credential file. If PRIVATEFLIX_SECURITY_TEST=1 and the disposable PostgreSQL database is configured, it also runs the production browser/API suite against real storage.

Final production integration result: all 12 Chromium/API checks passed against real PostgreSQL and MinIO, including an 11 MiB raw upload, exact SHA-256 checksum, safe metadata response and anonymous object denial. Combined with the 91 unit/database tests and 3 live storage tests, 106 tests passed. Test services were stopped and the ephemeral MinIO container removed afterward. The production build, typecheck and lint also passed; runtime npm audit reported zero vulnerabilities.
