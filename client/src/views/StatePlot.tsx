import "./StatePlot.css";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { axisRange, clampAxis, zoomAxis, type AxisRange } from "./axes";
import { wheelZoomFactor, type PlotView, type Series } from "./Plot";
import { timeTicks } from "./ticks";
import { stateLabel } from "../data/data";
import { SeriesName } from "../SeriesName";
import { useTimeFormatter } from "../timeDisplay";
import { usePlayback, usePlaybackStore } from "../workspace/playback";
import type { Widget } from "../workspace/widgets";

const stateColors = [
  "#168aad",
  "#f77f00",
  "#7b2cbf",
  "#2a9d8f",
  "#e63946",
  "#4361ee",
  "#bc6c25",
  "#d45087",
];
function stateColor(value: string) {
  // A neutral color keeps empty strings apart from real states.
  if (value === "") return "#3a3f46";
  if (value === "true") return "#00a896";
  if (value === "false") return "#657b91";
  const hash = [...value].reduce((result, char) => (result * 31 + char.charCodeAt(0)) | 0, 0);
  return stateColors[Math.abs(hash) % stateColors.length];
}
function stateSegments(series: Series, fullEnd: number) {
  const segments: { start: number; end: number; value: string; color: string; ns: string }[] = [];
  let current: (typeof segments)[number] | null = null;
  for (const point of series.points) {
    if (point.raw === null) {
      if (current) segments.push({ ...current, end: point.x });
      current = null;
      continue;
    }
    const value = stateLabel(point.raw, series.enumValues);
    if (current !== null && current.value === value) continue;
    if (current) segments.push({ ...current, end: point.x });
    current = { start: point.x, end: fullEnd, value, color: stateColor(value), ns: point.ns };
  }
  if (current) segments.push(current);
  return segments;
}
function StatePlayhead({ domain }: { domain: AxisRange }) {
  const time = usePlayback((s) => s.time);
  const ratio = (time - domain[0]) / (domain[1] - domain[0]);
  if (ratio < 0 || ratio > 1) return null;
  return <div className="playhead" style={{ left: `${ratio * 100}%`, top: 0, bottom: 0 }} />;
}

/** The time axis under the rows, with the same ticks as a Plot widget. */
export function StateAxis({
  formatter,
  domain,
}: {
  formatter: ReturnType<typeof useTimeFormatter>;
  domain: AxisRange;
}) {
  const axis = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = axis.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const { values, step } = timeTicks(domain[0], domain[1], {
    width,
    minSpacing: formatter.minTickSpacing,
    offset: formatter.tickOffset,
    clock: formatter.clock,
  });
  let shownDate = "";
  return (
    <div className="state-axis" ref={axis}>
      {values.map((value) => {
        const text = formatter.axisTime(value, step);
        const { date } = formatter.tick(value);
        const showDate = date && date !== shownDate;
        if (showDate) shownDate = date;
        // Keep edge labels inside the axis; 3.2px is about half a character here.
        const half = Math.max(text.length, showDate ? date.length : 0) * 3.2;
        const center = ((value - domain[0]) / (domain[1] - domain[0])) * width;
        return (
          <span key={value} style={{ left: Math.max(half, Math.min(width - half, center)) }}>
            {text}
            {showDate && <small>{date}</small>}
          </span>
        );
      })}
    </div>
  );
}

export function StatePlot({
  widget,
  series,
  fullEnd,
  originNs,
  onViewChange,
}: {
  widget: Widget;
  series: Series[];
  fullEnd: number;
  originNs: string | null;
  onViewChange: (update: (view: PlotView) => PlotView) => void;
}) {
  const formatter = useTimeFormatter(originNs);
  const playback = usePlaybackStore();
  const domain = axisRange([0, fullEnd], widget.view.x);
  const plot = useRef<HTMLDivElement>(null);
  // Latest values for the listener below, which is attached only once.
  const zoom = useRef({ view: widget.view.x, onViewChange });
  zoom.current = { view: widget.view.x, onViewChange };
  useEffect(() => {
    const node = plot.current!;
    // Non-passive to stop the scroll, which React's onWheel cannot do.
    const onWheel = (event: WheelEvent) => {
      // All rows share one time axis, so any track maps the pointer to a time.
      const track = node.querySelector(".state-track");
      const delta = event.deltaY || event.deltaX;
      if (!track || !delta) return;
      event.preventDefault();
      const { view, onViewChange } = zoom.current;
      if (delta > 0 && view.zoom <= 1) return;
      const rect = track.getBoundingClientRect();
      const anchor = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const factor = delta > 0 ? 1 / wheelZoomFactor : wheelZoomFactor;
      onViewChange((current) => ({
        ...current,
        x: clampAxis(zoomAxis(current.x, factor, anchor)),
      }));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => () => playback.setPreview(null), [playback]);
  const timeAt = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return domain[0] + ((event.clientX - rect.left) / rect.width) * (domain[1] - domain[0]);
  };
  const visible = series.filter((s) => !s.hidden);
  const segments = useMemo(
    () => new Map(visible.map((item) => [item.key, stateSegments(item, fullEnd)])),
    [visible, fullEnd],
  );
  return (
    <div className="state-plot" ref={plot} aria-label="State transitions">
      {visible.map((s) => (
        <div className="state-row" key={s.key}>
          <div className="state-label">
            <SeriesName inline source={s.source} topic={s.topicName ?? s.topic} path={s.path} />
          </div>
          <div
            className="state-track"
            onClick={(event) => playback.seek(timeAt(event))}
            onPointerMove={(event) => playback.setPreview(timeAt(event))}
            onPointerLeave={() => playback.setPreview(null)}
          >
            {(segments.get(s.key) ?? []).map((segment, i) => {
              if (segment.end < domain[0] || segment.start > domain[1]) return null;
              const span = domain[1] - domain[0];
              const left = Math.max(0, Math.min(100, ((segment.start - domain[0]) / span) * 100));
              const right = Math.max(left, Math.min(100, ((segment.end - domain[0]) / span) * 100));
              return (
                <div
                  key={`${segment.ns}-${i}`}
                  className="state-segment"
                  style={{
                    left: `${left}%`,
                    width: `${right - left}%`,
                    backgroundColor: segment.color,
                  }}
                  title={`${formatter.tooltip(segment.start)} · ${segment.value === "" ? "Empty string" : segment.value}`}
                >
                  {segment.value === "" ? (
                    <span className="state-empty">(empty string)</span>
                  ) : (
                    <span>{segment.value}</span>
                  )}
                </div>
              );
            })}
            <StatePlayhead domain={domain} />
          </div>
        </div>
      ))}
      {visible.length > 0 && <StateAxis formatter={formatter} domain={domain} />}
    </div>
  );
}
