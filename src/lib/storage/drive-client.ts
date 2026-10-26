import "server-only";
import { z } from "zod";

const API = "https://www.googleapis.com/drive/v3";
const fileSchema = z.object({
  id: z.string(),
  size: z.string().optional(),
  mimeType: z.string(),
  md5Checksum: z.string().optional(),
  headRevisionId: z.string().optional(),
  modifiedTime: z.string().optional(),
  parents: z.array(z.string()).optional(),
  trashed: z.boolean().optional(),
});
export type DriveFile = z.infer<typeof fileSchema>;
export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId: string;
}
// Errors intentionally exclude response bodies, URLs and credentials.
export class DriveError extends Error {
  constructor(readonly status: number) {
    super(`Google Drive operation failed (${status})`);
  }
}
export class DriveClient {
  private token?: { value: string; expires: number };
  private refreshing?: Promise<string>;
  constructor(
    readonly config: DriveConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60000)
      return this.token.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await this.fetcher(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          body: new URLSearchParams({
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            refresh_token: this.config.refreshToken,
            grant_type: "refresh_token",
          }),
        },
      );
      if (!response.ok) throw new DriveError(response.status);
      const data = z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number().positive(),
        })
        .parse(await response.json());
      this.token = {
        value: data.access_token,
        expires: Date.now() + data.expires_in * 1000,
      };
      return data.access_token;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    if (
      target.origin !== "https://www.googleapis.com" ||
      target.username ||
      target.password
    )
      throw new Error("Invalid Google Drive endpoint");
    const response = await this.fetcher(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(60000),
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Authorization: `Bearer ${await this.accessToken()}`,
      },
    });
    if (response.status === 401) this.token = undefined;
    return response;
  }

  async allocateId(): Promise<string> {
    const response = await this.request(
      `${API}/files/generateIds?count=1&space=drive&type=files`,
    );
    if (!response.ok) throw new DriveError(response.status);
    return z
      .object({ ids: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).length(1) })
      .parse(await response.json()).ids[0];
  }

  async file(id: string): Promise<DriveFile | null> {
    const response = await this.request(
      `${API}/files/${encodeURIComponent(id)}?fields=id,size,mimeType,md5Checksum,headRevisionId,modifiedTime,parents,trashed`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new DriveError(response.status);
    const file = fileSchema.parse(await response.json());
    if (file.trashed) return null;
    if (!file.parents?.includes(this.config.folderId))
      throw new Error("Drive file outside storage folder");
    return file;
  }

  async assertPrivateFolder(): Promise<void> {
    const id = encodeURIComponent(this.config.folderId);
    const response = await this.request(
      `${API}/files/${id}?fields=mimeType,trashed,ownedByMe`,
    );
    if (!response.ok) throw new DriveError(response.status);
    const folder = z
      .object({
        mimeType: z.literal("application/vnd.google-apps.folder"),
        trashed: z.literal(false),
        ownedByMe: z.literal(true),
      })
      .safeParse(await response.json());
    if (!folder.success)
      throw new Error("A private My Drive folder is required");
    const permissions = await this.request(
      `${API}/files/${id}/permissions?fields=permissions(type,role),nextPageToken&pageSize=100`,
    );
    if (!permissions.ok) throw new DriveError(permissions.status);
    const data = z
      .object({
        permissions: z.array(z.object({ type: z.string(), role: z.string() })),
        nextPageToken: z.string().optional(),
      })
      .parse(await permissions.json());
    if (
      data.nextPageToken ||
      data.permissions.length !== 1 ||
      data.permissions[0].type !== "user" ||
      data.permissions[0].role !== "owner"
    )
      throw new Error("Google Drive storage folder must not be shared");
  }

  async beginUpload(
    id: string,
    contentType: string,
    length: number,
  ): Promise<string> {
    await this.assertPrivateFolder();
    const response = await this.request(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id&keepRevisionForever=true&ignoreDefaultVisibility=true",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Content-Type": contentType,
          "X-Upload-Content-Length": String(length),
        },
        body: JSON.stringify({ id, name: id, parents: [this.config.folderId] }),
      },
    );
    if (!response.ok) throw new DriveError(response.status);
    const location = response.headers.get("location");
    const session = location ? new URL(location) : null;
    if (
      !session ||
      session.origin !== "https://www.googleapis.com" ||
      session.username ||
      session.password
    )
      throw new Error("Invalid Drive upload session");
    return session.href;
  }

  async remove(id: string): Promise<void> {
    // Verify folder membership before deleting anything.
    if (!(await this.file(id))) return;
    const response = await this.request(
      `${API}/files/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404)
      throw new DriveError(response.status);
  }

  async assertPinnedRevision(
    id: string,
    revisionId: string,
    md5: string,
    size: number,
  ) {
    const response = await this.request(
      `${API}/files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}?fields=keepForever,md5Checksum,size`,
    );
    if (!response.ok) throw new DriveError(response.status);
    const result = z
      .object({
        keepForever: z.literal(true),
        md5Checksum: z.literal(md5),
        size: z.literal(String(size)),
      })
      .safeParse(await response.json());
    if (!result.success) throw new Error("Drive revision verification failed");
  }

  async download(
    id: string,
    revisionId: string,
    range?: string,
  ): Promise<Response> {
    let url = new URL(
      `${API}/files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}?alt=media`,
    );
    // Bound header acquisition across all redirects. Body cancellation is owned
    // by the returned Readable, which propagates cancellation to fetch.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    timer.unref();
    let response: Response;
    try {
      for (let redirects = 0; ; redirects++) {
        const headers = new Headers(range ? { Range: range } : {});
        if (url.origin === "https://www.googleapis.com")
          headers.set("Authorization", `Bearer ${await this.accessToken()}`);
        response = await this.fetcher(url.href, {
          headers,
          signal: controller.signal,
          redirect: "manual",
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects >= 3)
          throw new Error("Invalid Drive download redirect");
        const next = new URL(location, url);
        if (
          next.protocol !== "https:" ||
          next.port ||
          next.username ||
          next.password ||
          !(
            next.hostname === "www.googleapis.com" ||
            next.hostname.endsWith(".googleusercontent.com")
          )
        )
          throw new Error("Invalid Drive download redirect");
        url = next;
      }
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) this.token = undefined;
    if (response.status !== (range ? 206 : 200) || !response.body) {
      await response.body?.cancel();
      throw new DriveError(response.status);
    }
    return response;
  }
}
