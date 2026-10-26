# PrivateFlix

Self-hosted, single-owner photo and video vault in development. Owner authentication, private uploads, resumable transfers, metadata/thumbnails, authenticated streaming and browser playback are implemented. Production deployment and the richer library features remain unfinished.

## Current state

See [PROJECT_STATUS.md](PROJECT_STATUS.md) for current results and remaining phases, [Owner workflow](docs/OWNER_UPLOAD_WORKFLOW.md) for uploading, and [Media processing](docs/MEDIA_PROCESSING.md) for the separate FFmpeg worker and authenticated thumbnails. [Architecture and remaining phases](docs/PHASE_1_REVIEW.md) describe the full target.

## Local setup

Use Node 24.15.0 / npm 11.12.1 and Docker Desktop with Linux containers. Run from the repository root:

```sh
npm ci
npm run env:init
npm run db:generate
docker compose up -d --build --wait
npm run db:deploy
npm run dev
```

Open http://localhost:3000. The app and backing service ports bind only to loopback. `env:init` refuses to overwrite an existing `.env`; on this working checkout a local configuration has already been generated. It contains unique development-only database/storage/Redis/session secrets and must stay untracked. `.env.example` contains placeholders only. On Windows restrict the `.env` ACL to your account; POSIX mode 0600 is requested by the generator but does not enforce Windows ACLs.

For playable uploads, enable the background worker with `docker compose --profile processing up -d worker`. See [streaming and local preview](docs/STREAMING.md) for setup, database-port conflicts, playback controls and supported scope.

The MinIO development image builds the upstream final security-release source at a pinned revision. Building requires internet access and can take several minutes. Community MinIO is archived; production backend selection remains deployment work. Anonymous object access is denied and tested. Development uses MinIO root credentials; production must provision a separate least-privilege identity.

The Compose stack does not run the app: use npm run dev. Keep Docker running for database-backed routes. No account or media is seeded. Redis uses a generated password, persistence and noeviction. Host ports must be free; do not remove an existing user's volumes to resolve conflicts.

## Database migrations

`npm run db:deploy` applies committed migrations to a new database, and is safe to repeat. For intentional schema development use `npm run db:migrate -- --name descriptive_change` and review the generated SQL. Do not use db:push for deployment. No reset or destructive migration command is part of the normal setup.

If you already have data from an earlier db:push, back it up and compare its schema with this initial migration before baselining. Do not mark migrations applied without checking that they match. See the Prisma v6 migration guide linked in the Phase 2 report.

## Checks

```sh
npm run db:validate
npm run db:generate
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Database tests require an explicitly configured disposable database named `privateflix_security_test`; they reset test records. Run `npm run test:integration` for those checks. `npm run test:storage` provisions disposable MinIO; with `PRIVATEFLIX_SECURITY_TEST=1` and the test database configured it also runs the production browser suite. The [processing verification runner](docs/MEDIA_PROCESSING.md) provisions all its own test services. Install Chromium with `npx playwright install chromium` before browser checks. These tests do not cover unfinished playback or production deployment.

## Build and startup

Local builds use Webpack and normal Next.js output for compatibility with the Windows sandbox. `npm start` binds loopback and requires a valid production configuration, including an HTTPS APP_URL. Use a TLS reverse proxy for actual production transport. `APP_URL` describes the external origin; the proxy may use local HTTP internally. Do not change NODE_ENV to bypass production validation.

Dockerfile has runtime and migrate targets. It opts into standalone Linux packaging, excludes `.env` and media from the build context, runs the app as a non-root user and includes a database-backed health check. Supply secrets only at runtime. The app container remains unverified; the separate processing worker container has passed live integration tests. The production Compose/Caddy setup belongs to Phase 9.

```sh
docker build --target runtime -t privateflix:dev .
docker build --target migrate -t privateflix-migrate:dev .
```

Before running a container, set DATABASE_URL, REDIS_URL and S3_ENDPOINT to service names reachable on its private Docker network, and APP_URL to the HTTPS public/private-network origin. Loopback addresses in the generated host-development .env do not work for container-to-container connections.

## Troubleshooting

- Missing Docker: install/start Docker Desktop, then run `docker version` before Compose.
- Invalid environment: errors list field names only. Replace placeholders and check URL protocols, limits and HTTPS APP_URL; never paste credentials into issue reports.
- Database unavailable: check `docker compose ps`, confirm port/credentials, then run db:deploy. Health returns 503 while PostgreSQL is unreachable.
- Windows junction/package-copy error: use the default Webpack local build. Standalone packaging is selected only by PRIVATEFLIX_STANDALONE=true inside the Linux Docker build.
- npm audit findings: review docs/PHASE_2_FOUNDATION.md. Do not run npm audit fix --force blindly; it proposes incompatible framework/ORM/storage changes.

## Security and upload development

Authentication, recovery and initial streaming upload ingestion are implemented. See [the current security/storage report](docs/SECURITY_STORAGE_PROGRESS.md) for setup-token requirements, endpoint contracts, verification and remaining phase work. The UI is not yet the completed product.

Use npm run test:integration only with a disposable database named privateflix_security_test; the suite resets test records. npm run auth:recover is an offline server command with hidden password prompts.

The owner setup, sign-in, resumable upload interface, and automatic upload maintenance are implemented. See [Owner workflow](docs/OWNER_UPLOAD_WORKFLOW.md) and [Project status](PROJECT_STATUS.md) for current capabilities and remaining processing/deployment work.

Google Drive can store new media and thumbnails after you authorize your Google
account. Existing local files continue using MinIO; active uploads still need
temporary local disk. The owner dashboard shows the configured destination and
setup steps. Follow [Google Drive setup](docs/GOOGLE_DRIVE.md) and run
`npm run drive:connect -- "path/to/downloaded-oauth-client.json"` on your computer.
Live Google account verification is required before using it for a large library.
