import { useEffect, useMemo, useRef, useState } from "react";
import { stateLabel } from "./data";
import type { Series } from "./Plot";
import { usePlayback, usePlaybackStore } from "./playback";
import { timeFormatter } from "./timeDisplay";
import type { Widget } from "./widgets";

type Row = { x: number; ns: string; series: number; value: string };

/** Fixed so only the visible rows need to be rendered. */
const rowHeight = 22;
/** Rows rendered beyond the visible ones, to keep scrolling smooth. */
const overscan = 10;

/** Value changes of every visible series, merged in time order. */
export function changes(series: Series[]): Row[] {
  const rows: Row[] = [];
  series.forEach((s, index) => {
    if (s.hidden) return;
    let previous: string | null = null;
    for (const point of s.points) {
      if (point.raw === null) {
        previous = null;
        continue;
      }
      const value = stateLabel(point.raw, s.enumValues);
      if (value === previous) continue;
      previous = value;
      rows.push({ x: point.x, ns: point.ns, series: index, value });
    }
  });
  // Stable sort keeps file order for equal timestamps.
  return rows.sort((a, b) => a.x - b.x);
}

/** Last row at or before `time`, or -1 before the first row. */
export function rowAt(rows: { x: number }[], time: number) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].x <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function LogView({
  widget,
  series,
  originNs,
  revision,
}: {
  widget: Widget;
  series: Series[];
  originNs: string | null;
  revision: number;
}) {
  const store = usePlaybackStore();
  const time = usePlayback((s) => s.time);
  const visibility = JSON.stringify(series.map((s) => [s.key, s.hidden, s.points.length]));
  // Points grow in place, so rebuild on new data rather than on every playhead frame.
  const rows = useMemo(() => changes(series), [visibility, revision]);
  const formatter = useMemo(
    () => timeFormatter(originNs, widget.timeDisplay),
    [originNs, widget.timeDisplay],
  );
  const list = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  // The list only mounts once there are series, so observe it from then on.
  const mounted = series.length > 0;
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(node);
    return () => observer.disconnect();
  }, [mounted]);

  const current = rowAt(rows, time);
  // Keep the current row in view as the playhead moves or jumps.
  useEffect(() => {
    const node = list.current;
    if (!node || current < 0) return;
    const top = current * rowHeight;
    if (top < node.scrollTop || top + rowHeight > node.scrollTop + node.clientHeight)
      node.scrollTop = Math.max(0, top - node.clientHeight / 2);
  }, [current]);

  if (!series.length) return null;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  return (
    <div className="log-view">
      <div className="log-header">
        <span>時刻</span>
        <span>系列</span>
        <span>値</span>
      </div>
      <div
        className="log-rows"
        ref={list}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {!rows.length && <p className="log-empty">値がありません</p>}
        <div style={{ height: rows.length * rowHeight, position: "relative" }}>
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            const s = series[row.series];
            return (
              <button
                key={index}
                className={`log-row ${index === current ? "current" : ""}`}
                style={{ top: index * rowHeight, height: rowHeight }}
                title={`${s.topic} · ${s.path.join(".")}`}
                onClick={() => store.seek(row.x)}
              >
                <span className="log-time">{formatter.tick(row.x).time}</span>
                <span className="log-series">
                  <i style={{ background: s.color }} />
                  {s.path.join(".")}
                </span>
                <span className={`log-value ${row.value === "" ? "empty" : ""}`}>
                  {row.value === "" ? "（空文字列）" : row.value}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
