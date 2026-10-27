"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { ownerApi, ownerJson, OwnerApiError } from "@/client/api";
import { Button } from "./ui/button";
export type BulkAction =
  | "addcollection"
  | "movecollection"
  | "addtags"
  | "replacetags"
  | "removetags"
  | "delete";
export interface BulkItem {
  id: string;
  title: string;
  processingStatus: string;
}
export function BulkMediaDialog({
  action,
  items,
  collections,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  action: BulkAction;
  items: BulkItem[];
  collections: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (message: string) => void;
  onUnauthorized: () => void;
}) {
  const id = useId();
  const modal = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isCollection = action.endsWith("collection"),
    isTags = action.endsWith("tags");
  const title = {
    addcollection: "Add to collection",
    movecollection: "Move to collection",
    addtags: "Add tags",
    replacetags: "Replace tags",
    removetags: "Remove tags",
    delete: "Delete selected media?",
  }[action];
  const canDelete = items.every((item) =>
    ["READY", "FAILED"].includes(item.processingStatus),
  );
  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement;
    const element = modal.current;
    element?.showModal();
    return () => {
      mounted.current = false;
      operation.current?.abort();
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const fields = new FormData(event.currentTarget);
    let payload: unknown;
    if (isCollection) {
      const collectionId = String(fields.get("collection") ?? "");
      if (action === "addcollection" && !collectionId) {
        setError("Choose a collection.");
        return;
      }
      payload = {
        action: "collection",
        mediaIds: items.map((item) => item.id),
        collectionId: collectionId || null,
        mode: action === "movecollection" ? "move" : "add",
      };
    } else if (isTags) {
      const tags = String(fields.get("tags") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (
        tags.length > 20 ||
        tags.some((tag) => tag.length > 40) ||
        (action !== "replacetags" && !tags.length)
      ) {
        setError("Enter up to 20 tags, each at most 40 characters.");
        return;
      }
      payload = {
        action: "tags",
        mediaIds: items.map((item) => item.id),
        tags,
        mode:
          action === "addtags"
            ? "add"
            : action === "replacetags"
              ? "replace"
              : "remove",
      };
    } else {
      if (!canDelete) return;
      payload = {
        action: "delete",
        mediaIds: items.map((item) => item.id),
        confirm: true,
      };
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    operation.current = controller;
    try {
      const result = z
        .object({
          updated: z.number().int().nonnegative(),
          deletionQueued: z.boolean(),
        })
        .parse(
          await ownerApi("/api/media/bulk", {
            ...ownerJson("POST", payload),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(20000),
            ]),
          }),
        );
      if (result.updated !== items.length)
        throw new Error(
          "The result could not be confirmed. Refresh your library before retrying.",
        );
      if (mounted.current)
        onSaved(
          action === "delete"
            ? `${items.length} item${items.length === 1 ? "" : "s"} hidden. Permanent storage cleanup is queued.`
            : `Updated ${items.length} selected item${items.length === 1 ? "" : "s"}.`,
        );
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      if (failure instanceof OwnerApiError && failure.status === 401)
        onUnauthorized();
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "The selected media could not be updated.",
        );
    } finally {
      submitting.current = false;
      operation.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={modal}
      className="collection-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      <p className="muted">
        {items.length} selected item{items.length === 1 ? "" : "s"}
      </p>
      <ul className="bulk-review">
        {items.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ul>
      <form className="settings-form" onSubmit={(event) => void submit(event)}>
        {isCollection && (
          <>
            <label className="library-field">
              Target collection
              <select
                name="collection"
                aria-label="Target collection"
                required={action === "addcollection"}
                disabled={busy}
                defaultValue=""
              >
                <option value="" disabled={action === "addcollection"}>
                  {action === "movecollection"
                    ? "No collection (unfiled)"
                    : "Choose a collection"}
                </option>
                {collections.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {action === "movecollection"
                ? "Moving removes other collection memberships. Your originals stay in storage."
                : "Adds membership while keeping existing collections."}
            </p>
            {!collections.length && (
              <p className="muted">
                Create a collection in Your media to choose it here.
              </p>
            )}
          </>
        )}
        {isTags && (
          <>
            <label className="library-field">
              Tags
              <input
                name="tags"
                aria-label="Tags for selected media"
                maxLength={840}
                disabled={busy}
                placeholder="travel, family"
              />
            </label>
            <p className="muted">
              Separate tags with commas.{" "}
              {action === "replacetags"
                ? "This replaces existing tags; leave blank to clear them."
                : action === "removetags"
                  ? "Only the named tags will be removed."
                  : "Existing tags are kept."}
            </p>
          </>
        )}
        {action === "delete" && (
          <>
            <p>
              This permanently deletes the selected originals and generated
              files. Items disappear from your library now; storage cleanup
              starts after 30 minutes while PrivateFlix is running.
            </p>
            <p className="muted">
              This does not remove copies retained in backups. Deletion is
              separate from removing a collection membership.
            </p>
            {!canDelete && (
              <p role="alert">
                Wait for processing or cancel unfinished uploads before deleting
                these items.
              </p>
            )}
          </>
        )}
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
          <Button
            type="submit"
            variant={action === "delete" ? "danger" : "default"}
            disabled={
              busy ||
              (action === "delete" && !canDelete) ||
              (action === "addcollection" && !collections.length)
            }
          >
            {busy
              ? "Saving…"
              : action === "delete"
                ? "Queue permanent deletion"
                : "Apply changes"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
