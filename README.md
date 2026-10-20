# PrivateFlix 🎬🔒

A secure, self-hosted personal media streaming platform and photo/video vault. Designed with privacy as the first-class priority: single-owner access, authenticated streaming proxy, zero public links, and zero unauthorized metadata leaks.

---

## ⏸️ Current Status: PAUSED

> **Phase 2 (Foundation & Authentication)** is implemented and paused awaiting quota refresh.
> Type checking (`tsc --noEmit`) and linting (`eslint`) are fully passing with **0 errors and 0 warnings**.
> See [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) for full status and next phase roadmap.

---

## Architecture Overview

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript (Strict Mode)
- **Styling:** Tailwind CSS v4
- **Database:** PostgreSQL 16 via Prisma 6 ORM
- **Object Storage:** MinIO (Private S3-compatible bucket, zero public access)
- **Authentication:** Argon2id password hashing + SHA-256 hashed session tokens + HttpOnly cookies
- **Security:** Rate limiting with sliding-window lockouts, timing attack mitigation, central `requireAuth` ownership checks
- **Task Queue:** BullMQ + Redis
- **Media Engine:** FFmpeg/FFprobe (containerized)

---

## Quick Start (When Resuming)

### 1. Start Backing Services
```bash
docker compose up -d
```
Starts PostgreSQL (`localhost:5432`), MinIO (`localhost:9000` / Console `localhost:9001`), and Redis (`localhost:6379`).

### 2. Push Database Schema
```bash
npx prisma db push
```

### 3. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Scripts

- `npm run dev` — Run Next.js dev server with Turbopack
- `npm run build` — Build production bundle
- `npm run typecheck` — TypeScript check (`tsc --noEmit`)
- `npm run lint` — ESLint validation
- `npm run db:generate` — Generate Prisma client
- `npm run db:push` — Sync schema with PostgreSQL
- `npm run db:studio` — Open Prisma Studio browser
- `npm test` — Run Vitest unit & integration tests
- `npm run test:e2e` — Run Playwright end-to-end tests
