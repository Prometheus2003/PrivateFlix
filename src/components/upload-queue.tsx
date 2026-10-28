"use client";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { z } from "zod";
import { UploadCloud, Pause } from "lucide-react";
import { ownerApi, OwnerApiError } from "@/client/api";
import {
  DuplicateUploadError,
  uploadResumable,
  validateUploadFile,
  type ResumableUpload,
} from "@/client/resumable-upload";
import { Button } from "./ui/button";
type State =
  | "queued"
  | "checking"
  | "uploading"
  | "verifying"
  | "paused"
  | "failed"
  | "duplicate"
  | "uploaded"
  | "invalid";
interface Entry {
  id: string;
  title: string;
  file: File | null;
  size: number;
  bytes: number;
  percent: number;
  state: State;
  error: string;
  resume?: ResumableUpload;
  allowDuplicate?: boolean;
}
const humanSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
export function UploadQueue({
  onUploaded,
  onUnauthorized,
  onBusy,
}: {
  onUploaded: () => void;
  onUnauthorized: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const queue = useRef<Entry[]>([]);
  const active = useRef(false);
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [limitError, setLimitError] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      onBusy(false);
    };
  }, [onBusy]);
  useEffect(() => {
    const abort = new AbortController();
    void ownerApi("/api/system/status", {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
    })
      .then((value) => {
        const data = z
          .object({ maxUploadBytes: z.number().positive() })
          .parse(value);
        if (!abort.signal.aborted) {
          setLimit(data.maxUploadBytes);
          setLimitError("");
        }
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        if (error instanceof OwnerApiError && error.status === 401)
          onUnauthorized();
        else
          setLimitError(
            "Upload limits could not be loaded. Retry before adding files.",
          );
      });
    return () => abort.abort();
  }, [onUnauthorized, revision]);
  function publish(next: Entry[]) {
    queue.current = next;
    if (alive.current) setEntries(next);
  }
  function patch(id: string, changes: Partial<Entry>) {
    publish(
      queue.current.map((entry) =>
        entry.id === id ? { ...entry, ...changes } : entry,
      ),
    );
  }
  function add(files: File[]) {
    if (active.current || !limit) {
      setMessage("Wait for the current operation before adding files.");
      return;
    }
    if (queue.current.length + files.length > 50) {
      setMessage(
        "Keep at most 50 files in the queue. Clear completed or skipped items first.",
      );
      return;
    }
    const additions = files.map((file) => {
      const entry: Entry = {
        id: crypto.randomUUID(),
        title: file.name,
        file,
        size: file.size,
        bytes: 0,
        percent: 0,
        state: "queued",
        error: "",
      };
      try {
        validateUploadFile(file, limit);
      } catch (error) {
        entry.state = "invalid";
        entry.error = error instanceof Error ? error.message : "Invalid file";
        entry.file = null;
      }
      return entry;
    });
    publish([...queue.current, ...additions]);
    setMessage(
      `${files.length} file${files.length === 1 ? "" : "s"} added. Review the queue, then start uploading.`,
    );
    if (picker.current) picker.current.value = "";
  }
  async function run(onlyId?: string, allowDuplicate = false) {
    if (active.current || !limit) return;
    const selected = queue.current.filter(
      (entry) =>
        entry.file &&
        (onlyId
          ? entry.id === onlyId
          : ["queued", "paused"].includes(entry.state)),
    );
    if (!selected.length) return;
    active.current = true;
    setBusy(true);
    onBusy(true);
    setMessage("");
    const abort = new AbortController();
    controller.current = abort;
    let saved = 0;
    try {
      for (const entry of selected) {
        if (abort.signal.aborted) break;
        if (!entry.file) continue;
        patch(entry.id, { state: "checking", error: "", percent: 0 });
        try {
          await uploadResumable(entry.file, {
            signal: abort.signal,
            resume: entry.resume,
            checkDuplicates: true,
            allowDuplicate: allowDuplicate || entry.allowDuplicate,
            onStarted: (resume) => patch(entry.id, { resume }),
            onProgress: (stage, percent, bytes) =>
              patch(entry.id, {
                state:
                  stage === "Checking your file"
                    ? "checking"
                    : stage === "Verifying upload"
                      ? "verifying"
                      : "uploading",
                percent,
                bytes,
              }),
          });
          saved++;
          patch(entry.id, {
            state: "uploaded",
            percent: 100,
            bytes: entry.size,
            file: null,
            error: "",
          });
          onUploaded();
        } catch (error) {
          if (!alive.current) return;
          if (abort.signal.aborted) {
            patch(entry.id, {
              state: "paused",
              error:
                "Saved parts can be resumed. Keep this page open or reselect the original in In progress after reloading.",
            });
            setMessage("Upload queue paused. Saved parts are retained.");
            break;
          }
          if (error instanceof OwnerApiError && error.status === 401) {
            onUnauthorized();
            return;
          }
          patch(entry.id, {
            state:
              error instanceof DuplicateUploadError ? "duplicate" : "failed",
            error:
              error instanceof Error
                ? error.message
                : "Upload failed. Try again.",
          });
        }
      }
      if (alive.current && !abort.signal.aborted)
        setMessage(
          saved
            ? `Upload saved privately: ${saved} file${saved === 1 ? "" : "s"}. Review any skipped or failed items below.`
            : "No files were uploaded. Review the queue messages below.",
        );
    } finally {
      controller.current = null;
      active.current = false;
      if (alive.current) {
        setBusy(false);
        onBusy(false);
        onUploaded();
      }
    }
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    add(Array.from(event.dataTransfer.files));
  }
  const total = entries.reduce((sum, entry) => sum + entry.size, 0),
    uploaded = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const ready = entries.some(
    (entry) => entry.file && ["queued", "paused"].includes(entry.state),
  );
  return (
    <div className="upload-queue" aria-label="Batch upload workspace">
      <div
        className="upload-dropzone"
        data-dragging={dragging}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <UploadCloud size={28} aria-hidden="true" />
        <h3>Drop photos and videos here</h3>
        <p className="muted">
          Up to 50 files in one queue. Uploads run one at a time.
        </p>
        <label className="file-label">
          Choose multiple videos or photos
          <input
            ref={picker}
            type="file"
            multiple
            disabled={busy || !limit}
            accept=".mp4,.webm,.mkv,.mov,.avi,.jpg,.jpeg,.png,.webp,.gif,.heic"
            onChange={(event) => add(Array.from(event.target.files ?? []))}
          />
        </label>
        <p className="muted">
          {limit
            ? `Maximum ${humanSize(limit)} per file. Identical originals need your choice before uploading again.`
            : "Loading upload limits…"}
        </p>
      </div>
      {limitError && (
        <div role="alert">
          <p>{limitError}</p>
          <Button
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry upload limits
          </Button>
        </div>
      )}
      {entries.length > 0 && (
        <>
          <div className="upload-actions">
            <p>
              {entries.length} files · {humanSize(uploaded)} of{" "}
              {humanSize(total)} saved
            </p>
            <div className="workspace-actions">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  publish(
                    queue.current.filter(
                      (entry) =>
                        !["uploaded", "invalid", "duplicate"].includes(
                          entry.state,
                        ),
                    ),
                  )
                }
              >
                Clear completed and skipped
              </Button>
              {busy ? (
                <Button
                  variant="secondary"
                  onClick={() => controller.current?.abort()}
                >
                  <Pause size={16} aria-hidden="true" />
                  Pause queue
                </Button>
              ) : (
                <Button disabled={!ready || !limit} onClick={() => void run()}>
                  Start upload queue
                </Button>
              )}
            </div>
          </div>
          <ol className="upload-queue-list" aria-label="Upload queue files">
            {entries.map((entry) => (
              <li key={entry.id} className="upload-queue-row">
                <div>
                  <strong>{entry.title}</strong>
                  <p className="muted">
                    {humanSize(entry.size)} · {entry.state}
                    {["checking", "uploading", "verifying"].includes(
                      entry.state,
                    )
                      ? ` · ${entry.percent}%`
                      : ""}
                  </p>
                </div>
                {["checking", "uploading", "verifying"].includes(
                  entry.state,
                ) && (
                  <progress
                    aria-label={`Upload progress: ${entry.title}`}
                    value={entry.percent}
                    max={100}
                  />
                )}
                {entry.error && (
                  <p
                    className={
                      entry.state === "duplicate" ? "muted" : "form-error"
                    }
                  >
                    {entry.error}
                  </p>
                )}
                <div className="workspace-actions">
                  {entry.file && ["failed", "paused"].includes(entry.state) && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void run(entry.id)}
                    >
                      Retry file
                    </Button>
                  )}
                  {entry.state === "duplicate" && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        patch(entry.id, { allowDuplicate: true });
                        void run(entry.id, true);
                      }}
                    >
                      Upload duplicate
                    </Button>
                  )}
                  {!busy &&
                    !["checking", "uploading", "verifying"].includes(
                      entry.state,
                    ) && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          publish(
                            queue.current.filter(
                              (item) => item.id !== entry.id,
                            ),
                          );
                          setMessage(
                            entry.resume
                              ? "Removed from this queue. Saved upload parts remain in In progress below; cancel there to remove them."
                              : "Removed from this queue.",
                          );
                        }}
                      >
                        Remove from queue
                      </Button>
                    )}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      <p role="status" aria-label="Queue status">
        {message}
      </p>
      <p className="muted">
        Queued file selections stay in this tab. After a reload, use In progress
        and reselect each original to resume saved parts. Processing status
        appears in Your media after upload.
      </p>
    </div>
  );
}
