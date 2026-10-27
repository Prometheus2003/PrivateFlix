"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { z } from "zod";
import { ListVideo, ArrowUp, ArrowDown, Play, Trash2 } from "lucide-react";
import { ownerApi, ownerJson, OwnerApiError } from "@/client/api";
import { Button } from "./ui/button";
import { MediaViewer } from "./media-viewer";
const playlistSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  count: z.number(),
});
const itemSchema = z.object({
  position: z.number(),
  media: z.object({
    id: z.string().uuid(),
    title: z.string(),
    type: z.literal("VIDEO"),
    hasThumbnail: z.boolean(),
  }),
});
type Playlist = z.infer<typeof playlistSchema>;
type Item = z.infer<typeof itemSchema>;
export function PlaylistPanel({
  refreshToken,
  onUnauthorized,
  onPlaybackChange,
}: {
  refreshToken: number;
  onUnauthorized: () => void;
  onPlaybackChange: () => void;
}) {
  const [groups, setGroups] = useState<Playlist[]>([]);
  const [selected, setSelected] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<"create" | "edit" | "delete" | null>(
    null,
  );
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<number | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const active = useRef(false);
  const submitting = useRef(false);
  const group = groups.find((value) => value.id === selected);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      operation.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20000),
    ]);
    void Promise.all([
      ownerApi("/api/playlists?limit=100", { signal }),
      selected
        ? ownerApi(`/api/playlists/${selected}?limit=100`, { signal })
        : Promise.resolve({ items: [] }),
    ])
      .then(([list, contents]) => {
        const playlists = z
          .object({ playlists: z.array(playlistSchema) })
          .parse(list).playlists;
        const videos = z
          .object({ items: z.array(itemSchema) })
          .parse(contents).items;
        if (!controller.signal.aborted) {
          setGroups(playlists);
          setItems(videos);
          setLoading(false);
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else {
          setMessage(
            "Playlists could not be loaded. Refresh playlists to retry.",
          );
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [selected, revision, refreshToken, onUnauthorized]);
  useEffect(() => {
    if (!dialog) return;
    const element = modal.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [dialog]);
  function refresh() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  async function mutate(path: string, options: RequestInit, done: () => void) {
    if (submitting.current) return;
    submitting.current = true;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await ownerApi(path, {
        ...options,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
      });
      if (active.current) done();
    } catch (failure) {
      if (active.current && !controller.signal.aborted) {
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else {
          const text =
            failure instanceof Error
              ? failure.message
              : "Playlist could not be updated.";
          setError(text);
          setMessage(text);
        }
      }
    } finally {
      submitting.current = false;
      operation.current = null;
      if (active.current) setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog) return;
    const fields = new FormData(event.currentTarget);
    await mutate(
      dialog === "create" ? "/api/playlists" : `/api/playlists/${selected}`,
      dialog === "delete"
        ? { method: "DELETE" }
        : ownerJson(dialog === "create" ? "POST" : "PATCH", {
            name: fields.get("name"),
            description: fields.get("description"),
          }),
      () => {
        setDialog(null);
        if (dialog === "delete") setSelected("");
        setMessage(
          dialog === "delete"
            ? "Playlist deleted. Your videos are still in your library."
            : "Playlist saved.",
        );
        refresh();
      },
    );
  }
  function reorder(index: number, offset: number) {
    const next = items.map((item) => item.media.id);
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    void mutate(
      `/api/playlists/${selected}/order`,
      ownerJson("PUT", { mediaIds: next }),
      () => {
        setMessage("Playlist order saved.");
        refresh();
      },
    );
  }
  return (
    <section
      id="playlists"
      className="workspace-panel"
      aria-labelledby="playlists-title"
      aria-busy={loading}
    >
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">LINE UP YOUR NEXT WATCH</p>
          <h2 id="playlists-title">
            <ListVideo size={22} aria-hidden="true" />
            Your playlists
          </h2>
          <p className="muted">
            Private video queues, in the order you choose.
          </p>
        </div>
        <div className="workspace-actions">
          <Button variant="secondary" disabled={loading} onClick={refresh}>
            Refresh playlists
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setError("");
              setDialog("create");
            }}
          >
            New playlist
          </Button>
        </div>
      </div>
      <label className="library-field">
        Playlist
        <select
          aria-label="Playlist"
          value={selected}
          disabled={busy || loading}
          onChange={(event) => {
            setSelected(event.target.value);
            setLoading(true);
            setMessage("");
          }}
        >
          <option value="">Choose a playlist</option>
          {groups.map((value) => (
            <option value={value.id} key={value.id}>
              {value.name} ({value.count})
            </option>
          ))}
        </select>
      </label>
      <p role="status" className="notice" aria-label="Playlist updates">
        {message}
      </p>
      {group && (
        <div className="workspace-heading">
          <div>
            <h3>{group.name}</h3>
            <p className="muted">{group.description}</p>
          </div>
          <div className="workspace-actions">
            <Button
              variant="secondary"
              disabled={busy || !items.length}
              onClick={() => setViewing(0)}
            >
              Play playlist
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setError("");
                setDialog("edit");
              }}
            >
              Edit playlist
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setError("");
                setDialog("delete");
              }}
            >
              Delete playlist
            </Button>
          </div>
        </div>
      )}
      {loading ? (
        <div className="settings-skeleton" aria-label="Loading playlists" />
      ) : selected && items.length ? (
        <ol className="playlist-items">
          {items.map((item, index) => (
            <li
              key={item.media.id}
              className="history-row"
              aria-label={item.media.title}
            >
              {item.media.hasThumbnail && (
                <Image
                  src={`/api/media/${item.media.id}/thumbnail`}
                  alt=""
                  width={128}
                  height={72}
                  unoptimized
                />
              )}
              <h3 className="history-details">
                {index + 1}. {item.media.title}
              </h3>
              <div className="workspace-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  aria-label={`Play playlist video: ${item.media.title}`}
                  onClick={() => setViewing(index)}
                >
                  <Play size={16} aria-hidden="true" />
                  Play
                </Button>
                <button
                  className="icon-control"
                  aria-label={`Move up: ${item.media.title}`}
                  disabled={busy || index === 0}
                  onClick={() => reorder(index, -1)}
                >
                  <ArrowUp size={18} aria-hidden="true" />
                </button>
                <button
                  className="icon-control"
                  aria-label={`Move down: ${item.media.title}`}
                  disabled={busy || index === items.length - 1}
                  onClick={() => reorder(index, 1)}
                >
                  <ArrowDown size={18} aria-hidden="true" />
                </button>
                <button
                  className="icon-control"
                  aria-label={`Remove from playlist: ${item.media.title}`}
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `/api/playlists/${selected}/items`,
                      ownerJson("PUT", {
                        mediaId: item.media.id,
                        present: false,
                      }),
                      () => {
                        setMessage("Video removed from playlist.");
                        refresh();
                      },
                    )
                  }
                >
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-history">
          {selected
            ? "Add ready videos using the Add to playlist button in your library."
            : "Create or choose a playlist. Your original videos stay in your library."}
        </p>
      )}
      {dialog && (
        <dialog
          ref={modal}
          className="collection-dialog"
          aria-labelledby="playlist-dialog-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) setDialog(null);
          }}
        >
          <h2 id="playlist-dialog-title">
            {dialog === "delete"
              ? "Delete this playlist?"
              : dialog === "create"
                ? "New playlist"
                : "Edit playlist"}
          </h2>
          <form
            className="settings-form"
            onSubmit={(event) => void submit(event)}
          >
            {dialog === "delete" ? (
              <p>
                This removes the queue only. Your original videos stay in your
                library.
              </p>
            ) : (
              <>
                <label className="library-field">
                  Playlist name
                  <input
                    name="name"
                    defaultValue={dialog === "edit" ? group?.name : ""}
                    required
                    maxLength={80}
                    disabled={busy}
                  />
                </label>
                <label className="library-field">
                  Playlist description
                  <textarea
                    name="description"
                    defaultValue={dialog === "edit" ? group?.description : ""}
                    maxLength={500}
                    rows={3}
                    disabled={busy}
                  />
                </label>
              </>
            )}
            <p role="alert">{error}</p>
            <div className="dialog-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={dialog === "delete" ? "danger" : "default"}
                disabled={busy}
              >
                {busy
                  ? "Saving…"
                  : dialog === "delete"
                    ? "Confirm playlist deletion"
                    : "Save playlist"}
              </Button>
            </div>
          </form>
        </dialog>
      )}
      {viewing !== null && items[viewing] && (
        <MediaViewer
          key={items[viewing].media.id}
          media={items[viewing].media}
          onUnauthorized={onUnauthorized}
          onClose={() => {
            setViewing(null);
            setRevision((value) => value + 1);
            onPlaybackChange();
          }}
          onPrevious={viewing > 0 ? () => setViewing(viewing - 1) : undefined}
          onNext={
            viewing < items.length - 1
              ? () => setViewing(viewing + 1)
              : undefined
          }
        />
      )}
    </section>
  );
}

