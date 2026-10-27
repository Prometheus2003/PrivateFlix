"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PhotoViewer } from "./photo-viewer";
import { MediaOwnerControls } from "./media-owner-controls";
import { z } from "zod";
import { ownerApi, ownerJson, OwnerApiError } from "@/client/api";
import { Button } from "./ui/button";
import { usePreferences } from "./preferences-provider";
const progressSchema = z.object({
  progress: z
    .object({ positionSeconds: z.number(), completed: z.boolean() })
    .nullable(),
});
type Progress = { positionSeconds: number; completed?: boolean };
export function MediaViewer({
  media,
  onClose,
  onUnauthorized,
  onPrevious,
  onNext,
}: {
  media: { id: string; title: string; type: string };
  onClose: () => void;
  onUnauthorized?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const { preferences } = usePreferences();
  const [error, setError] = useState(false);
  const [progressError, setProgressError] = useState("");
  const [resume, setResume] = useState<number | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(media.type !== "VIDEO");
  const [watched, setWatched] = useState(false);
  const [closing, setClosing] = useState(false);
  const [ready, setReady] = useState(false);
  const [speed, setSpeed] = useState(preferences.playbackSpeed);
  const alive = useRef(false);
  const played = useRef(false);
  const lastSave = useRef(0);
  const pending = useRef<Progress | null>(null);
  const saving = useRef<Promise<boolean> | null>(null);
  const choice = useRef(false);
  const closingRef = useRef(false);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedSave = useRef<Progress | null>(null);
  const save = useCallback(
    async (progress: Progress): Promise<boolean> => {
      pending.current = progress;
      if (saving.current) return saving.current;
      saving.current = (async () => {
        let success = true;
        while (pending.current && alive.current) {
          const next = pending.current;
          pending.current = null;
          lastSave.current = Date.now();
          try {
            await ownerApi(`/api/playback/${media.id}`, {
              ...ownerJson("PUT", next),
              keepalive: true,
              signal: AbortSignal.timeout(10000),
            });
            failedSave.current = null;
            success = true;
            if (alive.current) setProgressError("");
          } catch (failure) {
            success = false;
            failedSave.current = next;
            if (alive.current) {
              if (failure instanceof OwnerApiError && failure.status === 401)
                onUnauthorized?.();
              setProgressError(
                "Your playback position could not be saved. Check your connection and try again.",
              );
            }
          }
        }
        return success;
      })();
      try {
        return await saving.current;
      } finally {
        saving.current = null;
      }
    },
    [media.id, onUnauthorized],
  );
  const snapshot = useCallback(
    (completed?: boolean) => {
      const player = video.current;
      if (!player || !played.current || !Number.isFinite(player.currentTime))
        return Promise.resolve(true);
      return save({
        positionSeconds: player.currentTime,
        ...(completed === undefined ? {} : { completed }),
      });
    },
    [save],
  );
  useEffect(() => {
    const leaving = () => {
      void snapshot();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") leaving();
    };
    window.addEventListener("pagehide", leaving);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", leaving);
      document.removeEventListener("visibilitychange", hidden);
      if (seekTimer.current) clearTimeout(seekTimer.current);
    };
  }, [snapshot]);
  async function close(afterSave = onClose) {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    video.current?.pause();
    const success = await snapshot();
    if (success) afterSave();
    else {
      closingRef.current = false;
      setClosing(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    const opener = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    const player = video.current;
    // Strict Mode replays setup after cleanup in development. Restore the
    // source removed by cleanup so the second setup can load the video.
    const source = `/api/media/${media.id}/stream`;
    if (player && player.getAttribute("src") !== source) player.src = source;
    return () => {
      alive.current = false;
      pending.current = null;
      if (player) {
        player.pause();
        player.removeAttribute("src");
        player.load();
      }
      modal?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [media.id]);
  useEffect(() => {
    if (media.type !== "VIDEO") return;
    const controller = new AbortController();
    void ownerApi(`/api/playback/${media.id}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
      .then((value) => {
        const data = progressSchema.parse(value);
        if (controller.signal.aborted) return;
        setWatched(data.progress?.completed ?? false);
        setResume(
          data.progress &&
            !data.progress.completed &&
            data.progress.positionSeconds >= 1
            ? data.progress.positionSeconds
            : null,
        );
        setHistoryLoaded(true);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized?.();
        setProgressError(
          "Your saved position could not be loaded. Playing from the beginning will replace it.",
        );
        setHistoryLoaded(true);
      });
    return () => controller.abort();
  }, [media.id, media.type, onUnauthorized]);
  useEffect(() => {
    if (
      historyLoaded &&
      resume === null &&
      preferences.autoplay &&
      !choice.current &&
      !progressError
    )
      void video.current?.play().catch(() => {});
  }, [historyLoaded, resume, preferences.autoplay, progressError]);
  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed]);
  function start(position: number) {
    const player = video.current;
    if (!player || !Number.isFinite(player.duration)) return;
    choice.current = true;
    setResume(null);
    setWatched(false);
    player.currentTime = Math.min(position, Math.max(0, player.duration - 0.1));
    void player.play().catch(() => {});
  }
  return (
    <dialog
      className="media-viewer"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        void close();
      }}
      aria-labelledby="viewer-title"
    >
      <div className="viewer-heading">
        <h2 id="viewer-title">{media.title}</h2>
        <Button
          variant="secondary"
          disabled={closing}
          onClick={() => void close()}
        >
          {closing ? "Saving…" : "Close viewer"}
        </Button>
      </div>
      {media.type === "VIDEO" ? (
        <>
          {!historyLoaded && <p role="status">Loading your saved position…</p>}
          {resume !== null && (
            <div className="resume-prompt">
              <p>
                Continue from {Math.floor(resume / 60)}:
                {String(Math.floor(resume % 60)).padStart(2, "0")}?
              </p>
              <div className="workspace-actions">
                <Button disabled={!ready} onClick={() => start(resume)}>
                  Resume playback
                </Button>
                <Button
                  variant="secondary"
                  disabled={!ready}
                  onClick={() => start(0)}
                >
                  Start from beginning
                </Button>
              </div>
            </div>
          )}
          <video
            ref={video}
            src={`/api/media/${media.id}/stream`}
            controls
            playsInline
            preload="metadata"
            onError={() => setError(true)}
            aria-label={media.title}
            onLoadedMetadata={() => {
              setReady(true);
              if (video.current) video.current.playbackRate = speed;
            }}
            onPlay={() => {
              if (historyLoaded && (resume === null || choice.current)) {
                played.current = true;
                setWatched(false);
              } else video.current?.pause();
            }}
            onTimeUpdate={() => {
              if (
                played.current &&
                !closingRef.current &&
                Date.now() - lastSave.current >= 10000
              )
                void snapshot();
            }}
            onPause={() => {
              if (alive.current && !closingRef.current) void snapshot();
            }}
            onSeeked={() => {
              if (seekTimer.current) clearTimeout(seekTimer.current);
              if (played.current && !closingRef.current)
                seekTimer.current = setTimeout(() => {
                  void snapshot();
                }, 400);
            }}
            onEnded={() => {
              setWatched(true);
              void snapshot(true).then((success) => {
                if (
                  success &&
                  alive.current &&
                  !closingRef.current &&
                  preferences.autoplay &&
                  onNext
                )
                  onNext();
              });
            }}
          />
          <div className="viewer-controls">
            <div className="workspace-actions">
              {onPrevious && (
                <Button
                  variant="secondary"
                  disabled={closing}
                  onClick={() => void close(onPrevious)}
                >
                  Previous video
                </Button>
              )}
              {onNext && (
                <Button
                  variant="secondary"
                  disabled={closing}
                  onClick={() => void close(onNext)}
                >
                  Next video
                </Button>
              )}
            </div>
            <label className="library-field">
              Playback speed
              <select
                aria-label="Playback speed"
                value={speed}
                onChange={(event) =>
                  setSpeed(Number(event.target.value) as typeof speed)
                }
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                  <option value={rate} key={rate}>
                    {rate}×
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="secondary"
              disabled={!historyLoaded || closing}
              onClick={async () => {
                video.current?.pause();
                played.current = false;
                const value = !watched;
                if (await save({ positionSeconds: 0, completed: value }))
                  setWatched(value);
              }}
            >
              {watched ? "Mark unwatched" : "Mark watched"}
            </Button>
          </div>
        </>
      ) : (
        <PhotoViewer
          media={media}
          busy={closing}
          onPrevious={onPrevious ? () => void close(onPrevious) : undefined}
          onNext={onNext ? () => void close(onNext) : undefined}
          onClose={() => void close()}
        />
      )}
      {error && (
        <p role="alert">
          This file could not be opened. Your session may have expired, or this
          browser may not support its format. Try signing in again or download
          the original.
        </p>
      )}
      {progressError && (
        <div role="alert">
          <p>{progressError}</p>
          <div className="workspace-actions">
            <Button
              variant="secondary"
              onClick={() => {
                if (failedSave.current) void save(failedSave.current);
                else void snapshot();
              }}
            >
              Retry saving position
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close without saving
            </Button>
          </div>
        </div>
      )}
      <div className="viewer-actions">
        <a href={`/api/media/${media.id}/download`}>Download original</a>
        <p>Private playback · Your original stays in your library</p>
      </div>
      <MediaOwnerControls
        media={media}
        onUnauthorized={onUnauthorized}
        onDeleting={() => video.current?.pause()}
        onDeleted={() => {
          played.current = false;
          pending.current = null;
          onClose();
        }}
      />
    </dialog>
  );
}
