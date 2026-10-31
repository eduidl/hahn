import { useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import { secondsFrom } from "../data/data";
import type { FieldIndex } from "../workspace/fieldIndex";
import { usePlayback, usePlaybackStore } from "../workspace/playback";
import {
  cellValue,
  clampColumnWidth,
  defaultColumnWidth,
  minColumnWidth,
  maxColumnWidth,
  tableColumns,
  type MessageRow,
  type TableColumn,
} from "./table";
import { useTimeFormatter } from "../timeDisplay";
import type { MessageRecord } from "../data/useMessages";
import type { Widget, WorkspaceAction } from "../workspace/widgets";

const rowHeight = 26;
const headerHeight = 28;
const overscan = 10;

/** Pointer capture keeps the resize active outside the header and scroll area. */
function ColumnResizeHandle({
  label,
  width,
  defaultWidth,
  onChange,
}: {
  label: string;
  width: number;
  defaultWidth: number;
  onChange: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  return (
    <div
      className="table-column-resize"
      role="separator"
      aria-label={`${label} width`}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={minColumnWidth}
      aria-valuemax={maxColumnWidth}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = { pointerId: event.pointerId, x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        onChange(clampColumnWidth(start.width + event.clientX - start.x));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onChange(defaultWidth)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 64 : 16;
        onChange(
          event.key === "Home"
            ? defaultWidth
            : clampColumnWidth(width + (event.key === "ArrowLeft" ? -step : step)),
        );
      }}
    />
  );
}

export function messageAt(rows: MessageRow[], ns: bigint) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (BigInt(rows[mid].time_ns) <= ns) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function TableView({
  widget,
  record,
  index,
  originNs,
  dispatch,
}: {
  widget: Widget;
  record?: MessageRecord;
  index: FieldIndex;
  originNs: string | null;
  dispatch: Dispatch<WorkspaceAction>;
}) {
  const time = usePlayback((s) => s.time);
  const store = usePlaybackStore();
  const selected = widget.series[0];
  const columns = useMemo(() => {
    const hidden = new Set(widget.hiddenColumns);
    return selected
      ? tableColumns(index, selected).filter((column) => !hidden.has(JSON.stringify(column.path)))
      : [];
  }, [index, selected?.key, widget.hiddenColumns]);
  const timeWidth = widget.timeDisplay === "relative" ? 104 : 192;
  const widthOf = (column: TableColumn | null) =>
    widget.columnWidths?.[column === null ? "time" : JSON.stringify(column.path)] ??
    (column === null ? timeWidth : defaultColumnWidth(column));
  const resize = (path: string[] | null, width: number) =>
    dispatch({ type: "table-column-width", id: widget.id, path, width });
  const formatter = useTimeFormatter(originNs, widget.timeDisplay);
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const rows = record?.rows ?? [];
  const current =
    originNs === null ? -1 : messageAt(rows, BigInt(originNs) + BigInt(Math.round(time * 1e9)));
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(node);
    return () => observer.disconnect();
  }, [selected?.key]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    node.scrollTop = 0;
    node.scrollLeft = 0;
    setScrollTop(0);
  }, [selected?.key]);
  useEffect(() => {
    const node = viewport.current;
    if (!node || current < 0) return;
    const top = headerHeight + current * rowHeight;
    if (top < node.scrollTop + headerHeight || top + rowHeight > node.scrollTop + node.clientHeight)
      node.scrollTop = Math.max(0, top - node.clientHeight / 2);
  }, [current, selected?.key]);

  if (!selected) return null;
  const first = Math.max(
    0,
    Math.min(rows.length, Math.floor(Math.max(0, scrollTop - headerHeight) / rowHeight) - overscan),
  );
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const status =
    !record || record.status === "loading"
      ? "Loading…"
      : record.status === "error"
        ? `Loading error · ${record.error}`
        : record.status === "stopped"
          ? "Stopped · partial data"
          : "Complete";
  return (
    <div className="table-view">
      <div className="table-status" role="status">
        {status} · {rows.length.toLocaleString()} messages
      </div>
      <div
        className="table-scroll"
        ref={viewport}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <table
          aria-label="Message history"
          aria-rowcount={rows.length + 1}
          style={{
            width: widthOf(null) + columns.reduce((total, column) => total + widthOf(column), 0),
          }}
        >
          <colgroup>
            <col style={{ width: widthOf(null) }} />
            {columns.map((c) => (
              <col key={JSON.stringify(c.path)} style={{ width: widthOf(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" aria-label="Time">
                <span className="table-column-title">Time</span>
                <ColumnResizeHandle
                  label="Time"
                  width={widthOf(null)}
                  defaultWidth={timeWidth}
                  onChange={(width) => resize(null, width)}
                />
              </th>
              {columns.map((column) => (
                <th scope="col" key={JSON.stringify(column.path)} aria-label={column.label}>
                  <span className="table-column-title" title={column.label}>
                    {column.label}
                  </span>
                  <button
                    className="table-column-hide"
                    aria-label={`Hide ${column.label}`}
                    title="Hide this column"
                    onClick={() =>
                      dispatch({
                        type: "table-column",
                        id: widget.id,
                        path: column.path,
                        visible: false,
                      })
                    }
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="m4 4 8 8m0-8-8 8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </button>
                  <ColumnResizeHandle
                    label={column.label}
                    width={widthOf(column)}
                    defaultWidth={defaultColumnWidth(column)}
                    onChange={(width) => resize(column.path, width)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={columns.length + 1}
                  className="table-spacer"
                  style={{ height: first * rowHeight }}
                />
              </tr>
            )}
            {rows.slice(first, last).map((row, offset) => {
              const position = first + offset;
              const x = originNs === null ? 0 : secondsFrom(row.time_ns, originNs);
              const tick = formatter.tick(x);
              const seek = () => store.seek(x);
              return (
                <tr
                  key={position}
                  aria-rowindex={position + 2}
                  aria-current={position === current ? "true" : undefined}
                  className={position === current ? "current" : ""}
                  tabIndex={0}
                  onClick={seek}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      seek();
                    }
                  }}
                >
                  <td title={`${formatter.tooltip(x)} · ${row.time_ns} ns`}>
                    {tick.date ? `${tick.date} ` : ""}
                    {tick.time}
                  </td>
                  {columns.map((column) => {
                    const value = cellValue(row.value, column);
                    return (
                      <td key={JSON.stringify(column.path)} title={value}>
                        {value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {last < rows.length && (
              <tr aria-hidden="true">
                <td
                  colSpan={columns.length + 1}
                  className="table-spacer"
                  style={{ height: (rows.length - last) * rowHeight }}
                />
              </tr>
            )}
          </tbody>
        </table>
        {record?.status === "complete" && !rows.length && <p className="log-empty">No messages</p>}
      </div>
    </div>
  );
}
