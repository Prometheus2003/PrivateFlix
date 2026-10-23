# Phase 2 — foundation implementation and verification

Date: 2026-10-22. Repository baseline: 891c418. Implementation is in place; the phase is not fully signed off because final production packaging and Docker execution remain unverified.

## What changed

- Exact direct dependency versions and synchronized lockfile; Node 24.15.0 / npm 11.12.1 recorded. Vitest upgraded from 3.2.7 to 5.0.5 to remove critical test-tool advisories.
- Added Prettier configuration, formatting scripts and LF policy; applied a baseline formatting pass. Formatting-only changes in existing auth/resource helpers do not represent completed Phase 3 security work.
- Added a pure environment schema and server-only cached accessor, invoked by Next instrumentation. Invalid configuration reports field names only and terminates the process. Next's default behavior after an instrumentation exception left its listener alive, so explicit termination is intentional.
- Session limits, rate-limit settings, media limits and storage configuration now use validated values. Removed fallback storage credentials and corrected HTTP S3 endpoints without a port to use port 80. Disabled Prisma development query logging.
- Added an exclusive-create local environment generator with unique random credentials. It neither prints secrets nor overwrites existing files. Expanded ignored environment variants and Docker exclusions.
- Added the initial versioned PostgreSQL migration and db:deploy/db:validate scripts. No owner account or media is seeded; singleton owner enforcement remains Phase 3 work.
- Bound development PostgreSQL/MinIO/Redis ports to loopback, removed shared passwords, enabled Redis authentication and noeviction, and retained persistent volumes/health checks.
- Pinned PostgreSQL 16.15, Redis 7.4.11, Node and storage-build base images by registry-verified digest. Added application runtime/migration Docker targets and a non-root runtime. No container was built or run here.
- Added a local MinIO source-build recipe at upstream security-release revision 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a. This avoids using the older published binary release. Community MinIO is archived; production storage selection and anonymous-denial tests remain Phase 4 gates.
- Removed Google font build fetches, added local fonts and basic app metadata/no-index metadata. The homepage remains a starter pending Phase 7.
- Switched from Turbopack to Webpack/PostCSS because the sandbox denied Turbopack junction creation. Standalone output is enabled only in the Linux container build.

## Verification evidence

| Check                                                                 | Actual result                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Clean npm ci --no-audit --no-fund, lifecycle scripts enabled          | Passed; 488 packages installed                                                                                 |
| Prisma client generation                                              | Passed, 6.19.3                                                                                                 |
| Prisma schema validation                                              | Passed                                                                                                         |
| Manifest versus installed lockfile versions                           | Passed                                                                                                         |
| Native Argon2 hash/verify smoke                                       | Passed                                                                                                         |
| Final development startup smoke                                       | Passed: invalid configuration exits/redacts; homepage 200; anonymous session 401/no-store; database health 200 |
| Configuration and environment-generator unit tests                    | 23 passed across 2 files                                                                                       |
| Initial migration on isolated local PostgreSQL 18                     | Passed                                                                                                         |
| Repeat migration                                                      | Passed, no pending migrations                                                                                  |
| Prisma database/schema drift comparison                               | Passed, no difference                                                                                          |
| Registry manifests for all five pinned base images                    | HTTP 200; digests recorded in Dockerfiles/Compose                                                              |
| npm audit after Vitest upgrade                                        | 0 critical, 8 high, 4 moderate; NOT a clean audit                                                              |
| Initial Webpack production build                                      | Passed before the explicit invalid-startup termination fix                                                     |
| Final production rebuild                                              | Blocked by Windows EPERM creating generated .next directories; no final-build pass claimed                     |
| Linux standalone packaging / Docker Compose / PostgreSQL 16 container | Not executed: Docker is unavailable                                                                            |
| Storage privacy, worker/media functionality, browser/security suite   | Not executed; belong to subsequent phases                                                                      |

Fresh isolated PostgreSQL testing used loopback port 55432, outside the user's existing database instance. The temporary server was stopped after checks. It verifies migration compatibility with PostgreSQL 18, not the pinned PostgreSQL 16 container.

The first migration attempt failed because the sandbox terminated a server launched in a previous command. Repeating startup, migration and shutdown within one bounded command passed. Initial Turbopack and standalone build attempts failed on Windows junction/copy permissions. A subsequent ordinary Webpack build passed; after the startup fix, final rebuilds hit EPERM in generated directories even with a fresh output directory. Those failures are retained as verification limits rather than counted as successes.

## Dependency audit disposition

Remaining high findings involve Prisma's tooling dependency deepmerge-ts and the ESLint/Next glob chain (braces/micromatch/fast-glob). Moderate findings involve the MinIO client's query-string/decode-uri-component and stream-json chain. The audit's suggested fixes include major Prisma changes and framework/storage downgrades. They were not applied automatically because they require compatibility work and live integration tests. These findings remain open and prevent a production-readiness claim. The Phase 4 typed storage-adapter replacement should remove reliance on MinIO SDK private multipart methods and reassess its dependencies. Do not expose the current app publicly.

## Files created

- .dockerignore, .gitattributes, .nvmrc, .prettierignore, .prettierrc.json
- Dockerfile, deploy/Dockerfile.minio, postcss.config.mjs
- prisma/migrations/migration_lock.toml
- prisma/migrations/20261022000000_initial/migration.sql
- scripts/init-env.mjs
- src/instrumentation.ts
- src/lib/validation/env-schema.ts
- tests/unit/env.test.ts, tests/unit/init-env.test.ts
- docs/PHASE_2_FOUNDATION.md

## Files changed

Functional/configuration changes: package.json, package-lock.json, next.config.ts, docker-compose.yml, .env.example, .gitignore, eslint.config.mjs, tsconfig.json, src/app/layout.tsx, src/app/globals.css, src/lib/validation/env.ts, src/lib/auth/{session,require-auth,rate-limiter}.ts, src/lib/db/prisma.ts, src/lib/storage/{s3,index}.ts, src/lib/media/validator.ts, README.md, PROJECT_STATUS.md and the Next version note in AGENTS.md.

The Prettier baseline also reformatted existing auth route handlers, the health route, starter page and remaining library modules. The previous Phase 1 review is preserved.

## Next operator commands

Install/start Docker Desktop with Linux containers, then run from the repository root:

```powershell
docker version
docker compose up -d --build --wait
npm.cmd run db:deploy
npm.cmd run dev
```

This checkout already has a generated ignored .env. For a fresh source download, first run npm ci, npm run env:init and npm run db:generate. Never copy real credentials into GitHub or a chat.

On an unrestricted host, rerun npm run build and build both Docker targets from README.md. Phase 2 remains pending these packaging/service checks and the recorded dependency-risk disposition. Phase 3 will implement and test singleton setup, origin checks, rate-limit concurrency, atomic session/password changes, secure headers and recovery; these are not silently marked complete here.

## Reference checks

- [Next.js instrumentation lifecycle](https://nextjs.org/docs/pages/api-reference/file-conventions/instrumentation): runtime validation hook.
- [Prisma v6 migration workflow](https://docs.prisma.io/docs/orm/v6/prisma-migrate/getting-started): versioned initial migration.
- [PostgreSQL 16.15 release](https://www.postgresql.org/docs/16/release-16-15.html): selected PostgreSQL 16 patch release.
- [MinIO release/archive status](https://github.com/minio/minio/releases): final security release and maintenance limitation.
