import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, lstat, open, rename, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

// Run on the owner's computer. Tokens never enter the UI, URLs, or console output.
export const DRIVE_REDIRECT = "http://127.0.0.1:53682/callback";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const USAGE =
  'Usage: npm run drive:connect -- "C:\\path\\to\\downloaded-oauth-client.json"';
class ConnectionError extends Error {}
const privateString = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  /^[A-Za-z0-9_.\/-]+$/.test(value);

export function authorizationDetails(clientId) {
  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: DRIVE_REDIRECT,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { state, verifier, url: url.href };
}

export function callbackCode(requestUrl, method, host, state) {
  let url;
  try {
    url = new URL(requestUrl, DRIVE_REDIRECT);
  } catch {
    throw new ConnectionError("Invalid callback");
  }
  const received = Buffer.from(url.searchParams.get("state") ?? "");
  if (
    method !== "GET" ||
    host !== "127.0.0.1:53682" ||
    url.origin !== new URL(DRIVE_REDIRECT).origin ||
    url.pathname !== "/callback" ||
    url.searchParams.getAll("state").length !== 1 ||
    received.length !== state.length ||
    !timingSafeEqual(received, Buffer.from(state))
  )
    throw new ConnectionError("Invalid callback");
  const code = url.searchParams.get("code");
  if (
    url.searchParams.has("error") ||
    url.searchParams.getAll("code").length !== 1 ||
    !code ||
    code.length > 4096
  )
    throw new ConnectionError("Google authorization was not granted");
  return code;
}

export function waitForAuthorization(details, log = console.log) {
  return new Promise((resolveCode, reject) => {
    const server = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      try {
        const code = callbackCode(
          request.url ?? "/",
          request.method,
          request.headers.host,
          details.state,
        );
        clearTimeout(timer);
        response.end(
          "Google authorization received. Return to your terminal to check connection results.",
        );
        server.close();
        resolveCode(code);
      } catch (error) {
        // An invalid state must not terminate the legitimate owner's pending flow.
        response.writeHead(400).end("Google authorization was not accepted.");
        if (
          error instanceof ConnectionError &&
          error.message === "Google authorization was not granted"
        ) {
          clearTimeout(timer);
          server.close();
          reject(error);
        }
      }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 30;
    const timer = setTimeout(
      () => {
        server.close();
        server.closeAllConnections();
        reject(
          new ConnectionError(
            "Google connection timed out. Run the command again.",
          ),
        );
      },
      10 * 60 * 1000,
    );
    server.once("error", () => {
      clearTimeout(timer);
      reject(
        new ConnectionError(
          "Could not open the local Google callback on port 53682. Close another connection attempt and retry.",
        ),
      );
    });
    server.listen(53682, "127.0.0.1", () =>
      log(
        `Open this URL on this computer and choose your storage account:\n${details.url}`,
      ),
    );
  });
}

