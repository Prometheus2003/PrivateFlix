"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Button } from "./ui/button";
export function MediaViewer({
  media,
  onClose,
}: {
  media: { id: string; title: string; type: string };
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    const player = video.current;
    return () => {
      if (player) {
        player.pause();
        player.removeAttribute("src");
        player.load();
      }
    };
  }, []);
  return (
    <dialog
      className="media-viewer"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="viewer-title"
    >
      <div className="viewer-heading">
        <h2 id="viewer-title">{media.title}</h2>
        <Button variant="secondary" onClick={onClose}>
          Close viewer
        </Button>
      </div>
      {media.type === "VIDEO" ? (
        <video
          ref={video}
          src={`/api/media/${media.id}/stream`}
          controls
          playsInline
          preload="metadata"
          onError={() => setError(true)}
          aria-label={media.title}
        />
      ) : (
        <Image
          src={`/api/media/${media.id}/stream`}
          alt={media.title}
          width={1600}
          height={1200}
          unoptimized
          onError={() => setError(true)}
        />
      )}
      {error && (
        <p role="alert">
          This file could not be opened. Your session may have expired, or this
          browser may not support its format. Try signing in again or download
          the original.
        </p>
      )}
      <div className="viewer-actions">
        <a href={`/api/media/${media.id}/download`}>Download original</a>
        <p>Private playback · Your original stays in your library</p>
      </div>
    </dialog>
  );
}
