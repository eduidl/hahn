import "./StatePlot.css";
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { axisRange, clampAxis, panAxis, zoomAxis, type AxisRange } from "./axes";
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
type StateSegment = { start: number; end: number; value: string; color: string; ns: string };
/** What one element shows: a single state, or several too short to tell apart (`segment` null). */
export type StateBand = {
  start: number;
  end: number;
  first: StateSegment;
  segment: StateSegment | null;
  count: number;
};
/** States narrower than this are merged with their neighbors, which would otherwise alias. */
const minBandPixels = 2;
/** The separator would cover a narrower band completely. */
const minSeparatedPixels = 4;
/** Below these widths a label is not readable, so it is not rendered. */
const minLabelPixels = 24;
const minMixedLabelPixels = 96;
/** A press that moves less than this is a click. */
const dragPixels = 4;

function stateSegments(series: Series, fullEnd: number) {
  const segments: StateSegment[] = [];
  let current: StateSegment | null = null;
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
/**
 * The bands to draw for a visible time range. There are at most about `width`
 * of them per row, however many states the recording has.
 */
export function stateBands(segments: StateSegment[], domain: AxisRange, width: number) {
  const bands: StateBand[] = [];
  const span = domain[1] - domain[0];
  if (width <= 0 || span <= 0) return bands;
  const pixels = width / span;
  // Segments are in time order, so the visible ones can be found without a scan.
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (segments[middle].end < domain[0]) low = middle + 1;
    else high = middle;
  }
  let run: Omit<StateBand, "segment"> | undefined;
  const flush = () => {
    if (run) bands.push({ ...run, segment: run.count === 1 ? run.first : null });
    run = undefined;
  };
  for (let i = low; i < segments.length && segments[i].start <= domain[1]; i++) {
    const segment = segments[i];
    const start = Math.max(segment.start, domain[0]);
    const end = Math.min(segment.end, domain[1]);
    if ((end - start) * pixels >= minBandPixels) {
      flush();
      bands.push({ start, end, first: segment, segment, count: 1 });
      continue;
    }
    // A visible gap of missing values stays a gap.
    if (run && (start - run.end) * pixels >= 1) flush();
    if (run) {
      run.end = end;
      run.count++;
    } else run = { start, end, first: segment, count: 1 };
  }
  flush();
  return bands;
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

type SegmentCache = {
  points: Series["points"];
  length: number;
  enumValues: Series["enumValues"];
  fullEnd: number;
  segments: StateSegment[];
};

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
  const drag = useRef<{ x: number; view: PlotView["x"]; moved: boolean } | null>(null);
  // The click that ends a drag must not also move the playback position.
  const dragged = useRef(false);
  const zoomed = widget.view.x.zoom > 1;
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !zoomed) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, view: widget.view.x, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (active) {
      const distance = event.clientX - active.x;
      active.moved ||= Math.abs(distance) > dragPixels;
      if (active.moved) {
        const delta = -distance / event.currentTarget.getBoundingClientRect().width;
        onViewChange((current) => ({ ...current, x: clampAxis(panAxis(active.view, delta)) }));
        playback.setPreview(null);
        return;
      }
    }
    playback.setPreview(timeAt(event));
  };
  const endDrag = () => {
    dragged.current = Boolean(drag.current?.moved);
    drag.current = null;
  };
  const visible = series.filter((s) => !s.hidden);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(plot.current!);
    return () => observer.disconnect();
  }, []);
  // Series objects are rebuilt on every render; their points change only while loading.
  const cache = useRef(new Map<string, SegmentCache>());
  const segmentsOf = (item: Series) => {
    const cached = cache.current.get(item.key);
    if (
      cached?.points === item.points &&
      cached.length === item.points.length &&
      cached.enumValues === item.enumValues &&
      cached.fullEnd === fullEnd
    )
      return cached.segments;
    const segments = stateSegments(item, fullEnd);
    cache.current.set(item.key, {
      points: item.points,
      length: item.points.length,
      enumValues: item.enumValues,
      fullEnd,
      segments,
    });
    return segments;
  };
  const span = domain[1] - domain[0];
  const percent = (time: number) => ((time - domain[0]) / span) * 100;
  return (
    <div className="state-plot" ref={plot}>
      {visible.map((s) => (
        <div className="state-row" key={s.key}>
          <div className="state-label">
            <SeriesName inline source={s.source} topic={s.topicName ?? s.topic} path={s.path} />
          </div>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the playback bar seeks from the keyboard */}
          <div
            className={zoomed ? "state-track state-track-pannable" : "state-track"}
            onClick={(event) => {
              if (!dragged.current) playback.seek(timeAt(event));
              dragged.current = false;
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => playback.setPreview(null)}
          >
            {stateBands(segmentsOf(s), domain, width).map((band, i) => {
              const pixels = ((band.end - band.start) / span) * width;
              const { segment } = band;
              const labeled = pixels >= (segment ? minLabelPixels : minMixedLabelPixels);
              const className = [
                "state-segment",
                segment ? "" : "state-segment-mixed",
                pixels < minSeparatedPixels ? "state-segment-thin" : "",
                labeled ? "state-segment-labeled" : "",
              ].join(" ");
              return (
                <div
                  key={`${band.first.ns}-${i}`}
                  className={className}
                  style={{
                    left: `${percent(band.start)}%`,
                    width: `${percent(band.end) - percent(band.start)}%`,
                    backgroundColor: segment?.color,
                  }}
                  title={
                    segment
                      ? `${formatter.tooltip(segment.start)} · ${segment.value === "" ? "Empty string" : segment.value}`
                      : `${formatter.tooltip(band.start)} to ${formatter.tooltip(band.end)} · ${band.count.toLocaleString()} states. Zoom in to see them.`
                  }
                >
                  {labeled &&
                    (!segment ? (
                      <span>Many changes</span>
                    ) : segment.value === "" ? (
                      <span className="state-empty">(empty string)</span>
                    ) : (
                      <span>{segment.value}</span>
                    ))}
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
