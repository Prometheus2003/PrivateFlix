# Google Drive storage

PrivateFlix can store new media and thumbnails in your own Google Drive. Existing
S3/MinIO files continue to work. This does not import or migrate your existing
Drive or MinIO library. Account connection is required before enabling it.

## First-time setup on this Windows computer

1. Open [Google Cloud Console](https://console.cloud.google.com/) using the Google
   account that owns your storage. Create a project named **PrivateFlix**.
2. Open **APIs & Services → Library**, find **Google Drive API**, and enable it.
3. Open **Google Auth Platform** and configure the app name and contact email.
   Select an External audience for a personal account. During testing, add your
   Google email as a test user. Add only the
   `https://www.googleapis.com/auth/drive.file` scope under Data Access.
4. Under **Clients**, create an OAuth client of type **Desktop app**, named
   **PrivateFlix Local Connection**. Download its JSON to a private folder outside
   this repository, such as your Downloads folder. Do not paste its contents into
   chat or commit it. A web application client can also work if its authorized
   redirect URI is exactly `http://127.0.0.1:53682/callback`.
5. In the VS Code terminal for PrivateFlix, run:

   ```powershell
   npm run drive:connect -- "C:\Users\USER\Downloads\your-downloaded-client.json"
   ```

6. Open the Google URL printed in the terminal. Select the account with your
   storage and grant the requested permission. The command binds only to loopback,
   verifies OAuth state and PKCE, creates a new **PrivateFlix Storage** folder,
   verifies that only its owner has permission, and saves credentials in ignored
   `.env` using an atomic file replacement. It does not print tokens. Keep this
   terminal open until it reports success; the browser callback alone does not
   confirm that setup finished.
7. Run `npm run db:deploy`. Restart the app and rebuild/recreate the worker so both
   load the new configuration:

   ```powershell
   docker compose --profile processing up -d --build --force-recreate worker
   npm run dev
   ```

   Stop the existing dev server before starting another on port 3000. Keep
   PostgreSQL, Redis and MinIO running.

8. Upload a small test video, wait for READY, then test playback, seeking and
   download. Check that it appears in the private Drive folder. Do this before
   uploading a large collection. Live account validation has not been performed
   until this step succeeds.

External OAuth apps in **Testing** can receive refresh tokens that expire after
seven days for Drive scopes. For ongoing use, configure the consent screen's
publishing status appropriately; Google determines any verification requirements.
See [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

If another connection is already configured, the command refuses to replace its
folder or refresh token. Preserve both while any media uses Drive. Run only one
connection command at a time. If a previous command was forcibly interrupted,
confirm that it has stopped before removing `.env.drive-connect.lock` and retrying.
If a Google request fails after folder creation, an empty **PrivateFlix Storage**
folder can remain in Drive; failed setup does not enable Drive in `.env`.

## How storage works

- New storage keys carry a server-only Drive prefix. Old keys continue using S3.
  Changing the default back to S3 does not migrate files; retain Drive credentials
  while Drive-backed media exists.
- Browser uploads are staged in private MinIO using the existing resumable
  multipart protocol. Completion streams the object into Drive and verifies its
  MD5 and retained revision before removing staging. Publication state and the
  revision ID are saved in PostgreSQL. Database-allocated Drive IDs prevent
  duplicate objects when a completed transfer response is lost; recovery compares
  the existing Drive object against staged bytes. A failed transfer can be retried
  from staging; transfer sessions themselves are not persisted. Maintenance
  retries deletion of up to twenty verified temporary copies per pass once their
  mapping is at least thirty minutes old.
- You still need temporary local capacity for active uploads (up to three), worker
  scratch space, PostgreSQL and Redis. Drive reduces permanent media storage; it
  does not eliminate local disk requirements. Completion includes an extra upload
  to Google and full checksum verification, so it may take longer.
- Original playback, seeking, downloads and thumbnails stay behind PrivateFlix
  authentication. No Google links, tokens or storage identifiers go to the browser.
  Media reads use the verified, retained revision and validate range headers.
  A changed file fails closed. Google download redirects are bounded and OAuth
  bearer tokens are never forwarded to a different origin.
- The app requests `drive.file`, not access to all files in your account. The
  connection command creates a fresh private folder. Uploads reject a shared
  folder. Do not share the folder or individual files using Google's UI, and do
  not move, replace or delete them there. Google account access remains independent
  of your PrivateFlix password.
- Back up PostgreSQL and `.env` securely: the database contains the Drive object
  mapping. Removing credentials or revoking Google consent prevents access until
  restored. This implementation is for a personal My Drive folder, not shared drives.
- Drive account capacity does not remove API quotas, transfer limits or bandwidth
  limits. Your account's 15 TB allocation has not yet been checked through Google.
  The current PrivateFlix per-file limit remains 10 GiB, and Drive transfer attempts
  time out after ten minutes. Slower large uploads may require a later resumable
  transfer worker enhancement.

References: [resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[range downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[usage limits](https://developers.google.com/workspace/drive/api/guides/limits).
