import { memo, useMemo, useRef } from "react";
import { secondsFrom } from "../data/data";
import { useCurrentMessage } from "../data/useCurrentMessage";
import { useTimeFormatter } from "../timeDisplay";
import { type Info } from "../types";
import type { Widget } from "../workspace/widgets";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Levels open when a message is first shown, and after resetting the view. */
const initialDepth = 1;

const isObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One node of the message tree; containers fold, the first level starts open. */
const Node = memo(function MessageNode({
  name,
  value,
  depth,
}: {
  name: string;
  value: Json;
  depth: number;
  path: string[];
  folding: Map<string, boolean>;
  series: Selected;
  index: FieldIndex;
}) {
  if (isObject(value) && typeof value.$bytes === "number") {
    const head = Array.isArray(value.head) ? value.head : [];
    return (
      <div className="raw-leaf">
        <span className="raw-key">{name}</span>
        <span className="raw-meta">
          bytes ({value.$bytes.toLocaleString()}) [{head.join(", ")}
          {value.$bytes > head.length ? ", …" : ""}]
        </span>
      </div>
    );
  }
  const truncated = isObject(value) && value.$truncated === true;
  const children: [string, Json][] = truncated
    ? ((value as { items: Json[] }).items ?? []).map((item, i) => [String(i), item])
    : Array.isArray(value)
      ? value.map((item, i) => [String(i), item])
      : isObject(value)
        ? Object.entries(value)
        : [];
  if (!Array.isArray(value) && !isObject(value)) {
    return (
      <div className="raw-leaf">
        <span className="raw-key">{name}</span>
        <span className={`raw-value raw-${value === null ? "null" : typeof value}`}>
          {typeof value === "string" ? JSON.stringify(value) : String(value)}
        </span>
      </div>
    );
  }
  const length = truncated ? Number((value as { length: number }).length) : children.length;
  const summary = Array.isArray(value) || truncated ? `[${length.toLocaleString()}]` : "{…}";
  const id = JSON.stringify(path);
  return (
    <details
      className="raw-node"
      open={folding.get(id) ?? depth < initialDepth}
      data-depth={depth}
      data-path={id}
      onToggle={(event) => {
        if (event.target === event.currentTarget) folding.set(id, event.currentTarget.open);
      }}
    >
      <summary>
        <span className="raw-key">{name}</span>
        <span className="raw-meta">{summary}</span>
      </summary>
      <div className="raw-children">
        {children.map(([key, child]) => (
          <Node
            key={key}
            name={key}
            value={child}
            depth={depth + 1}
            path={[...path, key]}
            folding={folding}
            series={series}
            index={index}
          />
        ))}
        {truncated && (
          <div className="raw-meta raw-more">
            … showing {children.length} of {length.toLocaleString()} items
          </div>
        )}
      </div>
    </details>
  );
});

/** The selected topic or field as it was at the playback position. */
export function RawMessage({ widget, info }: { widget: Widget; info: Info | null }) {
  const series = widget.series[0];
  const { message, error } = useCurrentMessage(series, info);
  const formatter = useTimeFormatter(info?.start_ns ?? null, widget.timeDisplay);

  const folding = useMemo(() => new Map<string, boolean>(), [series?.key, info?.start_ns]);
  const tree = useRef<HTMLDivElement>(null);
  const expandAll = () =>
    tree.current?.querySelectorAll("details").forEach((node) => {
      node.open = true;
      folding.set(node.dataset.path!, true);
    });
  const resetFolding = () => {
    folding.clear();
    tree.current?.querySelectorAll("details").forEach((node) => {
      node.open = Number(node.dataset.depth) < initialDepth;
    });
  };

  if (!series) return null;
  return (
    <div className="raw-message" ref={tree}>
      {error ? (
        <p className="raw-status raw-error">{error}</p>
      ) : message === undefined ? (
        <p className="raw-status">Loading…</p>
      ) : message === null ? (
        <p className="raw-status">No messages</p>
      ) : (
        <>
          <div className="raw-toolbar">
            <span className="raw-status">
              {formatter.tooltip(secondsFrom(message.time_ns, info!.start_ns))}
            </span>
            <button onClick={expandAll}>Expand all</button>
            <button onClick={resetFolding}>Reset view</button>
          </div>
          <Node
            key={`${series.key}:${info?.start_ns}`}
            name={series.path.length ? series.path.join(".") : series.topic}
            value={message.value}
            depth={0}
            path={[]}
            folding={folding}
            series={series}
            index={index}
          />
        </>
      )}
    </div>
  );
}
