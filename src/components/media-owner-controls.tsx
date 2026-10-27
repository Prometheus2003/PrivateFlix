"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Heart, Pencil, Trash2 } from "lucide-react";
import { ownerApi, ownerJson, OwnerApiError } from "@/client/api";
import { Button } from "./ui/button";
import { MediaDetailsDialog } from "./media-details-dialog";
import { BulkMediaDialog } from "./bulk-media-dialog";
const schema = z.object({
  media: z.object({
    id: z.string().uuid(),
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    isFavorite: z.boolean(),
    collections: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
});
export function MediaOwnerControls({
  media,
  onUnauthorized,
  onDeleting,
  onDeleted,
}: {
  media: { id: string; title: string; type: string };
  onUnauthorized?: () => void;
  onDeleting: () => void;
  onDeleted: () => void;
}) {
  const [details, setDetails] = useState<
    z.infer<typeof schema>["media"] | null
  >(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      operation.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void ownerApi(`/api/media/${media.id}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
      .then((value) => {
        const result = schema.parse(value);
        if (!controller.signal.aborted) {
          setDetails(result.media);
          setError("");
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized?.();
        else setError("Media details could not be loaded.");
      });
    return () => controller.abort();
  }, [media.id, revision, onUnauthorized]);
  async function favorite() {
    if (!details || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    operation.current = controller;
    try {
      const result = z.object({ isFavorite: z.boolean() }).parse(
        await ownerApi(`/api/media/${media.id}/favorite`, {
          ...ownerJson("PUT", { favorite: !details.isFavorite }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        }),
      );
      if (alive.current)
        setDetails({ ...details, isFavorite: result.isFavorite });
    } catch (failure) {
      if (!alive.current || controller.signal.aborted) return;
      if (failure instanceof OwnerApiError && failure.status === 401)
        onUnauthorized?.();
      else setError("Your favorite could not be saved. Try again.");
    } finally {
      submitting.current = false;
      operation.current = null;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="viewer-metadata" aria-label="Media information">
      {details ? (
        <>
          <h3>{details.title}</h3>
          {details.description && (
            <p className="media-description">{details.description}</p>
          )}
          {details.tags.length > 0 && (
            <p className="muted">Tags: {details.tags.join(", ")}</p>
          )}
          {details.collections.length > 0 && (
            <p className="muted">
              Collections:{" "}
              {details.collections.map((group) => group.name).join(", ")}
            </p>
          )}
        </>
      ) : (
        !error && (
          <div
            className="metadata-skeleton"
            aria-label="Loading media information"
          />
        )
      )}
      <div className="workspace-actions">
        <Button
          variant="secondary"
          disabled={!details || busy}
          aria-pressed={details?.isFavorite ?? false}
          onClick={() => void favorite()}
        >
          <Heart
            size={16}
            fill={details?.isFavorite ? "currentColor" : "none"}
            aria-hidden="true"
          />
          {details?.isFavorite ? "Remove favorite" : "Favorite media"}
        </Button>
        <Button variant="secondary" onClick={() => setEditing(true)}>
          <Pencil size={16} aria-hidden="true" />
          Edit media details
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            onDeleting();
            setDeleting(true);
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
          Delete this media
        </Button>
      </div>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            Reload media information
          </Button>
        </div>
      )}
      {editing && (
        <MediaDetailsDialog
          mediaId={media.id}
          onUnauthorized={() => onUnauthorized?.()}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {deleting && (
        <BulkMediaDialog
          action="delete"
          items={[
            {
              id: media.id,
              title: details?.title ?? media.title,
              processingStatus: "READY",
            },
          ]}
          collections={[]}
          onUnauthorized={() => onUnauthorized?.()}
          onClose={() => setDeleting(false)}
          onSaved={onDeleted}
        />
      )}
    </section>
  );
}
