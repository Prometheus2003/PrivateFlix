"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { z } from "zod";
import { History, Play, Check, Trash2 } from "lucide-react";
import { ownerApi, ownerJson, OwnerApiError } from "@/client/api";
import { Button } from "./ui/button";
import { MediaViewer } from "./media-viewer";
const itemSchema = z.object({
  positionSeconds: z.number(),
  durationSeconds: z.number(),
  completed: z.boolean(),
  lastPlayedAt: z.string(),
  media: z.object({
    id: z.string().uuid(),
    title: z.string(),
    type: z.literal("VIDEO"),
    hasThumbnail: z.boolean(),
  }),
});
type Item = z.infer<typeof itemSchema>;
export function playbackTime(seconds: number) {
  const rounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}
export function HistoryPanel({
  refreshToken,
  onUnauthorized,
}: {
  refreshToken: number;
  onUnauthorized: () => void;
}) {
  const [mode, setMode] = useState<"continue" | "history">("continue");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [viewing, setViewing] = useState<Item | null>(null);
  const [remove, setRemove] = useState<Item | "all" | null>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void ownerApi(`/api/playback?mode=${mode}&page=${page}&limit=10`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
      .then((result) => {
        const data = z
          .object({ items: z.array(itemSchema), hasMore: z.boolean() })
          .parse(result);
        if (!controller.signal.aborted) {
          setItems(data.items);
          setHasMore(data.hasMore);
          setLoading(false);
          if (!data.items.length && page > 1) {
            setPage(page - 1);
            setLoading(true);
          }
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else {
          setMessage(
            "History could not be loaded. Use Refresh history to retry.",
          );
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [mode, page, revision, refreshToken, onUnauthorized]);
  useEffect(() => {
    const modal = confirmation.current;
    if (!remove) return;
    const opener = document.activeElement;
    modal?.showModal();
    return () => {
      modal?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [remove]);
  useEffect(() => () => mutation.current?.abort(), []);
  function refresh() {
    setLoading(true);
    setMessage("");
    setRevision((value) => value + 1);
  }
  async function update(item: Item | "all", action: "remove" | "watched") {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setMessage("");
    try {
      await ownerApi(
        item === "all" ? "/api/playback" : `/api/playback/${item.media.id}`,
        {
          ...ownerJson(
            action === "remove" ? "DELETE" : "PUT",
            item === "all"
              ? { confirm: true }
              : action === "remove"
                ? undefined
                : {
                    positionSeconds: item.completed ? 0 : item.durationSeconds,
                    completed: !item.completed,
                  },
          ),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      if (!controller.signal.aborted) {
        setRemove(null);
        refresh();
        setMessage(
          action === "remove"
            ? "History removed. Your media is unchanged."
            : "Watch state saved.",
        );
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else
          setMessage(
            failure instanceof Error
              ? failure.message
              : "History could not be updated.",
          );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      mutation.current = null;
    }
  }
  return (
    <section
      id="history"
      className="workspace-panel"
      aria-labelledby="history-title"
      aria-busy={loading}
    >
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">PICK UP WHERE YOU LEFT OFF</p>
          <h2 id="history-title">
            <History size={22} aria-hidden="true" /> Your viewing
          </h2>
          <p className="muted">
            Playback history stays in your private library.
          </p>
        </div>
        <div className="workspace-actions">
          <Button variant="secondary" onClick={refresh} disabled={loading}>
            Refresh history
          </Button>
          <Button
            variant="ghost"
            disabled={busy || loading}
            onClick={() => setRemove("all")}
          >
            Clear history
          </Button>
        </div>
      </div>
      <div className="workspace-actions" role="group" aria-label="History view">
        <Button
          variant={mode === "continue" ? "default" : "secondary"}
          aria-pressed={mode === "continue"}
          onClick={() => {
            if (mode === "continue" && page === 1) return;
            setMode("continue");
            setPage(1);
            setLoading(true);
          }}
        >
          Continue watching
        </Button>
        <Button
          variant={mode === "history" ? "default" : "secondary"}
          aria-pressed={mode === "history"}
          onClick={() => {
            if (mode === "history" && page === 1) return;
            setMode("history");
            setPage(1);
            setLoading(true);
          }}
        >
          Recently watched
        </Button>
      </div>
      <p className="notice" role="status" aria-label="History updates">
        {message}
      </p>
      {loading ? (
        <div className="settings-skeleton" aria-label="Loading history" />
      ) : items.length ? (
        <div className="history-list">
          {items.map((item) => (
            <article
              key={item.media.id}
              className="history-row"
              aria-label={item.media.title}
            >
              {item.media.hasThumbnail && (
                <Image
                  src={`/api/media/${item.media.id}/thumbnail`}
                  width={160}
                  height={90}
                  alt=""
                  unoptimized
                />
              )}
              <div className="history-details">
                <h3>{item.media.title}</h3>
                <p className="muted">
                  {item.completed
                    ? "Watched"
                    : `${playbackTime(item.positionSeconds)} of ${playbackTime(item.durationSeconds)}`}{" "}
                  · {new Date(item.lastPlayedAt).toLocaleDateString()}
                </p>
                <progress
                  aria-label={`Progress: ${item.media.title}`}
                  max={item.durationSeconds || 1}
                  value={
                    item.completed ? item.durationSeconds : item.positionSeconds
                  }
                />
              </div>
              <div className="workspace-actions">
                <Button variant="secondary" onClick={() => setViewing(item)}>
                  <Play size={16} aria-hidden="true" />
                  {item.completed ? "Watch again" : "Resume"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void update(item, "watched")}
                >
                  <Check size={16} aria-hidden="true" />
                  {item.completed ? "Mark unwatched" : "Mark watched"}
                </Button>
                <button
                  className="icon-control"
                  aria-label={`Remove from history: ${item.media.title}`}
                  disabled={busy}
                  onClick={() => setRemove(item)}
                >
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="empty-history">
          {mode === "continue"
            ? "Videos you start will appear here so you can return to them."
            : "Your recently watched videos will appear here."}
        </p>
      )}
      <div className="pagination">
        <Button
          variant="ghost"
          disabled={page === 1 || loading}
          onClick={() => {
            setPage(page - 1);
            setLoading(true);
          }}
        >
          Previous history
        </Button>
        <span>Page {page}</span>
        <Button
          variant="ghost"
          disabled={!hasMore || loading}
          onClick={() => {
            setPage(page + 1);
            setLoading(true);
          }}
        >
          Next history
        </Button>
      </div>
      {viewing && (
        <MediaViewer
          key={viewing.media.id}
          media={viewing.media}
          onUnauthorized={onUnauthorized}
          onClose={() => {
            setViewing(null);
            refresh();
          }}
        />
      )}
      {remove && (
        <dialog
          ref={confirmation}
          aria-labelledby="history-confirm-title"
          onCancel={(event) => {
            if (busy) event.preventDefault();
            else setRemove(null);
          }}
        >
          <h2 id="history-confirm-title">
            {remove === "all"
              ? "Clear all viewing history?"
              : "Remove from history?"}
          </h2>
          <p>
            Saved playback positions and watch states will be removed. Your
            videos stay in your library.
          </p>
          <p role="alert">{message}</p>
          <div className="dialog-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRemove(null)}
            >
              Keep history
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void update(remove, "remove")}
            >
              {busy ? "Removing…" : "Remove history"}
            </Button>
          </div>
        </dialog>
      )}
    </section>
  );
}
