"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Film, ImageIcon, Heart, Library } from "lucide-react";
import { ownerApi, OwnerApiError } from "@/client/api";
import { Button } from "./ui/button";
const schema = z.object({
  totalMedia: z.number(),
  videos: z.number(),
  photos: z.number(),
  favorites: z.number(),
  collections: z.number(),
  playlists: z.number(),
  originalBytes: z.number(),
  activity: z.array(
    z.object({ id: z.string(), label: z.string(), createdAt: z.string() }),
  ),
});
export function LibrarySummary({
  refreshToken,
  onUnauthorized,
}: {
  refreshToken: number;
  onUnauthorized: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const key = `${refreshToken}-${revision}`;
  const [view, setView] = useState<{
    key: string;
    error: string;
    data: z.infer<typeof schema> | null;
  }>({ key: "", error: "", data: null });
  const loading = view.key !== key;
  useEffect(() => {
    const controller = new AbortController();
    void ownerApi("/api/library/summary", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
      .then((value) => {
        const data = schema.parse(value);
        if (!controller.signal.aborted) setView({ key, error: "", data });
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else
          setView({
            key,
            error: "Your library overview could not be loaded.",
            data: null,
          });
      });
    return () => controller.abort();
  }, [key, onUnauthorized]);
  const data = view.data;
  return (
    <section
      className="library-overview"
      aria-label="Library overview"
      aria-busy={loading}
    >
      <div className="overview-heading">
        <h2>Your collection at a glance</h2>
        <Button
          variant="ghost"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh overview
        </Button>
      </div>
      {loading ? (
        <div className="overview-grid" aria-label="Loading library overview">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="overview-skeleton" />
          ))}
        </div>
      ) : view.error ? (
        <p role="alert">{view.error}</p>
      ) : (
        data && (
          <>
            <dl className="overview-grid">
              {[
                { label: "Total items", value: data.totalMedia, icon: Library },
                { label: "Videos", value: data.videos, icon: Film },
                { label: "Photos", value: data.photos, icon: ImageIcon },
                { label: "Favorites", value: data.favorites, icon: Heart },
              ].map((item) => (
                <div key={item.label}>
                  <dt>
                    <item.icon size={17} aria-hidden="true" />
                    {item.label}
                  </dt>
                  <dd>{item.value.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
            <p className="muted">
              {(data.originalBytes / 1024 ** 3).toFixed(2)} GiB of original
              media ·{" "}
              <a href="#media-browser">{data.collections} collections</a> ·{" "}
              <a href="#playlists">{data.playlists} playlists</a>
            </p>
            <details className="overview-activity">
              <summary>Recent library activity</summary>
              {data.activity.length ? (
                <ol>
                  {data.activity.map((event) => (
                    <li key={event.id}>
                      <span>{event.label}</span>
                      <time dateTime={event.createdAt}>
                        {new Date(event.createdAt).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">
                  Your private uploads and account activity will appear here.
                </p>
              )}
            </details>
          </>
        )
      )}
    </section>
  );
}
