import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { timeFormatter, type TimeDisplay } from "./timeDisplay";
import { lowerBound, nearest, type Point } from "./data";
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
import { SeriesName } from "./SeriesName";
import { isDiscreteKind, valueKind } from "./types";

export type DragMode = "pan" | "zoom";

export type Series = {
  key: string;
  topic: string;
  path: string[];
  color: string;
  lineWidth: number;
  hidden: boolean;
  points: Point[];
  dataType?: string;
  enumValues?: { name: string; value: number }[];
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
  timeDisplay: TimeDisplay;
  revision: number;
  view: PlotView;
  onViewChange: (update: (view: PlotView) => PlotView) => void;
  mode: DragMode;
  onCanReset: (canReset: boolean) => void;
};
const right = 24,
  top = 30;
const wheelZoomFactor = 1.1;
const format = (n: number) =>
  Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumSignificantDigits: 6 })
    : "—";

export function Plot({
  series,
  fullEnd,
  originNs,
  timeDisplay,
  revision,
  view,
  onViewChange,
  mode,
  onCanReset,
}: Props) {
  const bottom = timeDisplay === "absolute" ? 70 : 52;
  const time = useMemo(
    () => timeFormatter(originNs, timeDisplay),
    [originNs, timeDisplay],
  );
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
      pinnedYBase:
        typeof action === "function" ? action(current.pinnedYBase) : action,
    }));
  // Widgets hold a single value kind, so the first series decides the axis.
  const kind = series.length
    ? valueKind(series[0].dataType, series[0].enumValues)
    : null;
  const discrete = isDiscreteKind(kind);
  const categories = useMemo(() => discreteYValues(series), [series, revision]);
  const discreteLabel = (value: number) => {
    if (kind?.type === "bool") return value ? "true" : "false";
    const labels = [...new Set(series.flatMap((item) =>
      item.hidden ? [] : (item.enumValues ?? [])
        .filter((entry) => entry.value === value)
        .map((entry) => entry.name),
    ))];
    return labels.length ? labels.join(" / ") : format(value);
  };
  const left = discrete
    ? Math.max(76, Math.min(210, ...categories.map((value) => discreteLabel(value).length * 7 + 18)))
    : 76;
  const categoryIndex = useMemo(
    () => new Map(categories.map((value, index) => [value, index])),
    [categories],
  );
  const dataYBase = useMemo(
    () => discrete && categories.length
      ? [-0.5, Math.max(0.5, categories.length - 0.5)] as AxisRange
      : seriesYRange(series),
    [series, categories, discrete],
  );
  const yBase = pinnedYBase ?? dataYBase;
  const domain = axisRange([0, fullEnd], xView);
  const yDomain = axisRange(yBase, yView);
  const canReset =
    !isDefaultView(xView) ||
    !isDefaultView(yView) ||
    (pinnedYBase !== null &&
      (pinnedYBase[0] !== dataYBase[0] || pinnedYBase[1] !== dataYBase[1]));
  useLayoutEffect(() => {
    onCanReset(canReset);
  }, [canReset, onCanReset]);
  const pinY = () => {
    if (discrete) return;
    if (
      series.some(
        (s) =>
          !s.hidden &&
          s.points.some(
            (point) => point.y !== null && Number.isFinite(point.y),
          ),
      )
    ) {
      setPinnedYBase((base) => base ?? dataYBase);
    }
  };
  const reset = () => onViewChange(() => defaultPlotView());
  const [size, setSize] = useState({ w: 900, h: 500 });
  const [cursor, setCursor] = useState<number | null>(null);
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
  const xAt = (x: number) =>
    domain[0] + ((x - left) / w) * (domain[1] - domain[0]);
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
    const px = (x: number) =>
      left + ((x - domain[0]) / (domain[1] - domain[0])) * w;
    const py = (y: number) => top + h - ((y - min) / (max - min)) * h;
    const yOf = (value: number) =>
      py(discrete ? categoryIndex.get(value)! : value);
    ctx.font = "11px ui-monospace, monospace";
    const yTicks = discrete
      ? categories.map((value, index) => ({ coordinate: index, label: discreteLabel(value) }))
          .filter((tick) => tick.coordinate >= yDomain[0] && tick.coordinate <= yDomain[1])
          .filter((_, index, all) => index % Math.max(1, Math.ceil(all.length / 6)) === 0)
          .map((tick) => ({ y: py(tick.coordinate), label: tick.label }))
      : Array.from({ length: 6 }, (_, i) => ({
          y: top + (h * i) / 5,
          label: format(yDomain[1] - ((yDomain[1] - yDomain[0]) * i) / 5),
        }));
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
    const ticks = Math.max(
      1,
      Math.min(6, Math.floor(w / (timeDisplay === "absolute" ? 135 : 85))),
    );
    for (let i = 0; i <= ticks; i++) {
      const x = left + (w * i) / ticks;
      ctx.strokeStyle = "#202020";
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + h);
      ctx.stroke();
      ctx.textAlign = i === 0 ? "left" : i === ticks ? "right" : "center";
      const label = time.tick(
        domain[0] + ((domain[1] - domain[0]) * i) / ticks,
      );
      ctx.fillStyle = "#a0a0a0";
      ctx.fillText(label.time, x, top + h + 24);
      if (label.date) {
        ctx.fillStyle = "#737373";
        ctx.fillText(label.date, x, top + h + 39);
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
      for (let i = start; i < s.points.length; i++) {
        const p = s.points[i];
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
        }
        else ctx.moveTo(x, y);
        connected = true;
        previousY = y;
        if (p.x > domain[1]) break;
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
    if (cursor !== null) {
      ctx.strokeStyle = "#c7c7c7";
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
      ctx.fillRect(
        Math.min(drag.start, drag.end),
        top,
        Math.abs(drag.end - drag.start),
        h,
      );
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
    timeDisplay,
    discrete,
    kind,
    categories,
    categoryIndex,
    left,
  ]);

  return (
    <div className="plot-wrap">
      <div className="axis-scales" aria-label="表示倍率">
        <output aria-label="横軸倍率">X {format(xView.zoom)}×</output>
        <output aria-label="縦軸倍率">Y {format(yView.zoom)}×</output>
      </div>
      <canvas
        ref={canvas}
        aria-label={`時系列プロット。ドラッグで${mode === "pan" ? "パン" : "横軸の範囲ズーム"}。ホイールで横軸、Shift＋ホイールで縦軸をズーム。ダブルクリックでリセット。`}
        style={{
          cursor: mode === "pan" ? (drag ? "grabbing" : "grab") : "crosshair",
        }}
        data-drag-mode={mode}
        data-time-display={timeDisplay}
        data-x-min={domain[0]}
        data-x-max={domain[1]}
        data-y-min={yDomain[0]}
        data-y-max={yDomain[1]}
        data-y-scale={discrete ? "discrete" : "linear"}
        role="img"
        onPointerMove={(e) => {
          const pointerX =
            e.clientX - e.currentTarget.getBoundingClientRect().left;
          const x = Math.max(left, Math.min(left + w, pointerX));
          setCursor(x);
          const active = dragRef.current;
          if (active) {
            const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
            const next = {
              ...active,
              end: active.pan ? pointerX : x,
              moved:
                active.moved ||
                Math.hypot(
                  (active.pan ? pointerX : x) - active.start,
                  y - active.startY,
                ) > 4,
            };
            dragRef.current = next;
            setDrag(next);
            if (active.pan && next.moved) {
              pinY();
              setXView(panAxis(active.xView, (active.start - pointerX) / w));
              setYView(panAxis(active.yView, (y - active.startY) / h));
            }
          }
        }}
        onPointerLeave={() => setCursor(null)}
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
          if (
            active &&
            !active.pan &&
            Math.abs(active.end - active.start) > 4
          ) {
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
              Math.min(
                top + h,
                e.clientY - e.currentTarget.getBoundingClientRect().top,
              ),
            );
            setYView((view) => zoomAxis(view, zoomFactor, 1 - (y - top) / h));
            return;
          }
          const x = Math.max(
            left,
            Math.min(
              left + w,
              e.clientX - e.currentTarget.getBoundingClientRect().left,
            ),
          );
          setXView((view) => zoomAxis(view, zoomFactor, (x - left) / w));
        }}
        onDoubleClick={reset}
      />
      {cursor !== null && (
        <div className="tooltip">
          <div className="tooltip-time">{time.tooltip(xAt(cursor))}</div>
          {series
            .filter((s) => !s.hidden)
            .map((s) => {
              const p = nearest(s.points, xAt(cursor));
              return (
                <div key={s.key}>
                  <i style={{ background: s.color }} />
                  <SeriesName topic={s.topic} path={s.path} />
                  <strong title={p?.ns}>
                    {p?.raw == null ? "—" : String(p.raw)}
                  </strong>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
