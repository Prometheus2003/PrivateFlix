# Private viewing history and owner settings

The History and Settings sections use the authenticated owner's PostgreSQL data.
Playback preferences and positions are not stored in browser storage. Every API
below authenticates the session and returns `Cache-Control: private, no-store`.
Writes require the canonical request origin and bounded JSON validation.

## Playback continuity

The player loads the saved position before allowing playback. Unfinished videos
with at least one second saved offer **Resume playback** or **Start from beginning**.
Positions are saved every ten seconds while playing, on pause, after a 400 ms seek
debounce, on completion, when hiding/leaving the page, and before closing the
viewer. A serialized queue keeps newer positions behind any in-flight save.
Failed saves remain visible and can be retried; the owner can explicitly close
without saving. No history is created just by opening a video.

The server uses the processed video's duration, clamps positions to that duration,
and marks playback complete at 95%. Explicit **Mark watched** and **Mark unwatched**
controls are available. Marking unwatched resets the position to zero. Continue
Watching excludes completed videos and positions at zero. History removal only
removes positions/watch states, preserving original media and organization.

| Method/path                     | Input                                             | Result                                                                |
| ------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /api/playback`             | `mode=history\|continue`, `page`, `limit` (1–100) | Safe video summaries, position/duration/completion, `page`, `hasMore` |
| `GET /api/playback/:mediaId`    | Video UUID                                        | `progress` or null, trusted duration                                  |
| `PUT /api/playback/:mediaId`    | `{positionSeconds, completed?}`                   | Clamped position, duration, completion                                |
| `DELETE /api/playback/:mediaId` | No body                                           | Idempotent removal of this video's history                            |
| `DELETE /api/playback`          | `{confirm:true}`                                  | Number of removed owner history rows                                  |

Only owned, nondeleted, READY videos participate. Missing/unowned/image/unfinished
IDs return 404. A video without a finite processed duration cannot accept a
position (409). Paginated history never returns storage keys or raw ownership rows.

## Preferences and security

`GET /api/settings` returns `{preferences:{theme,playbackSpeed,autoplay}}`.
`PUT /api/settings` replaces those validated preferences; arbitrary configuration
keys are rejected. Theme supports dark/light. Default speed supports 0.5–2× using
the offered steps. Autoplay defaults off and remains subject to browser policy.
The selected theme applies after authenticated preferences load.

The account form uses the existing password-change API and rotates the current
session while revoking other sessions. Active sessions show safe browser details
and expiry. Revocation and sign-out-all require the current password and explicit
confirmation. Passwords are never stored in browser storage or preferences.

`GET /api/system/status` provides safe owner-only version, library usage/counts,
failed-media count and implementation status. Quality is currently original-only;
thumbnail generation is automatic. Transcoding/HLS and configured backups are
unavailable and shown honestly pending their respective work.

## Storage verification

`GET /api/system/storage` remains a configuration-only check by default.
`?verify=true` validates Google authorization, owner-only folder permissions and
account quota. Results are deduplicated/cached for thirty seconds per app process,
with a twelve-second provider deadline. Failure returns `unavailable`, without
Google error bodies, object identifiers or credentials. Quota can be absent for an
unlimited account. Account usage includes other Google services.

## Verification

`tests/integration/history-settings.test.ts` uses a guarded disposable database
for authorization, origin checks, validation, trusted duration, watch state,
history deletion, preference persistence and safe system responses.
`tests/unit/drive-status.test.ts` checks private-folder validation, error redaction,
quota parsing and bounded cache reuse. Browser coverage in
`tests/e2e/processing.spec.ts` exercises real decoder fixtures and owner controls.
The processing runner builds current sources, uses an isolated build directory,
and explicitly disables live Google credentials in its test app.

On this Windows workstation the test browser can be installed/reused with:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = 'C:\Users\USER\Documents\ChatGPT\PrivFlix\work\pw-browsers'
node node_modules/@playwright/test/cli.js install chromium --only-shell
npm run test:processing
```

The real owner account and existing media are never reset by this runner.
