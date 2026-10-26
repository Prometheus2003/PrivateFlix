"use client";

import { useEffect, useState } from "react";
import { Cloud, HardDrive, ExternalLink } from "lucide-react";
import { z } from "zod";
import { Button } from "./ui/button";

const statusSchema = z.object({
  uploadDestination: z.enum(["s3", "google-drive"]),
  driveConfigured: z.boolean(),
  connectionStatus: z.literal("not-checked"),
  maxUploadBytes: z.number().positive().safe(),
});
type StorageStatus = z.infer<typeof statusSchema>;

export function StorageSettings() {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/system/storage", {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "Sign in again to view your storage settings."
              : "Storage settings could not be loaded. Try refreshing them.",
          );
        const next = statusSchema.parse(await response.json());
        if (!controller.signal.aborted) setStatus(next);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error && failure.message.startsWith("Sign in")
              ? failure.message
              : "Storage settings could not be loaded. Try refreshing them.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refresh]);

  const usesDrive = status?.uploadDestination === "google-drive";
  return (
    <section
      id="storage"
      aria-labelledby="storage-title"
      aria-busy={loading}
      className="mt-8 min-w-0 rounded-xl border border-[var(--border)] p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <HardDrive aria-hidden="true" size={23} className="shrink-0 muted" />
          <div>
            <h2 id="storage-title">Your storage</h2>
            <p className="muted">Choose where your collection grows.</p>
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="min-h-11"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError("");
            setRefresh((value) => value + 1);
          }}
        >
          {loading ? "Loading settings…" : "Refresh settings"}
        </Button>
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-label="Storage status"
        className="mt-4"
      >
        {loading && !status ? (
          <div
            aria-label="Loading storage settings"
            className="h-20 rounded-lg border border-[var(--border)] bg-[var(--background)]"
          />
        ) : error ? (
          <p>{error}</p>
        ) : status ? (
          <>
            <p className="flex items-center gap-2 font-semibold">
              {usesDrive ? (
                <Cloud aria-hidden="true" size={18} />
              ) : (
                <HardDrive aria-hidden="true" size={18} />
              )}
              New uploads: {usesDrive ? "Google Drive" : "S3 / MinIO"}
            </p>
            <p className="muted mt-1">
              {status.driveConfigured
                ? "Google Drive is configured. Confirm access with a small upload, playback and download."
                : "Google Drive is not configured yet. Connect your account to use its storage for new uploads."}
            </p>
            <p className="muted mt-1">
              File limit:{" "}
              {(status.maxUploadBytes / 1024 ** 3).toLocaleString(undefined, {
                maximumFractionDigits: 1,
              })}{" "}
              GiB. Existing media keeps its current storage location.
            </p>
          </>
        ) : null}
      </div>
      <details className="mt-5 border-t border-[var(--border)] pt-3">
        <summary className="min-h-11 cursor-pointer rounded py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]">
          Set up Google Drive storage
        </summary>
        <div className="mt-2 max-w-3xl space-y-4 leading-relaxed">
          <ol className="list-decimal space-y-3 pl-5">
            <li>
              Open{" "}
              <a
                href="https://console.cloud.google.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1 underline underline-offset-4"
              >
                Google Cloud Console
                <ExternalLink aria-hidden="true" size={14} />
                <span className="sr-only"> (opens a new tab)</span>
              </a>
              , create a PrivateFlix project, and enable the Google Drive API.
            </li>
            <li>
              Configure Google Auth Platform for your account. Create a Desktop
              app OAuth client and download its JSON file to a private folder on
              your computer.
            </li>
            <li>
              In the PrivateFlix terminal, run the connection command using your
              downloaded file:
              <code className="mt-2 block break-all rounded-lg border border-[var(--border)] p-3 text-sm">
                npm run drive:connect --
                &quot;C:\path\to\oauth-client.json&quot;
              </code>
              Follow the Google consent page printed in the terminal.
            </li>
            <li>
              Apply database migrations, restart PrivateFlix and its processing
              worker, then test a small upload. The full walkthrough is in the
              project’s
              <code> docs/GOOGLE_DRIVE.md</code> file.
            </li>
          </ol>
          <p className="muted">
            PrivateFlix creates a private storage folder in Drive. Keep it
            private. Local disk is still used temporarily while uploads and
            media processing finish.
          </p>
        </div>
      </details>
    </section>
  );
}
