# Media processing (Phase 5)

The worker consumes durable `METADATA` jobs created by completed uploads. It verifies the original's size and SHA-256 while streaming it to a private temporary directory, probes its actual content, and creates a JPEG thumbnail with a maximum 640 × 640 bounding box. Only then does a transaction publish dimensions, codec, duration/bitrate where available, the private thumbnail reference, and `READY` status. Originals are preserved, including on failure.

The library uses `/api/media/{id}/thumbnail` with the active session cookie. This endpoint checks authentication, ownership, deletion and readiness, and returns `private, no-store`. The client receives only a thumbnail-availability flag, never an object key or presigned URL. Next Image optimization is disabled for these private images so the browser sends the owner's cookie directly. Use Refresh to pick up processing results.

## Running the worker

Generate/configure `.env`, start the backing services, and apply migrations using the main README. The development Compose worker uses the same local HTTP origin as the development app. Standalone production-mode containers require `APP_URL` to be the canonical HTTPS origin. Then run:

```sh
docker compose --profile processing up -d --build worker
docker compose logs --tail 50 worker
```

The profile adds a separate non-root worker. Compose overrides database, Redis and S3 endpoints to Docker service names and retains generated credentials. The app continues to run separately. No worker is started by ordinary `docker compose up` without the processing profile. Apply new migrations before updating the worker.

Queue delivery is Redis/BullMQ; PostgreSQL remains authoritative. The dispatcher checks every five seconds and can reconstruct deliveries after Redis data loss. Global queue concurrency is one. Database leases prevent duplicate publication; expired leases become eligible after 30 minutes. Failed attempts are retried after at least 60 seconds, up to three attempts. A worker shutdown aborts active processing. Failures expose generic messages, not decoder output or storage paths.

## Limits and operational boundaries

- Compose constrains the worker to 2 CPUs, 1 GiB memory and 128 processes, drops capabilities, enables no-new-privileges and makes the root filesystem read-only. Working files live in the private `processing_work` volume.
- FFmpeg uses argument arrays without a shell, one decoder/encoder thread, bounded probe allocation and output, and an overall timeout (`FFMPEG_TIMEOUT`, default 600 seconds, maximum 900). Child processes receive no application credentials in their environment. URL/playlist demuxers and network protocols are excluded.
- Originals are streamed and checked against `MAX_UPLOAD_SIZE`; thumbnail uploads are capped at 4 MiB. Dimensions above 100 megapixels or 16,384 pixels on either axis, and videos longer than seven days, are rejected.
- Provision sufficient disk for the configured maximum original size plus overhead. Use a filesystem quota for the work volume in production. Normal completion/failure removes temporary files. Abrupt termination can leave a job directory behind; inspect and remove abandoned directories while the worker is stopped. A crash between thumbnail upload and database publication can also leave an unreferenced private object; storage reconciliation remains deployment work.
- Decoder support depends on the installed FFmpeg build. PNG and H.264 MP4 are exercised by live tests. JPEG, WebP, GIF and other allowed video containers use the same probing pipeline; HEIC and unusual codec variants are not certified. Unsupported/corrupt media fail safely and retain their originals.
- `READY` means metadata and thumbnail processing completed. [Original-file streaming and playback](STREAMING.md) are available. HLS, optimized renditions, larger generated photo previews and owner retry controls remain subsequent work. `ENABLE_TRANSCODING` does not yet enable a transcoder.

## Verification

```sh
npm run build
docker build -f deploy/Dockerfile.worker -t privateflix-worker:local .
npx playwright install chromium
npm run test:processing
```

The processing runner creates disposable PostgreSQL 16, Redis and MinIO containers on an isolated Docker network, using random temporary credentials. It uses loopback ports 55434 and 19000; these must be free. It requires the existing `privateflix-minio:2025-10-15` image (`docker compose build minio`). It migrates only a database named `privateflix_security_test`, runs unit/database tests, generates real PNG/MP4 fixtures, runs the constrained worker and verifies private thumbnail delivery, metadata, original preservation and corrupt-file failure. A production Chromium check verifies desktop/mobile thumbnail rendering and loss of access without a session. Containers, network and fixture credentials are cleaned up afterward.

The unit/database suite covers duplicate deliveries, expired and lost leases, bounded retry failure, checksum rejection, deleted media, child-process timeout/output limits, and credential omission. Browser checks use local HTTP behind a configured HTTPS origin and do not certify TLS deployment.

References: [FFmpeg options](https://ffmpeg.org/ffmpeg.html), [FFprobe](https://ffmpeg.org/ffprobe.html), [BullMQ stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs).
