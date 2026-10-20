# PrivateFlix — Agent Instructions

> This file contains architecture decisions, security rules, coding conventions, and workflow
> guidelines for AI assistants working on the PrivateFlix project.

## Project Identity

- **Name:** PrivateFlix (configurable via `APP_NAME` env var)
- **Type:** Self-hosted, single-owner personal media streaming platform
- **Primary requirement:** Privacy — only the authenticated owner can access anything

## Architecture Overview

- **Framework:** Next.js 15 (App Router) with TypeScript strict mode
- **Database:** PostgreSQL 16 via Prisma 6 ORM
- **Object Storage:** MinIO (S3-compatible, private bucket, no public access)
- **Job Queue:** BullMQ + Redis
- **Media Processing:** FFmpeg/FFprobe (containerized)
- **Auth:** Argon2id + server-side sessions + HttpOnly cookies
- **Reverse Proxy:** Caddy (automatic HTTPS)

## Critical Security Rules

### NEVER do these:
1. **NEVER** expose storage credentials or internal object keys to the client
2. **NEVER** create public presigned URLs for media
3. **NEVER** store passwords or session tokens in localStorage/sessionStorage
4. **NEVER** trust a media ID as proof of ownership — always check `ownerId === user.id`
5. **NEVER** interpolate untrusted input into shell commands — use argument arrays
6. **NEVER** load entire large files into memory — stream them
7. **NEVER** place media files in `/public` or any static directory
8. **NEVER** create a public registration endpoint
9. **NEVER** return different error messages for "user not found" vs "wrong password"
10. **NEVER** log passwords, session tokens, or sensitive media content
11. **NEVER** skip auth checks on thumbnail, stream, download, or HLS segment routes
12. **NEVER** commit `.env` files, credentials, or secrets to version control

### ALWAYS do these:
1. **ALWAYS** call `requireAuth()` at the start of every protected API route
2. **ALWAYS** verify `resource.ownerId === user.id` before returning any resource
3. **ALWAYS** validate input with Zod schemas before processing
4. **ALWAYS** hash session tokens with SHA-256 before storing in the database
5. **ALWAYS** set `Cache-Control: private, no-store` on protected responses
6. **ALWAYS** use `crypto.randomBytes(32)` for session tokens
7. **ALWAYS** use Argon2id for password hashing (not bcrypt, not SHA-256)
8. **ALWAYS** run FFmpeg with timeouts and resource limits
9. **ALWAYS** generate opaque server-side storage keys (not user-supplied filenames)
10. **ALWAYS** check the `appInitialized` flag before allowing setup
11. **ALWAYS** return 404 (not 403) for resources the user doesn't own (prevent enumeration)
12. **ALWAYS** use parameterized queries (Prisma handles this)

## Coding Conventions

### TypeScript
- Strict mode enabled (`"strict": true`)
- No `any` types — use `unknown` and narrow
- Prefer `interface` for object shapes, `type` for unions
- Export types from `src/types/`
- Use Zod schemas for runtime validation, infer types with `z.infer<>`

### File Organization
- Server-only code in `src/lib/` — never import in client components
- Client components use `'use client'` directive
- API routes in `src/app/api/` using Next.js Route Handlers
- Shared React components in `src/components/`
- Custom hooks in `src/hooks/`

### API Routes
```typescript
// Standard pattern for protected API routes
export async function GET(request: NextRequest) {
  const { user } = await requireAuth(request);
  // ... validate input with Zod
  // ... query database with ownership check
  // ... return response
}
```

### Database Queries
- Always include `ownerId` in WHERE clauses for user-owned data
- Use transactions for multi-step operations
- Use `select` to limit returned fields
- Paginate all list queries (default: 20 items, max: 100)
- Index frequently queried columns

### Error Handling
- Use consistent error response format: `{ error: string, code?: string }`
- Return appropriate HTTP status codes
- Never expose stack traces in production
- Log errors server-side with context (but not secrets)

### Component Conventions
- Use shadcn/ui as the component base
- Dark theme with configurable accent color
- All interactive elements need keyboard accessibility
- All images need alt text
- Use loading skeletons, not spinners
- Use confirmation dialogs for destructive actions
- Use toast notifications for success/error feedback

## Environment Variables
- Validated at startup with Zod (`src/lib/validation/env.ts`)
- Development defaults in `.env.example`
- Production values in `.env` (never committed)
- Access via validated config object, not raw `process.env`

## Testing Strategy
- **Unit tests (Vitest):** Auth logic, validation, storage adapter, media processing
- **Integration tests (Vitest):** API routes with real database
- **E2E tests (Playwright):** Full user flows through the browser
- Run tests before merging or deploying
- Never claim a test passed without executing it

## Phase Workflow
1. Check `PROJECT_STATUS.md` for current state
2. Work on the current phase only
3. Create/modify files incrementally
4. Run tests and commands after each change
5. Update `PROJECT_STATUS.md` after completing work
6. Get approval before moving to the next phase

## Docker Services (Development)
```
PostgreSQL: localhost:5432
MinIO:      localhost:9000 (API), localhost:9001 (Console)
Redis:      localhost:6379
App:        localhost:3000
```

## Key Files to Check
- `prisma/schema.prisma` — Database schema
- `src/lib/auth/require-auth.ts` — Central auth check
- `src/lib/storage/adapter.ts` — Storage interface
- `src/lib/validation/env.ts` — Environment validation
- `docker-compose.yml` — Service configuration
- `.env.example` — Required environment variables
