"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { ownerApi, ownerJson, OwnerApiError } from "@/client/api";
import { Button } from "./ui/button";
const detailsSchema = z.object({
  media: z.object({
    id: z.string().uuid(),
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    collections: z.array(z.object({ id: z.string(), name: z.string() })),
    mimeType: z.string(),
    duration: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
  }),
});
export function MediaDetailsDialog({
  mediaId,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  mediaId: string;
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const id = useId();
  const modal = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const operation = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const saving = useRef(false);
  const [details, setDetails] = useState<
    z.infer<typeof detailsSchema>["media"] | null
  >(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    alive.current = true;
    const opener = document.activeElement;
    const dialog = modal.current;
    dialog?.showModal();
    return () => {
      alive.current = false;
      operation.current?.abort();
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void ownerApi(`/api/media/${mediaId}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
      .then((value) => {
        const result = detailsSchema.parse(value);
        if (!controller.signal.aborted) {
          setDetails(result.media);
          setError("");
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else setError("Details could not be loaded. Try again.");
      });
    return () => controller.abort();
  }, [mediaId, revision, onUnauthorized]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || !details) return;
    const fields = new FormData(event.currentTarget);
    const tags = String(fields.get("tags") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (tags.length > 20 || tags.some((value) => value.length > 40)) {
      setError("Use up to 20 tags, each at most 40 characters.");
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    operation.current = controller;
    try {
      await ownerApi(`/api/media/${mediaId}`, {
        ...ownerJson("PATCH", {
          title: fields.get("title"),
          description: fields.get("description"),
          tags,
        }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
      });
      if (alive.current) onSaved();
    } catch (failure) {
      if (!alive.current || controller.signal.aborted) return;
      if (failure instanceof OwnerApiError && failure.status === 401)
        onUnauthorized();
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "Metadata could not be saved.",
        );
    } finally {
      saving.current = false;
      operation.current = null;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      className="collection-dialog"
      ref={modal}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={`${id}-title`}>Media details</h2>
      {details ? (
        <form
          ref={form}
          className="settings-form"
          onSubmit={(event) => void submit(event)}
        >
          <label className="library-field">
            Title
            <input
              name="title"
              defaultValue={details.title}
              required
              maxLength={300}
              disabled={busy}
            />
          </label>
          <label className="library-field">
            Description
            <textarea
              name="description"
              aria-label="Media description"
              defaultValue={details.description}
              rows={4}
              maxLength={2000}
              disabled={busy}
            />
          </label>
          <label className="library-field">
            Tags
            <input
              name="tags"
              defaultValue={details.tags.join(", ")}
              placeholder="travel, family, favorites"
              maxLength={840}
              disabled={busy}
            />
          </label>
          <p className="muted">
            Separate tags with commas. Up to 20 tags, 40 characters each.
          </p>
          <p className="muted">
            Collections:{" "}
            {details.collections.length
              ? details.collections.map((item) => item.name).join(", ")
              : "No collections yet"}
          </p>
          <p className="muted">
            {details.mimeType}
            {details.width && details.height
              ? ` · ${details.width} × ${details.height}`
              : ""}
            {details.duration
              ? ` · ${Math.round(details.duration)} seconds`
              : ""}
          </p>
          <p role="alert">{error}</p>
          <div className="dialog-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save media details"}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div
            className="settings-skeleton"
            aria-label="Loading media details"
          />
          {error && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            {error && (
              <Button onClick={() => setRevision((value) => value + 1)}>
                Try again
              </Button>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
