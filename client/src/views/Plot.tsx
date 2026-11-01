import "./Plot.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useTimeFormatter } from "../timeDisplay";
import { lowerBound, nearest, type Point } from "../data/data";
import {
  axisRange,
  defaultView,
  isDefaultView,
  panAxis,
  selectAxis,
  seriesYRange,
  discreteYValues,
  zoomAxis,
  type AxisRange,
  type AxisView,
} from "./axes";
import { SeriesName } from "../SeriesName";
import { linearTicks, timeTicks } from "./ticks";
import type { LegendSettings } from "../workspace/widgets";
import { usePlayback, usePlaybackStore } from "../workspace/playback";
import { isDiscreteKind, valueKind, type EnumValue } from "../types";

export type DragMode = "pan" | "zoom";

export type Series = {
  key: string;
  source: string;
  topic: string;
  topicName?: string;
  path: string[];
  color: string;
  lineWidth: number;
  hidden: boolean;
  points: Point[];
  dataType?: string;
  enumValues?: EnumValue[];
};
export type PlotView = {
  x: AxisView;
  y: AxisView;
  pinnedYBase: AxisRange | null;
};
export const defaultPlotView = (): PlotView => ({
  x: defaultView(),
  y: defaultView(),
  pinnedYBase: null,
});
type Props = {
  series: Series[];
  fullEnd: number;
  originNs: string | null;
  revision: number;
  view: PlotView;
  onViewChange: (update: (view: PlotView) => PlotView) => void;
  mode: DragMode;
  legend: LegendSettings;
  /** Series chosen in the widget, including ones whose data has not arrived yet. */
  onCanReset: (canReset: boolean) => void;
  onToggleSeries: (key: string) => void;
};
const right = 24,
  top = 30;
/**
 * The points worth drawing: in each pixel column the first, lowest, highest and last, which
 * look the same as all of them, spikes included. Points without a value are kept as gaps.
 * Stops after the first point past `end`, so that the line runs off the edge.
 */
export function drawnPoints<T extends { x: number; y: number | null }>(
  points: T[],
  start: number,
  end: number,
  xOf: (x: number) => number,
): T[] {
  const drawn: T[] = [];
  let column = Number.NaN;
  let first = -1;
  let low = -1;
  let high = -1;
  let last = -1;
  const flush = () => {
    if (first < 0) return;
    for (const i of [first, low, high, last].sort((a, b) => a - b))
      if (drawn[drawn.length - 1] !== points[i]) drawn.push(points[i]);
    first = -1;
  };
  for (let i = start; i < points.length; i++) {
    const { x, y } = points[i];
    if (y === null) {
      flush();
      drawn.push(points[i]);
    } else {
      const pixel = Math.floor(xOf(x));
      if (pixel !== column || first < 0) {
        flush();
        column = pixel;
        first = low = high = i;
      }
      if (y < (points[low].y as number)) low = i;
      if (y > (points[high].y as number)) high = i;
      last = i;
    }
    if (x > end) break;
  }
  flush();
  return drawn;
}

export const wheelZoomFactor = 1.1;

/** Floats to 6 significant digits; other values as they are, because integers must stay exact. */
export function tooltipValue(raw: Point["raw"], dataType: string | undefined): string {
  if (raw === null) return "—";
  if (typeof raw === "number" && dataType?.startsWith("float") && Number.isFinite(raw))
    return String(Number(raw.toPrecision(6)));
  return String(raw);
}
// Canvas fonts cannot read CSS variables: keep this in step with --font-ui.
const axisFont =
  '12px Inter, "Noto Sans JP", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
let measureContext: CanvasRenderingContext2D | null | undefined;
/** Rendered width of a tick label, measured once per call on a shared canvas. */
function labelWidth(text: string) {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 7;
  measureContext.font = axisFont;
  return measureContext.measureText(text).width;
}
const format = (n: number) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumSignificantDigits: 6 }) : "—";

