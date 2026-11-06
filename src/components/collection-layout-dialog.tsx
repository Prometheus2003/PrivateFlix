"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { ownerApi, ownerJson, OwnerApiError } from "@/client/api";
import { collectionLabel } from "@/client/collection-label";
import type { CollectionSummary } from "@/types/collections";
import { Button } from "./ui/button";
export function CollectionLayoutDialog({
  collections,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  collections: CollectionSummary[];
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const id = useId(),
    modal = useRef<HTMLDialogElement>(null),
    operation = useRef<AbortController | null>(null);
  const mounted = useRef(false),
    submitting = useRef(false);
  const [rows, setRows] = useState(collections),
    [selected, setSelected] = useState(collections[0]?.id ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const group = rows.find((row) => row.id === selected);
  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement,
      dialog = modal.current;
    dialog?.showModal();
    return () => {
      mounted.current = false;
      operation.current?.abort();
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  function move(index: number, offset: number) {
    setRows((previous) => {
      const next = [...previous];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  }
  function descendant(candidate: string) {
    let current: string | null = candidate;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === selected) return true;
      seen.add(current);
      current = rows.find((row) => row.id === current)?.parentId ?? null;
    }
    return false;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    operation.current = controller;
    try {
      await ownerApi("/api/collections/layout", {
        ...ownerJson("PUT", {
          collections: rows.map(({ id, parentId }) => ({ id, parentId })),
        }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20000),
        ]),
      });
      if (mounted.current) onSaved();
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      if (failure instanceof OwnerApiError && failure.status === 401)
        onUnauthorized();
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "Collection organization could not be saved.",
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
        if (!busy) onClose();
      }}
    >
      <h2 id={`${id}-title`}>Arrange collections</h2>
      <p className="muted">
        Reorder collections and choose their parents. Up to five levels are
        supported. Originals and memberships stay in place.
      </p>
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        <label className="library-field">
          Collection to nest
          <select
            aria-label="Collection to nest"
            value={selected}
            disabled={busy}
            onChange={(event) => setSelected(event.target.value)}
          >
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {collectionLabel(rows, row.id)}
              </option>
            ))}
          </select>
        </label>
        {group && (
          <label className="library-field">
            Parent collection
            <select
              aria-label="Parent collection"
              value={group.parentId ?? ""}
              disabled={busy}
              onChange={(event) =>
                setRows((previous) =>
                  previous.map((row) =>
                    row.id === selected
                      ? { ...row, parentId: event.target.value || null }
                      : row,
                  ),
                )
              }
            >
              <option value="">Top level</option>
              {rows
                .filter((row) => !descendant(row.id))
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {collectionLabel(rows, row.id)}
                  </option>
                ))}
            </select>
          </label>
        )}
        <ol className="collection-order-list" aria-label="Collection order">
          {rows.map((row, index) => (
            <li key={row.id}>
              <div>
                <strong>{row.name}</strong>
                {row.parentId && (
                  <p className="muted">
                    Inside {collectionLabel(rows, row.parentId)}
                  </p>
                )}
              </div>
              <div className="workspace-actions">
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Move ${row.name} up`}
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp size={18} aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Move ${row.name} down`}
                  disabled={busy || index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown size={18} aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
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
          <Button type="submit" disabled={busy || !rows.length}>
            {busy ? "Saving…" : "Save organization"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
