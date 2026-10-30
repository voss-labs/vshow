// Technical details of a media version, recorded when it was uploaded: what the file is (dimensions, aspect ratio,
// duration, codec) and what the structural checks found. Meant for the reviewer (and the server room) to judge a file
// before it goes on a screen. These checks describe the file; they are not a virus scan.
import type { MediaAnalysis, MediaCheck } from "../media/analysis.ts";
import { Notice } from "./ui.tsx";
import { formatBytes } from "./workflow-ui.tsx";

const duration = (seconds: number) => {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="eyebrow mb-1">{label}</dt>
      <dd className="m-0 tabular font-medium">{children}</dd>
    </div>
  );
}

const MARK: Record<MediaCheck["level"], string> = { pass: "✓", info: "i", warn: "!", fail: "✕" };
const TONE: Record<MediaCheck["level"], string> = { pass: "ok", info: "info", warn: "warn", fail: "danger" };

export function MediaDetails({ info, sizeBytes }: { info: MediaAnalysis | null; sizeBytes: number }) {
  if (!info) {
    return (
      <Notice tone="neutral" title="No technical details">
        This version was recorded before file details were captured, so its size, aspect ratio and checks are not
        available.
      </Notice>
    );
  }
  const warnings = info.checks.filter((c) => c.level === "warn");
  const notes = info.checks.filter((c) => c.level === "info");
  const passed = info.checks.filter((c) => c.level === "pass");
  const ratio = info.aspect.label ?? `${info.aspect.w}:${info.aspect.h}`;

  return (
    <section aria-label="Technical details" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="eyebrow m-0">Technical details</h4>
        <span className="badge" data-tone={warnings.length > 0 ? "warn" : "ok"}>
          {warnings.length > 0
            ? `${warnings.length} ${warnings.length === 1 ? "thing" : "things"} to review`
            : "All checks passed"}
        </span>
      </div>

      <dl className="m-0 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Format">
          {info.format} {info.kind}
        </Fact>
        <Fact label="Dimensions">
          {info.width.toLocaleString("en-IN")} × {info.height.toLocaleString("en-IN")} px
        </Fact>
        <Fact label="Aspect ratio">
          {ratio} · {info.aspect.orientation}
        </Fact>
        <Fact label="Size in pixels">{info.megapixels} MP</Fact>
        <Fact label="File size">{formatBytes(sizeBytes)}</Fact>
        {info.kind === "image" && info.colorMode && <Fact label="Colour">{info.colorMode}</Fact>}
        {info.kind === "image" && <Fact label="Transparency">{info.hasAlpha ? "Has transparency" : "Opaque"}</Fact>}
        {info.kind === "image" && info.animated && <Fact label="Animation">Animated</Fact>}
        {info.video && (
          <>
            <Fact label="Duration">
              {info.video.durationSeconds === null ? "Unknown" : duration(info.video.durationSeconds)}
            </Fact>
            <Fact label="Frame rate">{info.video.fps === null ? "Unknown" : `${info.video.fps} fps`}</Fact>
            <Fact label="Video codec">{info.video.videoCodec ?? "Unknown"}</Fact>
            <Fact label="Audio">{info.video.hasAudio ? (info.video.audioCodec ?? "Yes") : "None"}</Fact>
          </>
        )}
      </dl>

      <ul className="m-0 list-none border-t border-line p-0" aria-label="Checks">
        {[...warnings, ...notes, ...passed].map((c, i) => (
          <li key={`${c.code}-${i}`} className="flex items-baseline gap-3 border-b border-line py-3">
            <span className="badge shrink-0" data-tone={TONE[c.level]} aria-hidden="true">
              {MARK[c.level]}
            </span>
            <span>
              <span className="sr-only">
                {c.level === "pass" ? "Passed: " : c.level === "warn" ? "Warning: " : "Note: "}
              </span>
              {c.message}
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">
        These checks describe the file's structure. They are not a virus scan; a warning means a person should look.
      </p>
    </section>
  );
}
