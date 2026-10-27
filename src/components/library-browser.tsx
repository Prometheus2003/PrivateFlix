"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { z } from "zod";
import {
  Search,
  Heart,
  LayoutGrid,
  List,
  Plus,
  FolderPlus,
  FolderOpen,
  Film,
  ImageIcon,
  Play,
  X,
  Pencil,
  Trash2,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import { Button } from "./ui/button";
import { MediaViewer } from "./media-viewer";
import { CollectionDialog } from "./collection-dialog";

const mediaSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  type: z.enum(["VIDEO", "IMAGE"]),
  fileSize: z.number(),
  processingStatus: z.string(),
  hasThumbnail: z.boolean(),
  isFavorite: z.boolean(),
  duration: z.number().nullable().optional(),
});
const collectionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  count: z.number(),
});
type Media = z.infer<typeof mediaSchema>;
type Collection = z.infer<typeof collectionSchema>;
interface Filters {
  q: string;
  type: string;
  favorite: boolean;
  collection: string;
  sort: string;
  page: number;
}
const initialFilters: Filters = {
  q: "",
  type: "all",
  favorite: false,
  collection: "",
  sort: "newest",
  page: 1,
};
class LibraryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    signal: init.signal ?? AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new LibraryError(
      error.success
        ? error.data.error
        : "Your library could not be updated. Try again.",
      response.status,
    );
  }
  return data;
}
const json = (data: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
function fileSize(bytes: number) {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return bytes < 1024 ** 3
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Toolbar composition informed by 21st.dev's Search Toolbar Page Header:
// https://21st.dev/@olewandowski1/components/page-header-5
// Native labelled filters reuse PrivateFlix's existing component/theme system.
export function LibraryBrowser({
  refreshToken,
  onUnauthorized,
  onRefresh,
}: {
  refreshToken: number;
  onUnauthorized: () => void;
  onRefresh: () => void;
}) {
  const [filters, setFilters] = useState(initialFilters);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [items, setItems] = useState<Media[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<Media | null>(null);
  const [dialog, setDialog] = useState<{
    mode: "create" | "edit" | "add" | "delete";
    media?: Media;
  } | null>(null);
  const requestVersion = useRef(0);
  const quietRefresh = useRef(false);
  const fetching = useRef(false);
  const mutationRequests = useRef(new Set<AbortController>());
  const selected = collections.find((item) => item.id === filters.collection);
  const filtered = Boolean(
    filters.q ||
      filters.type !== "all" ||
      filters.favorite ||
      filters.collection,
  );
  const change = (next: Partial<Filters>) => {
    setLoading(true);
    setFilters((previous) => ({ ...previous, ...next, page: 1 }));
  };
  const reset = () => {
    setSearch("");
    setLoading(true);
    setFilters(initialFilters);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((previous) =>
        previous.q === search.trim()
          ? previous
          : { ...previous, q: search.trim(), page: 1 },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    const version = ++requestVersion.current;
    const quiet = quietRefresh.current;
    quietRefresh.current = false;
    fetching.current = true;
    void (async () => {
      if (!quiet) setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({
          page: String(filters.page),
          limit: "20",
          sort: filters.sort,
          type: filters.type,
          favorite: String(filters.favorite),
        });
        if (filters.q) params.set("q", filters.q);
        if (filters.collection) params.set("collection", filters.collection);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20000),
        ]);
        const [media, groups] = await Promise.all([
          request(`/api/media?${params}`, { signal }),
          request("/api/collections?limit=100", { signal }),
        ]);
        const result = z
          .object({
            media: z.array(mediaSchema),
            total: z.number(),
            hasMore: z.boolean(),
          })
          .parse(media);
        const list = z
          .object({ collections: z.array(collectionSchema) })
          .parse(groups);
        if (controller.signal.aborted || version !== requestVersion.current)
          return;
        setItems(result.media);
        setTotal(result.total);
        setHasMore(result.hasMore);
        setCollections(list.collections);
        if (!result.media.length && filters.page > 1)
          setFilters((previous) => ({ ...previous, page: previous.page - 1 }));
      } catch (failure) {
        if (controller.signal.aborted || version !== requestVersion.current)
          return;
        if (failure instanceof LibraryError && failure.status === 401)
          onUnauthorized();
        else
          setError(
            failure instanceof LibraryError
              ? failure.message
              : "Your library could not be loaded. Please try again.",
          );
      } finally {
        if (!controller.signal.aborted && version === requestVersion.current) {
          fetching.current = false;
          setLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [filters, refreshToken, revision, onUnauthorized]);
  useEffect(() => {
    const requests = mutationRequests.current;
    return () => {
      for (const controller of requests) controller.abort();
    };
  }, []);
  useEffect(() => {
    if (
      loading ||
      dialog ||
      viewing ||
      error ||
      !items.some((item) =>
        ["UPLOADED", "PROCESSING"].includes(item.processingStatus),
      )
    )
      return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !fetching.current) {
        quietRefresh.current = true;
        setRevision((value) => value + 1);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [items, loading, error, dialog, viewing]);

  async function updateItem(item: Media, action: "favorite" | "remove") {
    const controller = new AbortController();
    mutationRequests.current.add(controller);
    setPending((previous) => new Set(previous).add(item.id));
    setNotice("");
    try {
      const path =
        action === "favorite"
          ? `/api/media/${item.id}/favorite`
          : `/api/collections/${filters.collection}/items`;
      await request(path, {
        ...json(
          action === "favorite"
            ? { favorite: !item.isFavorite }
            : { mediaId: item.id, present: false },
        ),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
      });
      if (controller.signal.aborted) return;
      setNotice(
        action === "remove"
          ? "Removed from this collection. Your original is safe."
          : item.isFavorite
            ? "Removed from favorites."
            : "Added to favorites.",
      );
      setRevision((value) => value + 1);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof LibraryError && failure.status === 401)
        onUnauthorized();
      else
        setNotice(
          failure instanceof LibraryError
            ? failure.message
            : "That change could not be saved. Try again.",
        );
    } finally {
      mutationRequests.current.delete(controller);
      if (!controller.signal.aborted)
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(item.id);
          return next;
        });
    }
  }

  return (
    <section
      className="collection-section library-browser"
      id="media-browser"
      aria-labelledby="media-title"
    >
      <div className="browser-heading">
        <div>
          <span className="eyebrow">CURATED BY YOU</span>
          <h2 id="media-title">Your media</h2>
          <p className="muted">Find it. Save it. Make it yours.</p>
        </div>
        <div className="browser-actions">
          <Button variant="ghost" disabled={loading} onClick={onRefresh}>
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </Button>
          <Button
            variant="secondary"
            onClick={() => setDialog({ mode: "create" })}
          >
            <Plus size={17} aria-hidden="true" />
            New collection
          </Button>
        </div>
      </div>
      <div className="browse-toolbar">
        <label className="library-search">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search your library</span>
          <input
            type="search"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search your library…"
          />
          {search && (
            <button
              type="button"
              className="icon-control"
              aria-label="Clear search"
              onClick={() => {
                setSearch("");
                change({ q: "" });
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </label>
        <label className="library-field">
          <span>Media type</span>
          <select
            aria-label="Media type"
            value={filters.type}
            onChange={(event) => change({ type: event.target.value })}
          >
            <option value="all">All types</option>
            <option value="VIDEO">Videos</option>
            <option value="IMAGE">Photos</option>
          </select>
        </label>
        <label className="library-field">
          <span>Sort media</span>
          <select
            aria-label="Sort media"
            value={filters.sort}
            onChange={(event) => change({ sort: event.target.value })}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A–Z</option>
          </select>
        </label>
        <div className="view-switch" role="group" aria-label="Display layout">
          <button
            className="icon-control"
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            <LayoutGrid size={18} aria-hidden="true" />
          </button>
          <button
            className="icon-control"
            aria-label="List view"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <List size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="library-filter-row">
        <div
          className="library-tabs"
          role="group"
          aria-label="Library selection"
        >
          <button
            aria-pressed={!filters.favorite}
            onClick={() => change({ favorite: false })}
          >
            All media
          </button>
          <button
            aria-pressed={filters.favorite}
            onClick={() => change({ favorite: true })}
          >
            <Heart size={15} aria-hidden="true" />
            Favorites
          </button>
        </div>
        <label className="library-field collection-select">
          <span className="sr-only">Collection</span>
          <FolderOpen size={17} aria-hidden="true" />
          <select
            aria-label="Collection"
            value={filters.collection}
            onChange={(event) => change({ collection: event.target.value })}
          >
            <option value="">All collections</option>
            {collections.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name} ({group.count})
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <Button variant="ghost" onClick={reset}>
            Clear filters
            <X size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
      {selected && (
        <div className="selected-collection">
          <div>
            <h3>{selected.name}</h3>
            {selected.description && (
              <p className="muted">{selected.description}</p>
            )}
          </div>
          <div className="browser-actions">
            <Button variant="ghost" onClick={() => setDialog({ mode: "edit" })}>
              <Pencil size={15} aria-hidden="true" />
              Rename collection
            </Button>
            <Button
              variant="ghost"
              onClick={() => setDialog({ mode: "delete" })}
            >
              <Trash2 size={15} aria-hidden="true" />
              Delete collection
            </Button>
          </div>
        </div>
      )}
      <p
        className="library-result-count"
        role="status"
        aria-label="Library results"
      >
        {loading
          ? "Loading your collection…"
          : `${total} ${total === 1 ? "item" : "items"}${filtered ? " found" : " in your library"}`}
      </p>
      <p role="status" aria-label="Library updates" className="library-notice">
        {notice}
      </p>
      {error ? (
        <div className="library-error" role="alert">
          <p>{error}</p>
          <Button
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            Try again
          </Button>
        </div>
      ) : (
        <div aria-busy={loading}>
          {loading ? (
            <div className="media-grid library-skeleton" aria-hidden="true">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="skeleton-card" />
              ))}
            </div>
          ) : items.length ? (
            <div className={view === "list" ? "media-list" : "media-grid"}>
              {items.map((item) => (
                <article
                  className="media-card interactive-media"
                  key={item.id}
                  aria-label={item.title}
                >
                  <div className="card-visual">
                    <button
                      className={`thumbnail-open media-placeholder ${item.type === "VIDEO" ? "video-placeholder" : "photo-placeholder"}`}
                      aria-label={`Open ${item.title}`}
                      disabled={item.processingStatus !== "READY"}
                      onClick={() => setViewing(item)}
                    >
                      {item.hasThumbnail ? (
                        <Image
                          src={`/api/media/${item.id}/thumbnail`}
                          alt=""
                          width={640}
                          height={360}
                          unoptimized
                        />
                      ) : item.type === "VIDEO" ? (
                        <Film size={36} strokeWidth={1.2} aria-hidden="true" />
                      ) : (
                        <ImageIcon
                          size={36}
                          strokeWidth={1.2}
                          aria-hidden="true"
                        />
                      )}
                      <span>{item.type === "VIDEO" ? "VIDEO" : "PHOTO"}</span>
                      {item.processingStatus === "READY" && (
                        <i className="open-indicator" aria-hidden="true">
                          {item.type === "VIDEO" ? (
                            <Play size={20} />
                          ) : (
                            <ImageIcon size={20} />
                          )}
                        </i>
                      )}
                    </button>
                    <button
                      className="favorite-control icon-control"
                      aria-label={`${item.isFavorite ? "Remove from" : "Add to"} favorites: ${item.title}`}
                      aria-pressed={item.isFavorite}
                      disabled={pending.has(item.id)}
                      onClick={() => void updateItem(item, "favorite")}
                    >
                      <Heart
                        size={18}
                        fill={item.isFavorite ? "currentColor" : "none"}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                  <div className="media-details">
                    <h3 title={item.title}>{item.title}</h3>
                    <p>
                      {fileSize(item.fileSize)}
                      <span className="status-dot" />
                      {item.processingStatus === "UPLOADED"
                        ? "Awaiting processing"
                        : item.processingStatus.toLowerCase()}
                    </p>
                    <div className="media-card-actions">
                      {item.processingStatus === "READY" && (
                        <Button
                          variant="secondary"
                          onClick={() => setViewing(item)}
                        >
                          {item.type === "VIDEO" ? "Play video" : "View photo"}
                        </Button>
                      )}
                      <button
                        className="icon-control"
                        aria-label={`Add to collection: ${item.title}`}
                        onClick={() => setDialog({ mode: "add", media: item })}
                      >
                        <FolderPlus size={19} aria-hidden="true" />
                      </button>
                      {selected && (
                        <button
                          className="icon-control"
                          aria-label={`Remove from collection: ${item.title}`}
                          disabled={pending.has(item.id)}
                          onClick={() => void updateItem(item, "remove")}
                        >
                          <X size={18} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-library">
              <FolderOpen size={36} strokeWidth={1.3} aria-hidden="true" />
              <h3>{filtered ? "No matches yet" : "Your story starts here"}</h3>
              <p className="muted">
                {filtered
                  ? "Try another search or clear your filters to explore your collection."
                  : "Upload a photo or video, then organize the things you love."}
              </p>
              {filtered ? (
                <Button variant="secondary" onClick={reset}>
                  Clear filters
                </Button>
              ) : (
                <a href="#upload">
                  Add your first memory
                  <ArrowUpRight size={15} aria-hidden="true" />
                </a>
              )}
            </div>
          )}
        </div>
      )}
      <div className="pagination">
        <Button
          variant="ghost"
          disabled={loading || filters.page === 1}
          onClick={() => {
            setLoading(true);
            setFilters((previous) => ({
              ...previous,
              page: previous.page - 1,
            }));
          }}
        >
          Previous
        </Button>
        <span>Page {filters.page}</span>
        <Button
          variant="ghost"
          disabled={loading || !hasMore}
          onClick={() => {
            setLoading(true);
            setFilters((previous) => ({
              ...previous,
              page: previous.page + 1,
            }));
          }}
        >
          Next
        </Button>
      </div>
      {dialog && (
        <CollectionDialog
          key={`${dialog.mode}-${selected?.id ?? ""}-${dialog.media?.id ?? ""}`}
          mode={dialog.mode}
          media={dialog.media}
          collection={selected}
          collections={collections}
          onUnauthorized={onUnauthorized}
          onClose={() => setDialog(null)}
          onSaved={(message, collectionId) => {
            setNotice(message);
            setDialog(null);
            if (dialog.mode === "delete") change({ collection: "" });
            else if (dialog.mode === "create" && collectionId)
              change({ collection: collectionId });
            setRevision((value) => value + 1);
          }}
        />
      )}
      {viewing && (
        <MediaViewer
          key={viewing.id}
          media={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  );
}