/** Isolated so the per-frame playhead updates skip the full canvas redraw. */
function Playhead({
  domain,
  left,
  top,
  w,
  h,
}: {
  domain: AxisRange;
  left: number;
  top: number;
  w: number;
  h: number;
}) {
  const time = usePlayback((s) => s.time);
  const ratio = (time - domain[0]) / (domain[1] - domain[0]);
  if (!(ratio >= 0 && ratio <= 1)) return null;
  return <div className="playhead" style={{ left: left + ratio * w, top, height: h }} />;
}

export function Plot({
  series,
  fullEnd,
  originNs,
  revision,
  view,
  onViewChange,
  mode,
  legend,
  onCanReset,
  onToggleSeries,
}: Props) {
  const time = useTimeFormatter(originNs);
  const bottom = time.clock ? 70 : 52;
  const playback = usePlaybackStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  const { x: xView, y: yView, pinnedYBase } = view;
  const setXView = (action: SetStateAction<AxisView>) =>
    onViewChange((current) => ({
      ...current,
      x: typeof action === "function" ? action(current.x) : action,
    }));
  const setYView = (action: SetStateAction<AxisView>) =>
    onViewChange((current) => ({
      ...current,
      y: typeof action === "function" ? action(current.y) : action,
    }));
  const setPinnedYBase = (action: SetStateAction<AxisRange | null>) =>
    onViewChange((current) => ({
      ...current,
      pinnedYBase: typeof action === "function" ? action(current.pinnedYBase) : action,
    }));
  // Widgets hold a single value kind, so the first series decides the axis.
  const kind = series.length ? valueKind(series[0].dataType, series[0].enumValues) : null;
  const discrete = isDiscreteKind(kind);
  // The array is new on every render, but scanning every point is too slow to repeat for a zoom.
  const content = series.map((s) => `${s.key}:${s.hidden}:${s.points.length}`).join();
  const categories = useMemo(
    () => (discrete ? discreteYValues(series) : []),
    [content, revision, discrete],
  );
  const discreteLabel = (value: number) => {
    if (kind?.type === "bool") return value ? "true" : "false";
    const labels = [
      ...new Set(
        series.flatMap((item) =>
          item.hidden
            ? []
            : (item.enumValues ?? [])
                .filter((entry) => Number(entry.value) === value)
                .map((entry) => entry.name),
        ),
      ),
    ];
    return labels.length ? labels.join(" / ") : format(value);
  };
  const categoryIndex = useMemo(
    () => new Map(categories.map((value, index) => [value, index])),
    [categories],
  );
  const dataYBase = useMemo(
    () =>
      discrete && categories.length
        ? ([-0.5, Math.max(0.5, categories.length - 0.5)] as AxisRange)
        : seriesYRange(series),
    [content, revision, categories, discrete],
  );
  const yBase = pinnedYBase ?? dataYBase;
  const domain = axisRange([0, fullEnd], xView);
  const yDomain = axisRange(yBase, yView);
  const linear = discrete ? null : linearTicks(yDomain[0], yDomain[1]);
  const yLabels = discrete ? categories.map(discreteLabel) : linear!.labels;
  // Fit the Y axis to its widest label, within bounds.
  const left = Math.round(
    Math.max(48, Math.min(210, Math.max(0, ...yLabels.map(labelWidth)) + 24)),
  );
  // The shared offset/exponent is drawn above the axis, from the canvas edge.
  const annotationX = 8;
  const canReset =
    !isDefaultView(xView) ||
    !isDefaultView(yView) ||
    (pinnedYBase !== null && (pinnedYBase[0] !== dataYBase[0] || pinnedYBase[1] !== dataYBase[1]));
  useLayoutEffect(() => {
    onCanReset(canReset);
  }, [canReset, onCanReset]);
  const pinY = () => {
    if (discrete) return;
    if (
      series.some(
        (s) => !s.hidden && s.points.some((point) => point.y !== null && Number.isFinite(point.y)),
      )
    ) {
      setPinnedYBase((base) => base ?? dataYBase);
    }
  };
  const [size, setSize] = useState({ w: 900, h: 500 });
  const [cursor, setCursor] = useState<number | null>(null);
  const [pointerY, setPointerY] = useState<number | null>(null);
  const [drag, setDrag] = useState<{
    start: number;
    end: number;
    startY: number;
    pan: boolean;
    moved: boolean;
    xView: AxisView;
    yView: AxisView;
  } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const w = Math.max(1, size.w - left - right),
    h = Math.max(1, size.h - top - bottom);
  // Inset the legend from the chosen corner of the plotting area.
  const inset = 8;
  const [vertical, horizontal] = legend.position.split("-");
  const legendStyle = {
    [vertical]: vertical === "top" ? top + inset : bottom + inset,
    [horizontal]: horizontal === "left" ? left + inset : right + inset,
    // May cover the axis labels on the far side, but must stay inside the widget.
    maxWidth: Math.max(0, size.w - (horizontal === "left" ? left : right) - inset - 4),
  };
  // Hover readouts (cursor line and tooltip) only make sense with something drawn.
  const hasVisible = series.some((s) => !s.hidden);
  // The hover tooltip sits below-right of the pointer and flips to the other
  // side only where it would overflow, which needs its rendered size.
  const tooltip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = tooltip.current;
    if (!node || cursor === null || pointerY === null) return;
    const offset = 14;
    const x =
      cursor + offset + node.offsetWidth > size.w
        ? cursor - offset - node.offsetWidth
        : cursor + offset;
    const y =
      pointerY + offset + node.offsetHeight > size.h
        ? pointerY - offset - node.offsetHeight
        : pointerY + offset;
    node.style.left = `${Math.max(0, x)}px`;
    node.style.top = `${Math.max(0, y)}px`;
  });
  const xAt = (x: number) => domain[0] + ((x - left) / w) * (domain[1] - domain[0]);
  useEffect(() => () => playback.setPreview(null), [playback]);
  const clearDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };

  useEffect(() => {
    const node = canvas.current!;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(node);
    const preventScroll = (event: WheelEvent) => event.preventDefault();
    node.addEventListener("wheel", preventScroll, { passive: false });
    return () => {
      observer.disconnect();
      node.removeEventListener("wheel", preventScroll);
    };
  }, []);

  useEffect(() => {
    const node = canvas.current!,
      ctx = node.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    node.width = size.w * dpr;
    node.height = size.h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.w, size.h);
    const visible = series.filter((s) => !s.hidden);
    const [min, max] = yDomain;
    const px = (x: number) => left + ((x - domain[0]) / (domain[1] - domain[0])) * w;
    const py = (y: number) => top + h - ((y - min) / (max - min)) * h;
    const yOf = (value: number) => py(discrete ? categoryIndex.get(value)! : value);
    ctx.font = axisFont;
    const yTicks = discrete
      ? categories
          .map((value, index) => ({ coordinate: index, label: discreteLabel(value) }))
          .filter((tick) => tick.coordinate >= yDomain[0] && tick.coordinate <= yDomain[1])
          .filter((_, index, all) => index % Math.max(1, Math.ceil(all.length / 6)) === 0)
          .map((tick) => ({ y: py(tick.coordinate), label: tick.label }))
      : linear!.values.map((value, i) => ({ y: py(value), label: linear!.labels[i] }));
    if (linear?.annotation) {
      ctx.fillStyle = "#a0a0a0";
      ctx.textAlign = "left";
      ctx.fillText(linear.annotation, annotationX, top - 12);
    }
    for (const tick of yTicks) {
      const y = tick.y;
      ctx.strokeStyle = "#242424";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + w, y);
      ctx.stroke();
      ctx.fillStyle = "#a0a0a0";
      ctx.textAlign = "right";
      ctx.fillText(tick.label, left - 12, y + 4);
    }
    const { values, step } = timeTicks(domain[0], domain[1], {
      width: w,
      minSpacing: time.minTickSpacing,
      offset: time.tickOffset,
      clock: time.clock,
    });
    let shownDate = "";
    ctx.textAlign = "center";
    for (const value of values) {
      const x = px(value);
      ctx.strokeStyle = "#202020";
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + h);
      ctx.stroke();
      const text = time.axisTime(value, step);
      // Keep edge labels inside the axis instead of running into its neighbors.
      const half = ctx.measureText(text).width / 2;
      const labelX = Math.max(left + half, Math.min(left + w - half, x));
      ctx.fillStyle = "#a0a0a0";
      ctx.fillText(text, labelX, top + h + 24);
      // The date repeats, so show it where it first appears and where it changes.
      const { date } = time.tick(value);
      if (date && date !== shownDate) {
        const dateHalf = ctx.measureText(date).width / 2;
        ctx.fillStyle = "#737373";
        ctx.fillText(
          date,
          Math.max(left + dateHalf, Math.min(left + w - dateHalf, x)),
          top + h + 39,
        );
        shownDate = date;
      }
    }
    ctx.fillStyle = "#808080";
    ctx.textAlign = "right";
    ctx.fillText(time.axisLabel, left + w, size.h - 5);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, w, h);
    ctx.clip();
    for (const s of visible) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.lineWidth;
      ctx.beginPath();
      let connected = false;
      let previousY = 0;
      const start = Math.max(0, lowerBound(s.points, domain[0]) - 1);
      for (const p of drawnPoints(s.points, start, domain[1], px)) {
        if (p.y === null) {
          connected = false;
          continue;
        }
        const x = px(p.x),
          y = yOf(p.y);
        if (connected) {
          if (discrete) {
            ctx.lineTo(x, previousY);
            ctx.lineTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        } else ctx.moveTo(x, y);
        connected = true;
        previousY = y;
      }
      ctx.stroke();
      // Single samples and duplicate timestamps should still be visible.
      if (s.points.length <= 500) {
        ctx.fillStyle = s.color;
        for (const p of s.points)
          if (p.y !== null) {
            ctx.beginPath();
            ctx.arc(px(p.x), yOf(p.y), 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
      }
    }
    if (cursor !== null && visible.length && !drag?.moved) {
      ctx.strokeStyle = "#c7c7c7";
      // Reset the width left over from the last series.
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(cursor, top);
      ctx.lineTo(cursor, top + h);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const s of visible) {
        const p = nearest(s.points, xAt(cursor));
        if (p?.y != null) {
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(px(p.x), yOf(p.y), 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (drag && !drag.pan) {
      ctx.fillStyle = "#91b8ff25";
      ctx.fillRect(Math.min(drag.start, drag.end), top, Math.abs(drag.end - drag.start), h);
    }
    ctx.restore();
  }, [
    series,
    domain,
    yDomain,
    size,
    cursor,
    drag,
    revision,
    time,
    time,
    discrete,
    kind,
    categories,
    categoryIndex,
    left,
    linear,
  ]);

  return (
    <div className="plot-wrap">
      <canvas
        ref={canvas}
        aria-label={`Plot. Drag to ${mode === "pan" ? "pan" : "zoom the time range"}. Click to move the playback position. Scroll to zoom the horizontal axis, or Shift-scroll for the vertical axis.`}
        style={{
          cursor: mode === "pan" ? (drag ? "grabbing" : "grab") : "crosshair",
        }}
        data-drag-mode={mode}
        data-time-display={time.clock ? "absolute" : "offset"}
        data-x-min={domain[0]}
        data-x-max={domain[1]}
        data-y-min={yDomain[0]}
        data-y-max={yDomain[1]}
        data-y-scale={discrete ? "discrete" : "linear"}
        role="img"
        onPointerMove={(e) => {
          const pointerX = e.clientX - e.currentTarget.getBoundingClientRect().left;
          const x = Math.max(left, Math.min(left + w, pointerX));
          setCursor(x);
          setPointerY(e.clientY - e.currentTarget.getBoundingClientRect().top);
          const active = dragRef.current;
          const canvasY = e.clientY - e.currentTarget.getBoundingClientRect().top;
          const inPlot =
            pointerX >= left && pointerX <= left + w && canvasY >= top && canvasY <= top + h;
          if (active) {
            const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
            const next = {
              ...active,
              end: active.pan ? pointerX : x,
              moved:
                active.moved ||
                Math.hypot((active.pan ? pointerX : x) - active.start, y - active.startY) > 4,
            };
            dragRef.current = next;
            setDrag(next);
            if (active.pan && next.moved) {
              pinY();
              setXView(panAxis(active.xView, (active.start - pointerX) / w));
              setYView(panAxis(active.yView, (y - active.startY) / h));
            }
          }
          playback.setPreview(inPlot && !dragRef.current?.moved ? xAt(pointerX) : null);
        }}
        onPointerLeave={() => {
          setCursor(null);
          setPointerY(null);
          playback.setPreview(null);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
          const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
          if (x < left || x > left + w || y < top || y > top + h) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const next = {
            start: x,
            end: x,
            startY: y,
            pan: mode === "pan",
            moved: false,
            xView,
            yView,
          };
          dragRef.current = next;
          setDrag(next);
        }}
        onPointerUp={() => {
          const active = dragRef.current;
          // A press without a drag is a click.
          if (active && !active.moved) playback.seek(xAt(active.start));
          if (active && !active.pan && Math.abs(active.end - active.start) > 4) {
            pinY();
            setXView(
              selectAxis(
                active.xView,
                (Math.min(active.start, active.end) - left) / w,
                (Math.max(active.start, active.end) - left) / w,
              ),
            );
          }
          clearDrag();
        }}
        onPointerCancel={clearDrag}
        onWheel={(e) => {
          const delta = e.deltaY || e.deltaX;
          if (!delta) return;
          if (delta > 0 && (e.shiftKey ? yView.zoom : xView.zoom) <= 1) return;
          pinY();
          const zoomFactor = delta > 0 ? 1 / wheelZoomFactor : wheelZoomFactor;
          if (e.shiftKey) {
            const y = Math.max(
              top,
              Math.min(top + h, e.clientY - e.currentTarget.getBoundingClientRect().top),
            );
            setYView((view) => zoomAxis(view, zoomFactor, 1 - (y - top) / h));
            return;
          }
          const x = Math.max(
            left,
            Math.min(left + w, e.clientX - e.currentTarget.getBoundingClientRect().left),
          );
          setXView((view) => zoomAxis(view, zoomFactor, (x - left) / w));
        }}
      />
      <Playhead domain={domain} left={left} top={top} w={w} h={h} />
      {legend.visible && series.length > 0 && (
        <div className="plot-legend" style={legendStyle}>
          {series.map((s) => (
            <button
              key={s.key}
              className="plot-legend-item"
              aria-pressed={!s.hidden}
              aria-label={`Toggle visibility for ${[s.topicName ?? s.topic, ...s.path].join(" ")}`}
              onClick={() => onToggleSeries(s.key)}
            >
              <i className="series-dot" style={{ background: s.color }} />
              <SeriesName inline source={s.source} topic={s.topicName ?? s.topic} path={s.path} />
            </button>
          ))}
        </div>
      )}
      {/* Reading values gets in the way of a drag, and would describe where it started. */}
      {cursor !== null && pointerY !== null && hasVisible && !drag?.moved && (
        <div className="tooltip" ref={tooltip}>
          <div className="tooltip-time">{time.tooltip(xAt(cursor))}</div>
          {series
            .filter((s) => !s.hidden)
            .map((s) => {
              const p = nearest(s.points, xAt(cursor));
              return (
                <div key={s.key} className="tooltip-row">
                  <i className="series-dot" style={{ background: s.color }} />
                  <strong title={p?.ns}>{p ? tooltipValue(p.raw, s.dataType) : "—"}</strong>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
