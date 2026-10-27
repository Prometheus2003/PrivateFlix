"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "./ui/button";

interface CollectionSummary {
  id: string;
  name: string;
  description: string;
  count: number;
}

interface CollectionDialogProps {
  mode: "create" | "edit" | "add" | "delete";
  collection?: CollectionSummary;
  media?: { id: string; title: string };
  collections: CollectionSummary[];
  onClose: () => void;
  onSaved: (message: string, collectionId?: string) => void;
  onUnauthorized: () => void;
}

const fieldsSchema = z.object({
  name: z.string().trim().min(1, "Enter a collection name.").max(80),
  description: z.string().trim().max(500),
});
const responseSchema = z.object({
  error: z.string().max(500).optional(),
  collection: z.object({ id: z.string().uuid() }).optional(),
});

export function CollectionDialog({
  mode,
  collection,
  media,
  collections,
  onClose,
  onSaved,
  onUnauthorized,
}: CollectionDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const collectionInput = useRef<HTMLSelectElement>(null);
  const id = useId();
  const [name, setName] = useState(collection?.name ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [selected, setSelected] = useState(collection?.id ?? "");
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    return () => {
      mounted.current = false;
      request.current?.abort();
      modal?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const title = {
    create: "New collection",
    edit: "Edit collection",
    add: "Add to collection",
    delete: "Delete collection?",
  }[mode];
  const action = {
    create: "Create collection",
    edit: "Save changes",
    add: "Add to collection",
    delete: "Delete collection",
  }[mode];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setError("");
    setNameError("");
    setSelectionError("");
    let path = "/api/collections";
    let method = "POST";
    let body: unknown;
    if (mode === "create" || mode === "edit") {
      const parsed = fieldsSchema.safeParse({ name, description });
      if (!parsed.success) {
        setNameError("Enter a collection name between 1 and 80 characters.");
        nameInput.current?.focus();
        return;
      }
      body = parsed.data;
      if (mode === "edit") {
        if (!collection) {
          setError(
            "This collection is unavailable. Close this window and refresh.",
          );
          return;
        }
        path += `/${collection.id}`;
        method = "PATCH";
      }
    } else if (mode === "add") {
      if (!collections.some((item) => item.id === selected) || !media) {
        setSelectionError("Choose a collection first.");
        collectionInput.current?.focus();
        return;
      }
      path += `/${selected}/items`;
      method = "PUT";
      body = { mediaId: media.id, present: true };
    } else {
      if (!collection) {
        setError(
          "This collection is unavailable. Close this window and refresh.",
        );
        return;
      }
      path += `/${collection.id}`;
      method = "DELETE";
    }
    const controller = new AbortController();
    request.current = controller;
    submitting.current = true;
    setBusy(true);
    try {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      if (!mounted.current) return;
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!response.ok)
        throw new Error(
          parsed.success && parsed.data.error
            ? parsed.data.error
            : "Your change could not be saved. Try again.",
        );
      if (!parsed.success || (mode === "create" && !parsed.data.collection))
        throw new Error(
          "The response could not be confirmed. Refresh your library before retrying.",
        );
      if (!mounted.current) return;
      const messages = {
        create: "Collection created.",
        edit: "Collection updated.",
        add: "Media added to collection.",
        delete: "Collection deleted. Your media is still in your library.",
      };
      onSaved(
        messages[mode],
        mode === "add"
          ? selected
          : (parsed.data.collection?.id ?? collection?.id),
      );
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      setError(
        failure instanceof DOMException && failure.name === "TimeoutError"
          ? "The request timed out. Refresh your library to check whether it was saved before retrying."
          : failure instanceof Error
            ? failure.message
            : "Your change could not be saved. Try again.",
      );
    } finally {
      submitting.current = false;
      if (request.current === controller) request.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="collection-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} aria-busy={busy} noValidate>
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-description`} className="dialog-copy">
          {mode === "delete"
            ? `Delete “${collection?.name ?? "this collection"}”? This removes the grouping only. Your original photos and videos stay in your library.`
            : mode === "add"
              ? `Choose a collection for “${media?.title ?? "this item"}”.`
              : "Keep related photos and videos together in your private library."}
        </p>
        {(mode === "create" || mode === "edit") && (
          <>
            <label className="library-field" htmlFor={`${id}-name`}>
              Collection name
              <input
                ref={nameInput}
                id={`${id}-name`}
                name="collectionName"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                required
                autoComplete="off"
                disabled={busy}
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? `${id}-name-error` : undefined}
              />
            </label>
            {nameError && (
              <p id={`${id}-name-error`} className="form-error">
                {nameError}
              </p>
            )}
            <label
              className="library-field"
              htmlFor={`${id}-description-field`}
            >
              Description <span className="muted">(optional)</span>
              <textarea
                aria-label="Description (optional)"
                id={`${id}-description-field`}
                name="collectionDescription"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={500}
                rows={3}
                disabled={busy}
              />
            </label>
          </>
        )}
        {mode === "add" &&
          (collections.length ? (
            <>
              <label className="library-field" htmlFor={`${id}-collection`}>
                Collection
                <select
                  aria-label="Collection"
                  ref={collectionInput}
                  id={`${id}-collection`}
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                  disabled={busy}
                  required
                  aria-invalid={Boolean(selectionError)}
                  aria-describedby={
                    selectionError ? `${id}-selection-error` : undefined
                  }
                >
                  <option value="">Choose a collection</option>
                  {collections.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectionError && (
                <p id={`${id}-selection-error`} className="form-error">
                  {selectionError}
                </p>
              )}
            </>
          ) : (
            <p className="dialog-copy">
              Create a collection in your library first, then add this item.
            </p>
          ))}
        <p role="alert" className="form-error">
          {error}
        </p>
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
            variant={mode === "delete" ? "danger" : "default"}
            disabled={busy || (mode === "add" && collections.length === 0)}
          >
            {busy ? "Saving…" : action}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
