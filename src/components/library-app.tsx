"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { LibraryBrowser } from "./library-browser";
import { StorageSettings } from "./storage-settings";
import {
  Film,
  LockKeyhole,
  UploadCloud,
  Library,
  LogOut,
  ArrowUpRight,
  Check,
  Pause,
  HardDrive,
} from "lucide-react";
import { Button } from "./ui/button";
import { hashFile, hashPart } from "@/client/hash-file";
interface Pending {
  id: string;
  totalBytes: number;
  bytesUploaded: number;
  expectedChecksum: string;
  completionStarted: boolean;
  media: { originalFilename: string; mimeType: string };
}
interface Receipt {
  partNumber: number;
  checksum: string;
}
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    credentials: "same-origin",
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      result.error ?? "Request failed. Please try again.",
      response.status,
    );
  return result as T;
}
const json = (data: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? (bytes / 1024 ** 3).toFixed(1) + " GB"
    : (bytes / 1024 ** 2).toFixed(1) + " MB";
const mimeTypes: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
};
export default function LibraryApp({ name }: { name: string }) {
  const [user, setUser] = useState<string | null>(null);
  const [mode, setMode] = useState<"loading" | "login" | "setup" | "library">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [browseRefresh, setBrowseRefresh] = useState(0);
  const [uploads, setUploads] = useState<Pending[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [resume, setResume] = useState<Pending | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      setUser(null);
      setUploads([]);
      setResume(null);
      setFile(null);
      setMode("login");
      setMessage("Your session expired. Sign in to continue.");
    } else
      setMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again.",
      );
  }
  const expireSession = useCallback(() => {
    controller.current?.abort();
    setUser(null);
    setUploads([]);
    setResume(null);
    setFile(null);
    setMode("login");
    setMessage("Your session expired. Sign in to continue.");
  }, []);
  async function refresh() {
    const pending = await api<{ uploads: Pending[] }>("/api/media/uploads");
    setUploads(pending.uploads);
    setBrowseRefresh((value) => value + 1);
  }
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const session = await api<{ user: { username: string } }>(
          "/api/auth/session",
        );
        const pending = await api<{ uploads: Pending[] }>("/api/media/uploads");
        if (!alive) return;
        setUser(session.user.username);
        setMode("library");
        setUploads(pending.uploads);
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && error.status === 401) {
          try {
            const status = await api<{ initialized: boolean }>(
              "/api/auth/init-status",
            );
            if (alive) setMode(status.initialized ? "login" : "setup");
          } catch {
            if (alive) {
              setMode("login");
              setMessage("Cannot reach your library. Try again shortly.");
            }
          }
        } else {
          setMode("login");
          setMessage("Cannot reach your library. Try again shortly.");
        }
      }
    })();
    return () => {
      alive = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (cancelId) confirmation.current?.showModal();
    else confirmation.current?.close();
  }, [cancelId]);
  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = event.currentTarget,
      values = new FormData(form);
    try {
      if (mode === "setup")
        await api("/api/auth/setup", {
          ...json({
            email: values.get("email"),
            username: values.get("username"),
            password: values.get("password"),
            confirmPassword: values.get("confirmPassword"),
          }),
          headers: {
            "Content-Type": "application/json",
            "X-Setup-Token": String(values.get("setupToken")),
          },
        });
      else
        await api(
          "/api/auth/login",
          json({
            login: values.get("login"),
            password: values.get("password"),
          }),
        );
      const session = await api<{ user: { username: string } }>(
        "/api/auth/session",
      );
      form.reset();
      await refresh();
      setUser(session.user.username);
      setMode("library");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function uploadFile() {
    if (!file) {
      setMessage("Choose a file first.");
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setMessage("");
    setProgress(0);
    setStage("Checking your file");
    try {
      const checksum = await hashFile(file, abort.signal, setProgress);
      if (
        resume &&
        (resume.totalBytes !== file.size ||
          resume.expectedChecksum !== checksum)
      )
        throw new Error(
          "This file does not match the paused upload. Select the original file.",
        );
      const mime = mimeTypes[file.name.split(".").pop()?.toLowerCase() ?? ""];
      if (!mime) throw new Error("This file format is not supported.");
      const started = resume
        ? { uploadId: resume.id, partSize: 8 * 1024 * 1024 }
        : await api<{ uploadId: string; partSize: number }>(
            "/api/media/upload/start",
            {
              ...json({
                filename: file.name,
                mime,
                totalBytes: file.size,
                checksum,
              }),
              signal: abort.signal,
            },
          );
      const base = "/api/media/upload/" + started.uploadId;
      const receipts = new Map<number, string>();
      for (let p = 1; ; p++) {
        const saved = await api<{
          upload: { parts: Receipt[] };
          hasMore: boolean;
        }>(base + "?page=" + p, { signal: abort.signal });
        saved.upload.parts.forEach((r) =>
          receipts.set(r.partNumber, r.checksum),
        );
        if (!saved.hasMore) break;
      }
      setStage("Uploading securely");
      setProgress(0);
      for (
        let offset = 0, part = 1;
        offset < file.size;
        offset += started.partSize, part++
      ) {
        abort.signal.throwIfAborted();
        const bytes = new Uint8Array(
          await file.slice(offset, offset + started.partSize).arrayBuffer(),
        );
        const digest = hashPart(bytes);
        if (receipts.has(part) && receipts.get(part) !== digest)
          throw new Error("The saved upload does not match this file.");
        if (!receipts.has(part))
          await api(base + "/parts/" + part, {
            method: "PUT",
            body: bytes,
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Part-Sha256": digest,
            },
            signal: abort.signal,
          });
        setProgress(
          Math.round(
            (Math.min(file.size, offset + bytes.length) / file.size) * 100,
          ),
        );
      }
      setStage("Verifying upload");
      await api(base + "/complete", { method: "POST", signal: abort.signal });
      setMessage("Upload saved privately. It is awaiting media processing.");
      setFile(null);
      setResume(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (error) {
      if (abort.signal.aborted)
        setMessage(
          "Upload paused. Select the same file to resume from saved parts.",
        );
      else fail(error);
    } finally {
      controller.current = null;
      setBusy(false);
      setStage("");
      try {
        await refresh();
      } catch (error) {
        fail(error);
      }
    }
  }
  async function finish(id: string) {
    setBusy(true);
    setMessage("Verifying your saved upload…");
    try {
      await api("/api/media/upload/" + id + "/complete", { method: "POST" });
      await refresh();
      setMessage("Upload saved privately.");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function cancelUpload() {
    const id = cancelId;
    setCancelId(null);
    if (!id) return;
    setBusy(true);
    try {
      await api("/api/media/upload/" + id + "/cancel", { method: "POST" });
      await refresh();
      setMessage("Upload cancelled.");
      if (resume?.id === id) setResume(null);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  const brand = (
    <span className="brand">
      <span className="brand-icon">
        <Film size={21} />
      </span>
      {name}
      <span className="private-label">PRIVATE</span>
    </span>
  );
  if (mode !== "library")
    return (
      <main className="auth-shell">
        <section className="auth-story">
          {brand}
          <div>
            <p className="eyebrow">YOUR COLLECTION. YOUR SPACE.</p>
            <h1>
              A home for
              <br />
              your memories.
            </h1>
            <p className="story-copy">
              Your videos and photos, together in a library that belongs only to
              you.
            </p>
            <div className="privacy-note">
              <LockKeyhole size={17} /> Private by design. Hosted by you.
            </div>
          </div>
          <span className="muted">A little less noise. A lot more yours.</span>
        </section>
        <section className="auth-panel">
          {mode === "loading" ? (
            <div aria-label="Loading your library" className="skeleton" />
          ) : (
            <form onSubmit={authenticate} className="auth-form">
              <p className="eyebrow">
                {mode === "setup" ? "MAKE YOURSELF AT HOME" : "WELCOME BACK"}
              </p>
              <h2>
                {mode === "setup"
                  ? "Create your private library"
                  : "Sign in to your library"}
              </h2>
              <p className="muted">
                {mode === "setup"
                  ? "Set up the single owner account for this library."
                  : "Your collection is waiting for you."}
              </p>
              {mode === "setup" ? (
                <>
                  <label>
                    Email
                    <input
                      name="email"
                      type="email"
                      required
                      autoComplete="email"
                    />
                  </label>
                  <label>
                    Username
                    <input
                      name="username"
                      required
                      minLength={3}
                      autoComplete="username"
                    />
                  </label>
                  <label>
                    Setup token
                    <input
                      name="setupToken"
                      required
                      type="password"
                      autoComplete="off"
                    />
                    <small>
                      Use the setup token from your server configuration.
                    </small>
                  </label>
                </>
              ) : (
                <label>
                  Email or username
                  <input name="login" required autoComplete="username" />
                </label>
              )}
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  required
                  minLength={mode === "setup" ? 12 : 1}
                  autoComplete={
                    mode === "setup" ? "new-password" : "current-password"
                  }
                />
              </label>
              {mode === "setup" && (
                <>
                  <label>
                    Confirm password
                    <input
                      name="confirmPassword"
                      type="password"
                      required
                      autoComplete="new-password"
                    />
                  </label>
                  <small>
                    Use at least 12 characters with upper and lowercase letters,
                    a number, and a symbol.
                  </small>
                </>
              )}
              <Button disabled={busy} type="submit">
                {busy
                  ? "Please wait…"
                  : mode === "setup"
                    ? "Create library"
                    : "Sign in"}
                <ArrowUpRight size={17} />
              </Button>
              <p role="status" className="notice">
                {message}
              </p>
            </form>
          )}
        </section>
      </main>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        {brand}
        <nav aria-label="Library navigation" className="flex-wrap">
          <a className="nav-active" href="#collection">
            <Library size={19} />
            My library
          </a>
          <a href="#upload">
            <UploadCloud size={19} />
            Upload media
          </a>
          <a href="#storage">
            <HardDrive aria-hidden="true" size={19} />
            Storage
          </a>
        </nav>
        <div className="sidebar-footer">
          <LockKeyhole size={18} />
          <strong>Only you have access</strong>
          <p>Your originals stay private.</p>
        </div>
      </aside>
      <main className="library-main">
        <header className="topbar">
          <span>YOUR PERSONAL COLLECTION</span>
          <div>
            <span className="owner-avatar">
              {user?.slice(0, 1).toUpperCase()}
            </span>
            <span>{user}</span>
            <Button
              variant="ghost"
              disabled={busy}
              aria-label="Sign out"
              onClick={async () => {
                try {
                  await api("/api/auth/logout", { method: "POST" });
                  setUser(null);
                  setUploads([]);
                  setFile(null);
                  setResume(null);
                  setMode("login");
                  setMessage("");
                } catch (error) {
                  fail(error);
                }
              }}
            >
              <LogOut size={17} />
            </Button>
          </div>
        </header>
        <section className="library-heading" id="collection">
          <p className="eyebrow">COLLECT THE MOMENTS</p>
          <h1>
            My library<span>.</span>
          </h1>
          <p className="muted">A place for the things you want to keep.</p>
        </section>
        <LibraryBrowser
          refreshToken={browseRefresh}
          onUnauthorized={expireSession}
          onRefresh={() => void refresh().catch(fail)}
        />
        <section className="upload-panel" id="upload">
          <div className="upload-heading">
            <span className="upload-icon">
              <UploadCloud size={25} />
            </span>
            <div>
              <h2>
                {resume ? "Resume your upload" : "Make room for another memory"}
              </h2>
              <p className="muted">
                {resume
                  ? "Select the original file for " +
                    resume.media.originalFilename
                  : "Add a video or photo. Your original stays private."}
              </p>
            </div>
          </div>
          <label className="file-label">
            Choose a video or photo
            <input
              ref={fileInput}
              type="file"
              disabled={busy}
              accept=".mp4,.webm,.mkv,.mov,.avi,.jpg,.jpeg,.png,.webp,.gif,.heic"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <div className="upload-actions">
            <span className="muted">
              {file
                ? file.name + " · " + size(file.size)
                : "One file at a time. Resume whenever you need."}
            </span>
            <div>
              {resume && !busy && (
                <Button variant="ghost" onClick={() => setResume(null)}>
                  New upload
                </Button>
              )}
              {busy && controller.current ? (
                <Button
                  variant="secondary"
                  onClick={() => controller.current?.abort()}
                >
                  <Pause size={16} />
                  Pause
                </Button>
              ) : (
                <Button
                  disabled={busy || !file}
                  onClick={() => void uploadFile()}
                >
                  <UploadCloud size={17} />
                  {resume ? "Resume upload" : "Upload file"}
                </Button>
              )}
            </div>
          </div>
          {stage && (
            <div className="progress-block">
              <span>
                {stage} · {progress}%
              </span>
              <progress aria-label={stage} max={100} value={progress} />
            </div>
          )}
        </section>
        <p
          className="notice"
          role="status"
          aria-live="polite"
          aria-label="Upload status"
        >
          {message}
        </p>
        {uploads.length > 0 && (
          <section className="pending-section">
            <h2>
              In progress <span className="count">{uploads.length}</span>
            </h2>
            {uploads.map((item) => (
              <div className="pending-row" key={item.id}>
                <UploadCloud size={20} />
                <div>
                  <strong>{item.media.originalFilename}</strong>
                  <p className="muted">
                    {size(item.bytesUploaded)} of {size(item.totalBytes)} saved
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (item.completionStarted) void finish(item.id);
                    else {
                      setResume(item);
                      setFile(null);
                      if (fileInput.current) fileInput.current.value = "";
                      fileInput.current?.focus();
                    }
                  }}
                >
                  {item.completionStarted ? "Finish verification" : "Resume"}
                </Button>
                {!item.completionStarted && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setCancelId(item.id)}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            ))}
          </section>
        )}
        <StorageSettings />
        <footer className="library-footer">
          <Check size={14} /> Your library. No public links. No shared access.
        </footer>
      </main>
      <dialog ref={confirmation} onCancel={() => setCancelId(null)}>
        <h2>Cancel this upload?</h2>
        <p>
          Saved parts will be removed. Your original file on this device will
          stay untouched.
        </p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setCancelId(null)}>
            Keep upload
          </Button>
          <Button variant="danger" onClick={() => void cancelUpload()}>
            Cancel upload
          </Button>
        </div>
      </dialog>
    </div>
  );
}
