"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ownerApi, OwnerApiError } from "@/client/api";
import { Button } from "./ui/button";
const schema = z.object({
  uploads: z.array(
    z.object({
      id: z.string().uuid(),
      status: z.string(),
      totalBytes: z.number(),
      bytesUploaded: z.number(),
      createdAt: z.string(),
      reason: z.string().nullable(),
      media: z
        .object({
          id: z.string().uuid(),
          title: z.string(),
          processingStatus: z.string(),
        })
        .nullable(),
    }),
  ),
  hasMore: z.boolean(),
});
export function UploadHistory({
  refreshToken,
  onUnauthorized,
}: {
  refreshToken: number;
  onUnauthorized: () => void;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [data, setData] = useState<z.infer<typeof schema> | null>(null),
    [error, setError] = useState("");
  const [loadedKey, setLoadedKey] = useState("");
  const requestKey = `${page}-${revision}-${refreshToken}`;
  const loading = open && loadedKey !== requestKey;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void ownerApi(`/api/media/upload-history?page=${page}&limit=20`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
      .then((value) => {
        const next = schema.parse(value);
        if (!controller.signal.aborted) {
          setData(next);
          setError("");
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else setError("Upload history could not be loaded. Try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadedKey(requestKey);
      });
    return () => controller.abort();
  }, [open, page, revision, refreshToken, onUnauthorized, requestKey]);
  return (
    <details
      className="upload-history"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Upload history</summary>
      <div className="workspace-actions">
        <p className="muted">Recent transfers and processing outcomes</p>
        <Button
          variant="secondary"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh upload history
        </Button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : loading ? (
        <div
          className="metadata-skeleton"
          aria-label="Loading upload history"
        />
      ) : data?.uploads.length ? (
        <ol className="upload-queue-list" aria-label="Upload history records">
          {data.uploads.map((row) => (
            <li key={row.id} className="upload-queue-row">
              <strong>{row.media?.title ?? "Removed media"}</strong>
              <p className="muted">
                {new Date(row.createdAt).toLocaleString()} ·{" "}
                {row.media?.processingStatus.toLowerCase() ??
                  row.status.toLowerCase()}{" "}
                · {(row.bytesUploaded / 1024 ** 2).toFixed(1)} of{" "}
                {(row.totalBytes / 1024 ** 2).toFixed(1)} MiB
              </p>
              {row.reason && <p>{row.reason}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <p>No upload history yet.</p>
      )}
      <div className="pagination">
        <Button
          variant="ghost"
          disabled={loading || page === 1}
          onClick={() => setPage((value) => value - 1)}
        >
          Previous upload history
        </Button>
        <span>Page {page}</span>
        <Button
          variant="ghost"
          disabled={loading || !data?.hasMore}
          onClick={() => setPage((value) => value + 1)}
        >
          Next upload history
        </Button>
      </div>
    </details>
  );
}