async function googleJson(fetcher, url, options) {
  let response;
  try {
    response = await fetcher(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ConnectionError(
      "Could not reach Google. Check your connection and retry.",
    );
  }
  if (!response.ok)
    throw new ConnectionError(
      `Google request failed (${response.status}); configuration was not saved`,
    );
  try {
    return await response.json();
  } catch {
    throw new ConnectionError(
      "Invalid Google response; configuration was not saved",
    );
  }
}

export function updateDriveEnv(original, values) {
  // Remove every old assignment, including `export` and whitespace variants, so
  // duplicate dotenv keys cannot silently override the new configuration.
  const keys = Object.keys(values).join("|");
  const rest = original
    .split(/\r?\n/)
    .filter(
      (line) => !new RegExp(`^\\s*(?:export\\s+)?(?:${keys})\\s*=`).test(line),
    );
  return `${rest.join("\n").trimEnd()}\n${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

export async function connectDrive(
  credentialPath,
  {
    root = process.cwd(),
    fetcher = fetch,
    authorize = waitForAuthorization,
    log = console.log,
  } = {},
) {
  if (!credentialPath) throw new ConnectionError(USAGE);
  const envPath = resolve(root, ".env");
  const clientPath = resolve(credentialPath);
  const inside = relative(resolve(root), clientPath);
  if (
    inside === "" ||
    (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
  )
    throw new ConnectionError(
      "Keep the downloaded OAuth JSON outside the PrivateFlix repository, then run the command with that path.",
    );
  if ((await lstat(envPath)).isSymbolicLink())
    throw new ConnectionError(
      "Use a regular local .env file for connection setup",
    );
  const lockPath = `${envPath}.drive-connect.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new ConnectionError(
      "Another Drive connection may be running. Finish it first; remove .env.drive-connect.lock only after confirming no connection command is running.",
    );
  }
  const temporaryPath = `${envPath}.drive-connect-${randomBytes(8).toString("hex")}.local`;
  try {
    const original = await readFile(envPath, "utf8");
    const existing = parseEnv(original);
    if (
      existing.GOOGLE_DRIVE_REFRESH_TOKEN?.trim() ||
      existing.GOOGLE_DRIVE_FOLDER_ID?.trim()
    )
      throw new ConnectionError(
        "Drive is already configured. Preserve its folder and credentials; do not reconnect to a new folder while media exists.",
      );
    let credentials;
    try {
      credentials = JSON.parse(await readFile(clientPath, "utf8"));
    } catch {
      throw new ConnectionError(
        "Could not read valid downloaded Google OAuth client JSON",
      );
    }
    const client = credentials?.installed ?? credentials?.web;
    if (
      !privateString(client?.client_id) ||
      !privateString(client?.client_secret)
    )
      throw new ConnectionError("Google OAuth client JSON required");
    if (
      !credentials.installed &&
      !client.redirect_uris?.includes(DRIVE_REDIRECT)
    )
      throw new ConnectionError(
        `The web OAuth client must allow the exact redirect ${DRIVE_REDIRECT}`,
      );
    const details = authorizationDetails(client.client_id);
    const code = await authorize(details, log);
    const tokens = await googleJson(
      fetcher,
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: client.client_id,
          client_secret: client.client_secret,
          code,
          code_verifier: details.verifier,
          redirect_uri: DRIVE_REDIRECT,
          grant_type: "authorization_code",
        }),
      },
    );
    if (
      !privateString(tokens?.refresh_token) ||
      !privateString(tokens?.access_token) ||
      typeof tokens.scope !== "string" ||
      !tokens.scope.split(" ").includes(DRIVE_SCOPE)
    )
      throw new ConnectionError(
        "Offline Drive access was not granted; no configuration was saved",
      );
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    };
    const folder = await googleJson(
      fetcher,
      "https://www.googleapis.com/drive/v3/files?fields=id&ignoreDefaultVisibility=true",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "PrivateFlix Storage",
          mimeType: "application/vnd.google-apps.folder",
        }),
      },
    );
    if (typeof folder?.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(folder.id))
      throw new ConnectionError("Invalid storage folder response");
    const permissions = await googleJson(
      fetcher,
      `https://www.googleapis.com/drive/v3/files/${folder.id}/permissions?fields=permissions(type,role),nextPageToken&pageSize=100`,
      { headers },
    );
    if (
      permissions?.nextPageToken ||
      !Array.isArray(permissions?.permissions) ||
      permissions.permissions.length !== 1 ||
      permissions.permissions[0]?.type !== "user" ||
      permissions.permissions[0]?.role !== "owner"
    )
      throw new ConnectionError(
        "The new Drive folder is not private; configuration was not saved",
      );
    const values = {
      GOOGLE_DRIVE_CLIENT_ID: client.client_id,
      GOOGLE_DRIVE_CLIENT_SECRET: client.client_secret,
      GOOGLE_DRIVE_REFRESH_TOKEN: tokens.refresh_token,
      GOOGLE_DRIVE_FOLDER_ID: folder.id,
      STORAGE_PROVIDER: "google-drive",
    };
    await writeFile(temporaryPath, updateDriveEnv(original, values), {
      flag: "wx",
      mode: 0o600,
    });
    if (
      (await readFile(envPath, "utf8")) !== original ||
      (await lstat(envPath)).isSymbolicLink()
    )
      throw new ConnectionError(
        ".env changed during authorization; configuration was not overwritten",
      );
    await rename(temporaryPath, envPath);
    log(
      "Drive connected. Credentials saved in ignored .env; no secrets printed. Run npm run db:deploy, then restart the app and recreate the worker. Existing local media stays local. Keep the new Drive folder private.",
    );
  } finally {
    await rm(temporaryPath, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (["--help", "-h"].includes(process.argv[2])) console.log(USAGE);
  else
    connectDrive(process.argv[2]).catch((error) => {
      console.error(
        error instanceof ConnectionError
          ? error.message
          : "Drive connection failed. Check local file permissions and configuration; no credentials were printed.",
      );
      process.exitCode = 1;
    });
}
