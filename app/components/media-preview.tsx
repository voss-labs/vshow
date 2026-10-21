// In-page preview of a media version (JPEG, PNG, WebP or MP4), so people can look at the file without downloading it.
//
// The page never contains a signed storage URL. The <img>/<video> points at our own preview route, which checks who is
// asking on every request and redirects to a short-lived signed URL. That also means the browser fetches the bytes
// straight from object storage (no large response through Vshow) and a video can seek with range requests.
import { useEffect, useRef, useState } from "react";
import { formatBytes } from "./workflow-ui.tsx";
import { Notice, Spinner } from "./ui.tsx";

export interface PreviewVersion {
  id: string;
  versionNumber: number;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
}

type Phase = "loading" | "ready" | "error";

export function MediaPreview({ submissionId, version }: { submissionId: string; version: PreviewVersion }) {
  const base = `/submissions/${submissionId}/versions/${version.id}`;
  const kind = version.contentType.startsWith("image/")
    ? "image"
    : version.contentType.startsWith("video/")
      ? "video"
      : null;
  const [phase, setPhase] = useState<Phase>("loading");
  // Bumped by "Try again" so the browser requests a fresh signed URL.
  const [attempt, setAttempt] = useState(0);
  const src = `${base}/preview?r=${attempt}`;
  const image = useRef<HTMLImageElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  // The server-rendered <img>/<video> may finish (or fail) loading before React attaches its handlers, so look at the
  // element's current state once the page is interactive.
  useEffect(() => {
    const img = image.current;
    if (img?.complete) setPhase(img.naturalWidth > 0 ? "ready" : "error");
    const vid = video.current;
    if (vid) {
      if (vid.error) setPhase("error");
      else if (vid.readyState >= 1) setPhase("ready");
    }
  }, [attempt]);

  if (!kind) {
    return (
      <Notice tone="neutral" title="No preview for this file type">
        <a className="link" href={`${base}/file`}>
          Download it
        </a>{" "}
        to view it.
      </Notice>
    );
  }

  return (
    <figure className="m-0">
      <div className="media-frame" data-kind={kind} data-phase={phase}>
        {phase === "loading" && (
          <div className="media-state" role="status">
            <Spinner />
            <span>Loading preview…</span>
          </div>
        )}
        {phase === "error" ? (
          <div className="media-state media-state-error" role="alert">
            <p className="font-medium">Preview unavailable</p>
            <p className="text-dim">
              The file could not be loaded. Storage may be offline, or this browser cannot show this file.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setPhase("loading");
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
              <a className="btn btn-ghost" href={`${base}/file`}>
                Download instead
              </a>
            </div>
          </div>
        ) : kind === "image" ? (
          <img
            key={attempt}
            ref={image}
            src={src}
            alt={`Preview of ${version.originalFilename}`}
            decoding="async"
            onLoad={() => setPhase("ready")}
            onError={() => setPhase("error")}
          />
        ) : (
          <video
            key={attempt}
            ref={video}
            src={src}
            controls
            playsInline
            preload="metadata"
            aria-label={`Preview of ${version.originalFilename}`}
            onLoadedMetadata={() => setPhase("ready")}
            onError={() => setPhase("error")}
          />
        )}
      </div>
      <figcaption className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <span className="min-w-0 text-sm text-dim">
          <span className="break-all font-medium text-ink">{version.originalFilename}</span>
          <span className="tabular">
            {" "}
            · v{version.versionNumber} · {version.contentType} · {formatBytes(version.sizeBytes)}
          </span>
        </span>
        <span className="flex gap-5 text-sm">
          <a className="link" href={`${base}/preview`} target="_blank" rel="noopener noreferrer">
            Open full size<span className="sr-only"> in a new tab</span> ↗
          </a>
          <a className="link" href={`${base}/file`}>
            Download
          </a>
        </span>
      </figcaption>
    </figure>
  );
}
