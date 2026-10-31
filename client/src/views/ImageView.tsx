import { useEffect, useState } from "react";
import { secondsFrom } from "../data/data";
import { useTimeFormatter } from "../timeDisplay";
import type { Info } from "../types";
import { useViewFrame } from "../data/useViewData";
import type { ImageValue } from "../data/viewFrames";
import type { Widget } from "../workspace/widgets";

const mimeTypes: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};

/** The selected image topic as it was at the playback position. */
export function ImageView({ widget, info }: { widget: Widget; info: Info | null }) {
  const series = widget.series[0];
  const { frame, error } = useViewFrame(series, info);
  const formatter = useTimeFormatter(info?.start_ns ?? null, widget.timeDisplay);
  const [url, setUrl] = useState<string>();
  const value = frame?.value?.kind === "image" ? (frame.value as ImageValue) : undefined;
  const mime = value && mimeTypes[value.format];
  useEffect(() => {
    if (!frame || !value || !mime) return setUrl(undefined);
    const next = URL.createObjectURL(new Blob([frame.blob(value.data).slice()], { type: mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [frame, value, mime]);
  if (!series) return null;
  const problem =
    error || frame?.error || (value && !mime ? `Unsupported image format: ${value.format}` : "");
  return (
    <div className="view-image">
      {url && !problem && <img src={url} alt={series.topic} />}
      {problem ? (
        <p className="view-status view-error">{problem}</p>
      ) : frame === undefined ? (
        <p className="view-status">Loading…</p>
      ) : frame === null ? (
        <p className="view-status">No messages</p>
      ) : (
        <p className="view-time">{formatter.tooltip(secondsFrom(frame.time_ns, info!.start_ns))}</p>
      )}
    </div>
  );
}
