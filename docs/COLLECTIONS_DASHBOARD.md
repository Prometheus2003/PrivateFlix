# Collection presentation and library overview

**Browse collections** displays private cover tiles, direct item counts and parent
breadcrumbs. A collection can contain mixed photos/videos, and media can belong to
several collections. Select a collection and use a ready card's **Use as collection
cover** button; its existing private thumbnail becomes the cover. Clear the cover
from the collection header. No public image URL or provider key is exposed.

**Arrange collections** changes global order with keyboard-accessible up/down
buttons and assigns a parent to a selected collection. Save applies the whole
organization atomically. Nesting supports up to five levels; self-reference,
descendant cycles and excess depth are rejected. Every referenced collection must
belong to the owner. A stale set of collections must be refreshed before saving.
New collections append after the saved order.

Collection filters/counts are direct memberships, rather than automatic rollups
of descendants. Parent breadcrumbs and the collection shelf let the owner browse
children explicitly. Deleting a parent collection preserves children at the top
level and leaves all original media and child memberships intact. Soft-deleted or
unready cover media disappears from presentation immediately; physical media
deletion later clears its cover references through the existing database relation.

## API

- `GET /api/collections`: safe summaries now include `parentId`, `sortOrder` and
  nullable `coverMediaId`, ordered by saved position, then name and ID.
- `PUT /api/collections/layout`: `{collections:[{id,parentId}, ...]}` must contain
  every current owner collection exactly once, up to 100. Array order becomes the
  saved order. `parentId` is a UUID or null. Duplicate/unknown fields and IDs,
  unowned references, stale sets, cycles and excess depth are rejected.
- `PUT /api/collections/:id/cover`: `{mediaId:UUID|null}` requires an owned ready
  media item with a generated thumbnail, or null to clear. It changes a reference
  without deleting or moving bytes or memberships.
- `GET /api/library/summary`: media/video/photo/favorite totals, original-byte
  total, collection/playlist counts and up to eight approved recent activity
  labels/timestamps. Deleted media is excluded. Logical original size is separate
  from the storage account's quota and generated/staging files.

All endpoints authenticate the owner first and return private, noncached JSON.
Writes require the canonical origin and strict bounded bodies. Presentation,
creation and collection deletion share a transaction lock. Overview queries use a
consistent read snapshot and database aggregates, without loading the full media
library. Recent activity excludes filenames, resource IDs, session details, IPs,
audit details and unrecognized event names.

## Interface and verification

The overview appears above the library and refreshes after relevant owner changes
or **Refresh overview**. It has an accessible two-column phone layout and a
collapsible recent-activity list. Continue watching, recent viewing, the newest
library view, upload history and storage settings provide the other dashboard
workflows. Viewer titles update after metadata editing, and grouping/media changes
from history/playlists refresh the main library and overview.

`tests/integration/collection-layout.test.ts` verifies ownership/origin, complete
ordering, cycle/depth checks, atomic concurrent writes, private cover validation,
parent deletion preserving children/media, aggregate accuracy and safe activity.
`tests/e2e/collections.spec.ts` uses synthetic fixtures for persisted covers,
nesting/order, breadcrumbs, mobile dialogs and parent deletion. The broader
processing runner retains separate production/development/upload screenshot
folders under ignored `test-results` and runs the legacy reload/resume test last
against its guarded disposable database.

Development verification compiles protected API bundles with cookie-free requests
before browser timing checks; every readiness request must return 401 and performs
no owner mutation. This separates development compilation from UI request
deadlines. On memory-constrained workstations, stop a second preview temporarily
and use a bounded Node heap while testing; restart the preview afterward.