export function PlaylistMembershipDialog({
  media,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  media: { id: string; title: string };
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const modal = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const [groups, setGroups] = useState<Playlist[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    alive.current = true;
    const opener = document.activeElement;
    const element = modal.current;
    element?.showModal();
    return () => {
      alive.current = false;
      operation.current?.abort();
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void ownerApi("/api/playlists?limit=100", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
      .then((value) => {
        const result = z
          .object({ playlists: z.array(playlistSchema) })
          .parse(value);
        if (!controller.signal.aborted) {
          setGroups(result.playlists);
          setLoaded(true);
          setError("");
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else setError("Playlists could not be loaded.");
      });
    return () => controller.abort();
  }, [revision, onUnauthorized]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const fields = new FormData(event.currentTarget);
    const id = String(fields.get("playlist") ?? "");
    if (!id) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    operation.current = controller;
    try {
      await ownerApi(`/api/playlists/${id}/items`, {
        ...ownerJson("PUT", { mediaId: media.id, present: true }),
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
            : "Video could not be added.",
        );
    } finally {
      submitting.current = false;
      operation.current = null;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={modal}
      className="collection-dialog"
      aria-labelledby="playlist-membership-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="playlist-membership-title">Add to playlist</h2>
      <p className="muted">{media.title}</p>
      <form className="settings-form" onSubmit={(event) => void submit(event)}>
        {!loaded ? (
          <div className="settings-skeleton" aria-label="Loading playlists" />
        ) : groups.length ? (
          <label className="library-field">
            Choose playlist
            <select
              name="playlist"
              aria-label="Choose playlist"
              required
              disabled={busy}
              defaultValue=""
            >
              <option value="" disabled>
                Choose a playlist
              </option>
              {groups.map((group) => (
                <option value={group.id} key={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>
            Create a playlist in{" "}
            <a href="#playlists" className="underline" onClick={onClose}>
              Your playlists
            </a>
            , then return to add this video.
          </p>
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
          {error && !loaded && (
            <Button
              type="button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Try again
            </Button>
          )}
          {loaded && groups.length > 0 && (
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add video to playlist"}
            </Button>
          )}
        </div>
      </form>
    </dialog>
  );
}
