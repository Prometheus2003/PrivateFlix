"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Image from "next/image";
import { Button } from "./ui/button";
export function PhotoViewer({
  media,
  onPrevious,
  onNext,
  onClose,
  busy,
}: {
  media: { id: string; title: string };
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [bounds, setBounds] = useState({ width: 320, height: 240 });
  const [natural, setNatural] = useState({ width: 1600, height: 1200 });
  const [fullscreen, setFullscreen] = useState(false);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box)
        setBounds((previous) =>
          previous.width === box.width && previous.height === box.height
            ? previous
            : { width: box.width, height: box.height },
        );
    });
    observer.observe(element);
    const focus = requestAnimationFrame(() =>
      element.focus({ preventScroll: true }),
    );
    const changed = () =>
      setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", changed);
    return () => {
      cancelAnimationFrame(focus);
      observer.disconnect();
      document.removeEventListener("fullscreenchange", changed);
    };
  }, []);
  useEffect(() => {
    const element = stage.current;
    if (element)
      element.scrollTo({
        left: Math.max(0, (element.scrollWidth - element.clientWidth) / 2),
        top: Math.max(0, (element.scrollHeight - element.clientHeight) / 2),
      });
  }, [zoom]);
  const fit = Math.min(
    bounds.width / natural.width,
    bounds.height / natural.height,
  );
  const width = Math.max(1, Math.floor(natural.width * fit * zoom)),
    height = Math.max(1, Math.floor(natural.height * fit * zoom));
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === root.current)
        await document.exitFullscreen();
      else await root.current?.requestFullscreen();
      setMessage("");
    } catch {
      setMessage("Full-screen mode is unavailable in this browser.");
    }
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (
      event.target instanceof HTMLElement &&
      ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)
    )
      return;
    if (["+", "="].includes(event.key)) {
      event.preventDefault();
      setZoom((value) => Math.min(4, value + 0.25));
    } else if (event.key === "-") {
      event.preventDefault();
      setZoom((value) => Math.max(1, value - 0.25));
    } else if (event.key === "0") {
      event.preventDefault();
      setZoom(1);
    } else if (event.key === "ArrowRight" && zoom === 1 && onNext && !busy) {
      event.preventDefault();
      onNext();
    } else if (event.key === "ArrowLeft" && zoom === 1 && onPrevious && !busy) {
      event.preventDefault();
      onPrevious();
    }
  }
  return (
    <div ref={root} className="photo-viewer-content" onKeyDown={keys}>
      {fullscreen && <h3>{media.title}</h3>}
      <div
        ref={stage}
        className="photo-stage"
        role="region"
        tabIndex={0}
        aria-label="Photo preview. Arrow keys pan when zoomed."
      >
        {!loaded && (
          <div className="photo-loading" role="status">
            Loading photo…
          </div>
        )}
        <div
          className="photo-surface"
          style={{
            width: Math.max(width, bounds.width),
            height: Math.max(height, bounds.height),
          }}
        >
          <Image
            src={`/api/media/${media.id}/stream`}
            alt={media.title}
            width={1600}
            height={1200}
            unoptimized
            loading="eager"
            style={{ width, height, maxWidth: "none", maxHeight: "none" }}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth && image.naturalHeight)
                setNatural({
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                });
              setLoaded(true);
            }}
            onError={() => {
              setLoaded(true);
              setMessage(
                "This photo could not be opened. Check your session or download the original.",
              );
            }}
          />
        </div>
      </div>
      <div className="photo-toolbar">
        <div className="workspace-actions">
          <Button
            variant="secondary"
            disabled={busy || !onPrevious}
            onClick={onPrevious}
          >
            Previous photo
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !onNext}
            onClick={onNext}
          >
            Next photo
          </Button>
        </div>
        <div className="workspace-actions">
          <Button
            variant="secondary"
            disabled={zoom <= 1}
            onClick={() => setZoom((value) => Math.max(1, value - 0.25))}
          >
            Zoom out
          </Button>
          <span role="status" aria-label="Photo zoom">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="secondary"
            disabled={zoom >= 4}
            onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
          >
            Zoom in
          </Button>
          <Button variant="ghost" onClick={() => setZoom(1)}>
            Fit photo
          </Button>
          <Button variant="secondary" onClick={() => void toggleFullscreen()}>
            {fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          </Button>
          {fullscreen && (
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Close photo
            </Button>
          )}
        </div>
      </div>
      <p className="muted photo-shortcuts">
        Arrow keys switch photos when fitted. Use + / − to zoom and 0 to fit;
        focus the preview to pan when zoomed.
      </p>
      <p role="status">{message}</p>
    </div>
  );
}
