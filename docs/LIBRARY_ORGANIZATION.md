# Interactive library

The library now opens with browsing controls above the upload form. Organization
data is stored in PostgreSQL and remains available after signing out or reloading.
All endpoints require the authenticated owner and return private, noncached JSON.

## Owner interface

- Search titles and original filenames with a 300 ms debounce. Searches treat `%`,
  `_` and backslash literally, support case-insensitive matching, and accept up to
  120 characters.
- Combine video/photo, favorite and collection filters. Sort by newest, oldest or
  title; browse twenty results per page. Clear filters restores the full library.
- Switch between grid and list layouts. Favorite buttons expose their saved state
  and report a failed save without pretending it succeeded.
- Create collections, edit their names/descriptions, add or remove media, and
  delete a collection after confirmation. Deleting a collection removes its
  grouping and memberships; original media remains in the library and storage.
- Collections are flat in this interface, with a maximum of 100 per owner. Names
  accept 1–80 characters; descriptions accept up to 500. A photo or video can belong
  to multiple collections.
- Upload refresh continues updating pending uploads and the current library view.
  Visible views containing uploaded/processing media refresh every five seconds;
  hidden tabs and open dialogs/viewers skip these refreshes. Background updates
  preserve the visible grid while fetching. Native playback and downloads remain private.
- Requests have deadlines and ignore superseded search responses. Session expiry
  clears the owner interface. Collection dialogs support Escape, focus restoration,
  visible labels and inline errors. Controls remain usable on small screens and
  honor reduced-motion preferences.

The grid/list choice and current filters are local UI state; favorite and
collection changes are persisted. Nested collections, playback history/resume,
tags, playlists, bulk editing and account/session settings UI remain future work.

## API contract

| Method/path                      | Input                                                                                                                   | Result                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/media`                 | `page`, `limit`, `q`, `type=all\|VIDEO\|IMAGE`, `favorite=true\|false`, `collection=UUID`, `sort=newest\|oldest\|title` | Existing safe media fields, `isFavorite`, `page`, `hasMore`, `total`               |
| `PUT /api/media/:id/favorite`    | `{ "favorite": true }`                                                                                                  | `{ "mediaId", "isFavorite" }`                                                      |
| `GET /api/collections`           | `page`, `limit` (max 100)                                                                                               | `{ "collections": [{ "id", "name", "description", "count" }], "page", "hasMore" }` |
| `POST /api/collections`          | `{ "name", "description"? }`                                                                                            | `{ "collection" }`, HTTP 201                                                       |
| `PATCH /api/collections/:id`     | `{ "name", "description"? }`                                                                                            | `{ "collection" }`                                                                 |
| `DELETE /api/collections/:id`    | No body                                                                                                                 | `{ "deleted": true }`                                                              |
| `PUT /api/collections/:id/items` | `{ "mediaId", "present": true }`                                                                                        | `{ "collectionId", "mediaId", "present" }`                                         |

Writes require the canonical origin. Both the collection and media must belong to
the owner; unknown/unowned/deleted media returns 404. Favorite and membership
writes are idempotent. Concurrent collection creation is serialized before
enforcing the cap. No new database migration is needed; this uses existing models.

## Design references and verification

The installed **UI UX Pro Max** skill supplied Next.js client-boundary and modal
focus guidance. The installed **21st MCP** was used to search for and retrieve
[Search Toolbar Page Header](https://21st.dev/@olewandowski1/components/page-header-5)
by olewandowski1. Its search/filter/layout composition informed the custom toolbar,
which reuses PrivateFlix's native controls, existing Button and semantic theme
tokens. PrivateFlix media, filenames and storage credentials were not sent to the component service.

`tests/integration/library.test.ts` covers owner authentication/origin, safe DTOs,
literal search, combined filtering/pagination, idempotency, concurrent writes,
collection limits, revoked sessions and grouping deletion preserving originals.
`tests/e2e/library.spec.ts` uses synthetic metadata in a guarded disposable
database to verify search, filters, saved favorites, failure feedback, collection
creation/editing/membership/deletion, dialog focus and mobile layout. Live
processing/browser verification remains in `npm run test:processing`.
