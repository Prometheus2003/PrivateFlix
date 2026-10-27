# Private playlists and media metadata

Ready videos can be added to private playlists from their library cards. The
Playlists section creates, edits, selects and deletes queues, removes videos,
and saves their order using keyboard-accessible up/down controls. Playback offers
previous/next navigation. With autoplay enabled in owner preferences, completion
advances to the next video after saving its watched state.

Deleting a playlist removes its grouping and memberships only. Original photos,
videos, thumbnails and their storage mappings are preserved. Playlist operations
require authentication, owner authorization, canonical origins for writes and
bounded validation. All responses are private and noncached. No public URLs,
storage keys or Google identifiers are returned.

## Playlist API

| Method/path                    | Input                   | Result                                                                  |
| ------------------------------ | ----------------------- | ----------------------------------------------------------------------- |
| `GET /api/playlists`           | `page`, `limit` (1–100) | Safe playlist summaries, visible ready-video counts, `page`, `hasMore`  |
| `POST /api/playlists`          | `{name, description?}`  | New private playlist, HTTP 201                                          |
| `GET /api/playlists/:id`       | `page`, `limit` (1–100) | Playlist details and ordered safe video summaries                       |
| `PATCH /api/playlists/:id`     | `{name, description?}`  | Updated details                                                         |
| `DELETE /api/playlists/:id`    | No body                 | Grouping-only deletion                                                  |
| `PUT /api/playlists/:id/items` | `{mediaId, present}`    | Idempotent add/remove of an owned READY video                           |
| `PUT /api/playlists/:id/order` | `{mediaIds:[UUID,...]}` | Saved order; list must contain each currently visible item exactly once |

There are at most 100 playlists per owner and 100 videos per playlist. Names are
1–80 characters; descriptions are at most 500. A shared transaction lock protects
creation limits, additions, reordering and deletion against concurrent writes.
Unknown, unowned, deleted or unfinished videos are not added. A stale reorder
returns 409 so the owner can refresh instead of overwriting a changed queue.

## Media metadata

Each library card has **Edit details**. The native modal edits title, description
and comma-separated tags; it shows safe format/dimension/duration and collection
information. Save failures preserve the form and report the failure. Metadata
changes preserve original bytes, storage locations and extracted private metadata.
Extracted metadata and EXIF are not returned by this API.

`GET /api/media/:id` returns safe owner-only details and organization summaries.
`PATCH /api/media/:id` accepts `{title, description, tags}`. Titles are 1–300
characters, descriptions at most 2,000, and tags at most twenty names of forty
characters each. Tags are trimmed, normalized to lowercase and deduplicated.
Owner tag vocabulary is capped at 500; unused tags are reclaimed without removing
tags still used by another media item. Updates are transactional and serialized.

Library search now matches literal title, original filename, description and tag
substrings. `sort=duration` adds longest-first sorting with unknown durations last.

## Verification

Integration coverage uses disposable PostgreSQL for playlist authorization,
origins, ownership/readiness, idempotency/concurrency, order validation, limits and
grouping-only deletion. Metadata checks cover safe fields, validation, normalized
tags, search, original-key preservation and duration sorting.

`tests/e2e/playlists.spec.ts` uses copies of synthetic media in isolated MinIO to
verify saved order, previous/next playback, mobile layout and deletion preserving
media. `tests/e2e/processing.spec.ts` verifies metadata failed-save feedback,
persisted changes and description/tag search alongside playback/history/settings.
