# Private streaming and playback (Phase 6)

Ready media can now be opened from the library using **Play video** or **View photo**. The viewer supports the browser's native playback, seeking, volume and fullscreen controls, Escape/Close, and **Download original**. Unsupported browser formats show an explanatory message; the original remains downloadable. No external player or media service receives the file.

## HTTP contract

`GET` and `HEAD /api/media/{id}/stream` and `/api/media/{id}/download` require an active owner session. Unknown, other-owner, deleted and non-ready media return 404. Authentication runs before range parsing or metadata lookup. Downloads use attachment disposition and an encoded original filename.

- Normal GET returns 200 and a streamed body. HEAD returns metadata without opening an object body.
- Single `bytes=start-end`, open-ended and suffix ranges return 206 with exact `Content-Range` and `Content-Length`. End positions past EOF are clamped. Invalid, unsatisfiable and multiple ranges return 416 with `Content-Range: bytes */size`.
- `If-Range` matches the strong checksum ETag; unmatched, weak or date validators fall back to the full response. HEAD ignores Range. Other conditional caching headers do not bypass authentication or produce public cacheable responses.
- Responses include `Accept-Ranges: bytes`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and same-origin resource policy. Storage addresses and object keys are never sent to the client.
- The storage stream uses backpressure. Client cancellation closes it. Absolute expiry aborts the transfer; every five seconds an active transfer also checks session revocation/idle expiry and media deletion. Database-check failures abort the transfer. Every subsequent range/download request authenticates again. Bytes already delivered to the browser or downloaded cannot be recalled.

Range behavior follows [HTTP Semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-14). Multiple ranges are deliberately unsupported to keep resource use bounded.

## Scope

This phase implements original-file streaming and browser-native playback. `ENABLE_TRANSCODING=false` remains the supported configuration. HLS manifests/segments and optimized renditions are not implemented, and changing that flag does not create them. Some accepted containers/codecs, including HEIC and MKV variants, may require downloading and an external local player. No public HLS paths or static media directories are introduced.

## Local preview

Run `docker compose --profile processing up -d` and `npm run dev` from the repository. Open **http://localhost:3000** (the exact localhost origin matters for authenticated mutations). The Compose file is a development stack; its worker uses development configuration. The standalone worker image still defaults to production configuration and HTTPS origin validation.

If port 5432 is occupied, set `POSTGRES_PORT=55432` in your private `.env` and use port 55432 in its `DATABASE_URL`. The worker connects to PostgreSQL's internal port 5432. Never remove someone else's database or volumes to fix a port conflict.

The first run asks for owner setup. Read `SETUP_TOKEN` in your local `.env`, choose your own email/username/password, then upload a supported photo or MP4. Refresh after processing to reveal the viewer controls. No owner account, personal media or password is seeded by development startup.

## Verification

The database suite covers full/ranged bodies, suffixes, If-Range, HEAD, encoded download filenames, authentication/expiry, missing/deleted/unfinished media, cancellation and revocation during an open transfer. Unit tests cover malformed and overflowing ranges. `npm run test:processing` additionally verifies actual ranged reads from MinIO and Chromium video playback, seeking, photo viewing, downloads and anonymous denial using real FFmpeg-generated fixtures. See [the processing runner instructions](MEDIA_PROCESSING.md).
