# Library filters, photo viewing and bulk organization

## Browsing

**More filters** combines upload dates, original file format, video duration and
watched/started/unwatched status with search, favorites, media type and collection.
The date controls use local calendar days; the server receives UTC instants with
an inclusive start and exclusive end. Duration controls accept minutes; the API
accepts seconds. Sorting includes newest, oldest, title, longest and recently
watched. Never-watched items follow watched items in the latter ordering.

`GET /api/media` additionally accepts `format=mp4|webm|mkv|mov|avi|jpg|png|webp|gif|heic`,
`from`/`to` ISO UTC instants, `minDuration`/`maxDuration` seconds, and
`watch=all|watched|unwatched|started`. `sort=recent` uses a parameterized database
query for a bounded page of IDs. All filters retain owner/deletion checks, stable
pagination and literal search. Cards show duration, upload date and up to three
collection names. File-format filtering does not certify browser codec support.

## Photo viewer

Photos open through authenticated original streaming. The viewer offers fit,
100–400% zoom, keyboard `+`/`-`/`0`, fullscreen, original download and previous/next.
Arrow keys switch photos when fitted; with zoom enabled, focus the preview to pan.
Navigation follows ready photos in the **current filtered page**. It does not
silently load the entire library. The same page navigation is available for videos;
playlists retain their separately saved order.

Fullscreen targets the photo content element. Browsers that do not support it
receive visible feedback. Photos and videos have owner controls for favorites,
title/description/tags and confirmed media deletion. Dialog dismissal restores
focus and a nested dialog's Escape does not dismiss the viewer underneath it.

## Bulk changes

Choose **Select items**, check cards or **Select page**, then select an action.
Selection is limited to the visible page and clears after a successful mutation.
Favorite/unfavorite is immediate. Collection and tag changes review the selected
titles in a native dialog. Add-to-collection preserves other memberships; move
replaces them, with **No collection (unfiled)** available. Tag modes add, remove or
replace; an empty replacement clears tags. Tags are lowercase and deduplicated,
with twenty per media item and 500 names per owner.

`POST /api/media/bulk` takes one of these strict bodies:

```json
{"action":"favorite","mediaIds":["UUID"],"favorite":true}
{"action":"collection","mediaIds":["UUID"],"collectionId":"UUID or null","mode":"add or move"}
{"action":"tags","mediaIds":["UUID"],"tags":["travel"],"mode":"add or replace or remove"}
{"action":"delete","mediaIds":["UUID"],"confirm":true}
```

The examples describe alternatives, not a single JSON document; use actual UUIDs,
JSON null for unfiled, and one mode value. Requests require authentication and the
canonical origin, with 1–100 unique IDs. Every selected item must belong to the
owner and be available. A conflict rolls back the whole operation. Responses are
private/noncached `{updated, deletionQueued}`; deletion returns HTTP 202.

## Permanent deletion

Card/viewer deletion and bulk deletion share explicit confirmation. This is
permanent deletion, with no restore or trash interface. It differs from deleting a
collection/playlist or removing membership, which preserves original files.

Only ready or failed media without active uploads can be queued. Media is hidden
immediately (`DELETING`, `deletedAt`) and authenticated streams become unavailable.
`DELETE /api/media/:id` also accepts `{confirm:true}` for a single item. Repeated
requests preserve existing pending cleanup instead of creating duplicate work.

Maintenance starts cleanup after thirty minutes while the Node app is running.
It removes originals and generated thumbnail/preview files through their original
storage provider. Only after every removal succeeds are media, memberships,
favorites, playback history, playlist items and processing jobs removed; cover
references clear. Terminal upload receipts remain with no media association for
audit. Unused tags are reclaimed. Storage failures retain durable intent and retry
after thirty minutes, stopping after three attempts. Active upload/processor
states and stale cleanup against successful media are protected. Backups may
retain copies; backup retention and cleanup-exhaustion operations remain Phase 8.

## Retry failed processing

Eligible failed cards offer **Retry processing**. `POST /api/media/:id/retry`
accepts `{confirm:true}` and queues a fresh, bounded metadata/thumbnail job while
preserving failed job history. It requires a previously verified checksum, a
terminal metadata failure and an original whose current stored length matches.
Incomplete uploads must be resumed or uploaded again. Queued cleanup, another
processor, active uploads, deleted media and concurrent retries are rejected.
Storage I/O happens outside database transactions; ownership and state are checked
again before queueing. Retries are limited to one per minute and five per media
item in twenty-four hours. The worker still verifies the original checksum.

Terminal processing failures now mark upload receipts failed as well. Deletion
normalizes older terminal receipts after checking processor leases, so those
originals can be deleted without being mistaken for unfinished uploads. Settings
show pending deletion and exhausted cleanup counts for owner attention.

## Verification

`tests/integration/library.test.ts` covers advanced filter combinations, literal
search in recent ordering, bounds and invalid queries. `bulk.test.ts` covers
authentication/origin, transaction rollback, caps, tag/collection semantics,
idempotent deletion, cleanup grace/retry, related rows and stale-job protection.
`tests/e2e/photos.spec.ts` and `bulk.spec.ts` exercise synthetic media in isolated
storage, keyboard/focus, small screens and confirmed deletion. Run
`npm run test:processing` for current source in production and development modes.
