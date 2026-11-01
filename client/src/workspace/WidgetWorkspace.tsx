import {
  Suspense,
  createContext,
  lazy,
  useContext,
  useCallback,
  useEffect,
  type MouseEvent,
  useRef,
  useMemo,
  useState,
  type Dispatch,
  type DragEvent,
  type ReactNode,
} from "react";
import { TabBar } from "./TabControls";
import { timeTicks } from "../views/ticks";
import { axisRange, clampAxis, isDefaultView, zoomAxis, type AxisRange } from "../views/axes";
import { Mosaic, MosaicWindow, type MosaicPath } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { WidgetHelp } from "./WidgetHelp";
import { Plot, defaultPlotView, wheelZoomFactor, type PlotView, type Series } from "../views/Plot";
import { useTimeFormatter } from "../timeDisplay";
import type { DropVerdict } from "./drop";
import { stateLabel } from "../data/data";
import { ValueChangesView } from "../views/ValueChangesView";
import { TableView } from "../views/TableView";
import type { MessageRecord } from "../data/useMessages";
import type { FieldIndex } from "./fieldIndex";
import { RawMessage } from "../views/RawMessage";
import { TfTree } from "../views/TfTree";
import { SourceInfo } from "../views/SourceInfo";
import type { OpenSource } from "../data/sources";
import { ImageView } from "../views/ImageView";
import { flattenMapsForDragImage } from "../views/mapDragImage";
import { SeriesName } from "../SeriesName";
import { SourceNames } from "../data/sources";
import { usePlayback, usePlaybackStore } from "./playback";
import { dragMime, type Info } from "../types";
import {
  addAt,
  canMove,
  canPlaceWidget,
  ownerOf,
  containerLayout,
  leaves,
  withoutLifted,
  widgetMoveMime,
  type Container,
  widgetSpecs,
  widgetTypes,
  dropEdge,
  widgetDragMime,
  type DropEdge,
  type Widget,
  type WorkspaceAction,
  type WorkspaceState,
} from "./widgets";

// Three.js and Leaflet are large, and only needed once such a widget exists.
const Scene3D = lazy(() => import("../views/Scene3D"));
const MapView = lazy(() => import("../views/MapView"));

const MoveContext = createContext<{
  id: string | null;
  /** The moved widget once its drag has begun, from when the layout goes on without it. */
  liftedId: string | null;
  setId: (id: string | null) => void;
}>({
  id: null,
  liftedId: null,
  setId: () => {},
});

type Props = {
  runId?: string | null;
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  data: Series[];
  messageRecords: MessageRecord[];
  fieldIndex: FieldIndex;
  info: Info | null;
  sources: OpenSource[];
  fullEnd: number;
  revision: number;
  /** Whether the topic being dragged fits each widget; null when not dragging. */
  dragVerdict: (widget: Widget) => DropVerdict | null;
  /** Widget type being dragged from the catalog, if any. */
  widgetDrag: Widget["type"] | null;
  drop: (event: DragEvent, id: string) => void;
  openSettings: () => void;
};
export function widgetSeries(widget: Widget, data: Series[]): Series[] {
  const byKey = new Map(data.map((series) => [series.key, series]));
  return widget.series.flatMap((field) => {
    const cached = byKey.get(field.key);
    return cached ? [{ ...cached, ...field }] : [];
  });
}

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

function WidgetDropTarget({
  onDrop,
  frameOnly = false,
}: {
  onDrop: (edge: DropEdge) => void;
  frameOnly?: boolean;
}) {
  const [edge, setEdge] = useState<DropEdge | null>(null);
  const edgeAt = (event: DragEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return dropEdge(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
  };
  const isWidgetDrag = (event: DragEvent) =>
    [widgetDragMime, widgetMoveMime].some((type) => event.dataTransfer.types.includes(type));
  const accept = (event: DragEvent, side: DropEdge) => {
    if (!isWidgetDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(widgetMoveMime)
      ? "move"
      : "copy";
    setEdge(side);
  };
  const leave = () => setEdge(null);
  const place = (event: DragEvent, side: DropEdge) => {
    if (!isWidgetDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    onDrop(side);
    leave();
  };
  if (frameOnly) {
    const sides: Record<DropEdge, string> = {
      left: "left",
      right: "right",
      top: "top",
      bottom: "bottom",
    };
    return (
      <div className="widget-drop tab-frame-drop" aria-label="Tabs widget drop target">
        {(Object.keys(sides) as DropEdge[]).map((side) => (
          <div
            key={side}
            className={`widget-drop-edge ${side}`}
            aria-label={`Drop on the ${sides[side]} of the Tabs widget`}
            onDragOver={(event) => accept(event, side)}
            onDragLeave={leave}
            onDrop={(event) => place(event, side)}
          />
        ))}
        {edge && (
          <div className={`widget-drop-preview ${edge}`}>
            <span className="widget-drop-label">Drop on the {sides[edge]} of the Tabs widget</span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className="widget-drop"
      aria-label="Widget drop target"
      onDragOver={(event) => accept(event, edgeAt(event))}
      onDragLeave={leave}
      onDrop={(event) => place(event, edgeAt(event))}
    >
      {edge && <div className={`widget-drop-preview ${edge}`} />}
    </div>
  );
}

function WidgetWindow({ widget, path, ...props }: Props & { widget: Widget; path: MosaicPath }) {
  const { state, dispatch, data, info, fullEnd, revision, dragVerdict, drop, openSettings } = props;
  const moving = useContext(MoveContext);
  // Alone in its layout, it has nothing to give way to and stays in view.
  const lifted =
    moving.liftedId === widget.id &&
    leaves(containerLayout(state, ownerOf(state, widget.id))).length > 1;
  const sourceNames = useContext(SourceNames);
  const selection = widget.series
    .map((series) => {
      const group = sourceNames.size > 1 ? sourceNames.get(series.source) : undefined;
      const field = series.path.length ? ` · ${series.path.join(".")}` : "";
      return `${group ? `${group} · ` : ""}${series.topicName ?? series.topic}${field}`;
    })
    .join(", ");
  const owner = ownerOf(state, widget.id);
  const canDrop =
    (!!props.widgetDrag && canPlaceWidget(props.widgetDrag, owner)) ||
    (!!moving.id && canMove(state, moving.id, owner, widget.id));
  const [canReset, setCanReset] = useState(false);
  const verdict = widget.type === "tabs" ? null : dragVerdict(widget);
  const onViewChange = useCallback(
    (update: (view: PlotView) => PlotView) => dispatch({ type: "view", id: widget.id, update }),
    [dispatch, widget.id],
  );
  const menuId = `menu-${widget.id}`;
  const closeMenu = () => document.getElementById(menuId)?.hidePopover();
  const [changingType, setChangingType] = useState(false);
  // Closing late lets the pointer cut diagonally across other items to the submenu.
  const submenuTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const openSubmenu = (open: boolean) => {
    clearTimeout(submenuTimer.current);
    if (open) setChangingType(true);
    else submenuTimer.current = setTimeout(() => setChangingType(false), 300);
  };
  useEffect(() => () => clearTimeout(submenuTimer.current), []);
  // Menus are placed by CSS anchor positioning, which also flips them when
  // they would overflow the viewport.
  const menuAnchor = `--menu-${widget.id}`;
  const submenuAnchor = `--submenu-${widget.id}`;
  const action = (type: "row" | "column" | "clear" | "remove") => {
    closeMenu();
    if (type === "remove" || type === "clear") dispatch({ type, id: widget.id });
    // Splitting duplicates the widget; clearing the copy is cheaper than rebuilding it.
    else
      dispatch({
        type: "add",
        target: widget.id,
        direction: type,
        duplicate: true,
      });
  };
  const tabBar =
    widget.type === "tabs" ? (
      <TabBar
        widget={widget}
        dispatch={dispatch}
        acceptWidget={(event) =>
          (!!props.widgetDrag &&
            canPlaceWidget(props.widgetDrag, { widgetId: widget.id, tabId: widget.activeTabId }) &&
            event.dataTransfer.types.includes(widgetDragMime)) ||
          (!!moving.id &&
            event.dataTransfer.types.includes(widgetMoveMime) &&
            canMove(state, moving.id, { widgetId: widget.id, tabId: widget.activeTabId }))
        }
        dropWidget={(event, tabId) => {
          event.preventDefault();
          event.stopPropagation();
          const container = { widgetId: widget.id, tabId };
          if (moving.id) dispatch({ type: "move", id: moving.id, container });
          else if (props.widgetDrag)
            dispatch({ type: "add", widgetType: props.widgetDrag, container });
          moving.setId(null);
        }}
      />
    ) : null;
  // These read the open groups directly, so a series toolbar and empty state do not apply.
  const selfContained = widget.type === "tf-tree" || widget.type === "source-info";
  const singleTarget = widgetSpecs[widget.type].maxSeries === 1;
  const hasViewControls = widget.type === "plot" || widget.type === "state";
  // Each widget type draws its own content; the frame, drop target and empty state are shared.
  const views: Record<Widget["type"], () => ReactNode> = {
    "tf-tree": () => <TfTree runId={props.runId ?? null} info={info} />,
    "source-info": () => <SourceInfo info={info} sources={props.sources} />,
    tabs: () =>
      widget.type === "tabs" ? (
        <>
          {widget.tabs.map((tab) => (
            <div
              key={tab.id}
              className="widget-tab-panel"
              role="tabpanel"
              id={`${widget.id}-${tab.id}-panel`}
              aria-labelledby={`${widget.id}-${tab.id}`}
              hidden={widget.activeTabId !== tab.id}
            >
              <WorkspaceLayout {...props} container={{ widgetId: widget.id, tabId: tab.id }} />
            </div>
          ))}
        </>
      ) : null,
    plot: () => (
      <Plot
        series={widgetSeries(widget, data)}
        fullEnd={fullEnd}
        originNs={info?.start_ns ?? null}
        revision={revision}
        mode={widget.mode}
        legend={widget.legend}
        view={widget.view}
        onViewChange={onViewChange}
        onCanReset={setCanReset}
        onToggleSeries={(key) =>
          dispatch({
            type: "series",
            id: widget.id,
            update: (list) =>
              list.map((item) => (item.key === key ? { ...item, hidden: !item.hidden } : item)),
          })
        }
      />
    ),
    state: () => (
      <StatePlot
        widget={widget}
        series={widgetSeries(widget, data)}
        fullEnd={fullEnd}
        originNs={info?.start_ns ?? null}
        onViewChange={onViewChange}
      />
    ),
    table: () => (
      <TableView
        dispatch={dispatch}
        widget={widget}
        record={props.messageRecords.find((r) => r.key === widget.series[0]?.key)}
        index={props.fieldIndex}
        originNs={info?.start_ns ?? null}
      />
    ),
    raw: () => <RawMessage widget={widget} info={info} index={props.fieldIndex} />,
    image: () => <ImageView widget={widget} info={info} index={props.fieldIndex} />,
    scene: () => (
      <Suspense fallback={null}>
        <Scene3D
          widget={widget}
          info={info}
          index={props.fieldIndex}
          onFixedFrame={(value) => dispatch({ type: "fixed-frame", id: widget.id, value })}
          resetCount={sceneResetCount}
        />
      </Suspense>
    ),
    map: () => (
      <Suspense fallback={null}>
        <MapView widget={widget} info={info} />
      </Suspense>
    ),
    "value-changes": () => (
      <ValueChangesView
        widget={widget}
        series={widgetSeries(widget, data)}
        originNs={info?.start_ns ?? null}
        revision={revision}
      />
    ),
  };
  return (
    <section
      className={lifted ? "widget-shell lifted" : "widget-shell"}
      aria-label={widget.title}
      data-widget-id={widget.id}
      onPointerDownCapture={() => dispatch({ type: "select", id: widget.id })}
      onFocusCapture={() => dispatch({ type: "select", id: widget.id })}
    >
      {canDrop && (
        <WidgetDropTarget
          frameOnly={widget.type === "tabs"}
          onDrop={(edge) => {
            if (moving.id) dispatch({ type: "move", id: moving.id, target: widget.id, edge });
            else if (props.widgetDrag) dispatch(addAt(props.widgetDrag, widget.id, edge));
            moving.setId(null);
          }}
        />
      )}
      <MosaicWindow<string>
        path={path}
        title={widget.title}
        draggable={false}
        renderToolbar={(windowProps) => (
          <div className={`widget-toolbar ${widget.type === "tabs" ? "widget-tabs-toolbar" : ""}`}>
            <div
              className="mosaic-window-title"
              draggable={!state.expandedId}
              aria-label={widget.type === "tabs" ? "Move Tabs widget" : undefined}
              title={widget.type === "tabs" ? "Move Tabs widget" : widget.title}
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.setData(widgetMoveMime, widget.id);
                event.dataTransfer.setData("text/plain", widget.title);
                event.dataTransfer.effectAllowed = "move";
                // The whole widget follows the pointer, held where it was grabbed.
                const frame = event.currentTarget.closest(".widget-shell")!;
                const { left, top } = frame.getBoundingClientRect();
                event.dataTransfer.setDragImage(frame, event.clientX - left, event.clientY - top);
                // The browser takes the image once this handler has returned.
                setTimeout(flattenMapsForDragImage(frame));
                moving.setId(widget.id);
                dispatch({ type: "select", id: widget.id });
              }}
              onDragEnd={() => moving.setId(null)}
            >
              {widget.type === "tabs" ? (
                <svg
                  width="12"
                  height="16"
                  viewBox="0 0 12 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="4" cy="4" r="1" />
                  <circle cx="8" cy="4" r="1" />
                  <circle cx="4" cy="8" r="1" />
                  <circle cx="8" cy="8" r="1" />
                  <circle cx="4" cy="12" r="1" />
                  <circle cx="8" cy="12" r="1" />
                </svg>
              ) : (
                widget.title
              )}
            </div>
            {tabBar}
            <div className="mosaic-window-controls">{windowProps.toolbarControls}</div>
          </div>
        )}
        className={state.activeId === widget.id ? "widget-active" : ""}
        onDragStart={() => dispatch({ type: "select", id: widget.id })}
        toolbarControls={
          <>
            {widget.type === "plot" && (
              <div className="widget-drag-mode" role="group" aria-label="Drag mode">
                <button
                  className="widget-icon"
                  aria-label="Pan"
                  title="Pan"
                  aria-pressed={widget.mode === "pan"}
                  onClick={() => dispatch({ type: "mode", id: widget.id, mode: "pan" })}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3" />
                  </svg>
                </button>
                <button
                  className="widget-icon"
                  aria-label="Box zoom"
                  title="Box zoom"
                  aria-pressed={widget.mode === "zoom"}
                  onClick={() => dispatch({ type: "mode", id: widget.id, mode: "zoom" })}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M12 9v6M9 12h6" />
                  </svg>
                </button>
              </div>
            )}
            {hasViewControls && (
              <>
                <button
                  className="widget-icon"
                  aria-label="Reset view"
                  title="Reset view"
                  disabled={
                    !info || !(widget.type === "state" ? !isDefaultView(widget.view.x) : canReset)
                  }
                  onClick={() => onViewChange(() => defaultPlotView())}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 4v6h6" />
                    <path d="M4.5 10a8 8 0 1 1-.5 4" />
                  </svg>
                </button>
                <span className="widget-toolbar-separator" role="separator" />
              </>
            )}
            {widgetSpecs[widget.type].controls && (
              <WidgetHelp title={widget.title} controls={widgetSpecs[widget.type].controls!} />
            )}
            <button
              className="widget-icon"
              aria-label={`${state.expandedId === widget.id ? "Restore" : "Maximize"} ${widget.title}`}
              title={state.expandedId === widget.id ? "Restore layout (Escape)" : "Maximize"}
              aria-pressed={state.expandedId === widget.id}
              onClick={() =>
                dispatch({
                  type: "expand",
                  id: state.expandedId === widget.id ? null : widget.id,
                })
              }
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path
                  d={
                    state.expandedId === widget.id
                      ? "M9 3v6H3m18 0h-6V3M3 15h6v6m6 0v-6h6"
                      : "M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6"
                  }
                />
              </svg>
            </button>
            <button
              className="widget-icon"
              aria-label={`${widget.title} settings`}
              title="Settings"
              onClick={() => {
                dispatch({ type: "select", id: widget.id });
                openSettings();
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="m10 3-.7 3-2 .9L4.5 6 2.5 9.5 5 11v2l-2.5 1.5L4.5 18l2.8-.9 2 .9.7 3h4l.7-3 2-.9 2.8.9 2-3.5L19 13v-2l2.5-1.5-2-3.5-2.8.9-2-.9L14 3Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button
              className="widget-icon"
              popoverTarget={menuId}
              aria-label={`${widget.title} menu`}
              title="Widget actions"
              style={{ anchorName: menuAnchor }}
            >
              ⋯
            </button>
            <div
              id={menuId}
              className="widget-actions"
              popover="auto"
              role="menu"
              aria-label={`${widget.title} actions`}
              style={{ positionAnchor: menuAnchor }}
              onToggle={(event) => {
                if (event.newState === "closed") {
                  clearTimeout(submenuTimer.current);
                  setChangingType(false);
                }
              }}
            >
              <button role="menuitem" onClick={() => action("row")}>
                Split right
              </button>
              <button role="menuitem" onClick={() => action("column")}>
                Split down
              </button>
              <div
                className={`submenu-host ${changingType ? "open" : ""}`}
                onMouseEnter={() => openSubmenu(true)}
                onMouseLeave={() => openSubmenu(false)}
              >
                <button
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={changingType}
                  style={{ anchorName: submenuAnchor }}
                  onClick={() => setChangingType(true)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight") setChangingType(true);
                  }}
                >
                  Change widget <span aria-hidden="true">›</span>
                </button>
                {changingType && (
                  <div
                    className="widget-actions submenu"
                    role="menu"
                    aria-label="Widget type"
                    style={{ positionAnchor: submenuAnchor }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft") setChangingType(false);
                    }}
                  >
                    {widgetTypes
                      .filter((type) => canPlaceWidget(type, owner))
                      .map((type) => {
                        const current = type === widget.type;
                        return (
                          <button
                            key={type}
                            role="menuitemradio"
                            aria-checked={current}
                            disabled={current}
                            onClick={() => {
                              closeMenu();
                              dispatch({ type: "change-type", id: widget.id, widgetType: type });
                            }}
                          >
                            {widgetSpecs[type].label}
                            <small>
                              {current ? "Current type" : widgetSpecs[type].description}
                            </small>
                          </button>
                        );
                      })}
                  </div>
                )}
              </div>
              <button
                role="menuitem"
                disabled={
                  widget.type === "tabs"
                    ? !widget.tabs.some((tab) => tab.layout !== null)
                    : !widget.series.length
                }
                onClick={() => action("clear")}
              >
                Clear
              </button>
              <button role="menuitem" className="danger" onClick={() => action("remove")}>
                Delete
              </button>
            </div>
          </>
        }
      >
        <div className={`widget-content ${widget.type === "tabs" ? "tab-widget-content" : ""}`}>
          {widget.type === "tabs" ? (
            views.tabs()
          ) : (
            <>
              {/* Widgets taking several topics name them in their own content. */}
              {singleTarget && (
                <div className="widget-plot-toolbar">
                  <span className="widget-selection" title={selection}>
                    {selection}
                  </span>
                </div>
              )}
              <div
                className={`chart-area ${verdict ? (verdict.ok ? "drop-ready" : "drop-rejected") : ""}`}
                onDragOver={(event) => {
                  // Leaving the default (no preventDefault) shows a not-allowed cursor.
                  if (!verdict?.ok || !event.dataTransfer.types.includes(dragMime)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(event) => drop(event, widget.id)}
                aria-label={`Drop target for ${widget.title}`}
              >
                {views[widget.type]()}
                {verdict && (
                  <div className={`drop-overlay ${verdict.ok ? "" : "rejected"}`}>
                    {verdict.ok
                      ? verdict.replaces
                        ? "Drop here to replace"
                        : "Drop here to add"
                      : verdict.reason}
                  </div>
                )}
                {!selfContained && !widget.series.length && !verdict && (
                  <div className="empty">
                    <p>
                      {info ? widgetSpecs[widget.type].emptyHint : "Open a run from the header"}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </MosaicWindow>
    </section>
  );
}

function WorkspaceLayout(props: Props & { container?: Container; expanded?: string | null }) {
  const { container, expanded, ...workspaceProps } = props;
  const { state, dispatch } = workspaceProps;
  const moving = useContext(MoveContext);
  const canDrop =
    (!!props.widgetDrag && canPlaceWidget(props.widgetDrag, container)) ||
    (!!moving.id && canMove(state, moving.id, container));
  const layout = containerLayout(state, container);
  return (
    <div className="mosaic-host">
      <Mosaic<string>
        value={expanded ?? (moving.liftedId ? withoutLifted(layout, moving.liftedId) : layout)}
        onChange={(layout) => dispatch({ type: "layout", layout, container })}
        className="hahn-mosaic"
        resize={{ minimumPaneSizePx: { row: 320, column: 260 } }}
        zeroStateView={
          <div
            className={`workspace-empty ${canDrop ? "drop-ready" : ""}`}
            onDragOver={(event) => {
              if (
                !canDrop ||
                ![widgetDragMime, widgetMoveMime].some((type) =>
                  event.dataTransfer.types.includes(type),
                )
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = moving.id ? "move" : "copy";
            }}
            onDrop={(event) => {
              if (!canDrop) return;
              event.preventDefault();
              event.stopPropagation();
              if (moving.id) dispatch({ type: "move", id: moving.id, container });
              else if (props.widgetDrag)
                dispatch({ type: "add", widgetType: props.widgetDrag, container });
              moving.setId(null);
            }}
          >
            <div className="empty-widget-catalog" aria-label="Widgets to add">
              <p>Add widget</p>
              <div className="empty-widget-options">
                {widgetTypes
                  .filter((type) => canPlaceWidget(type, container))
                  .map((type) => (
                    <button
                      key={type}
                      aria-label={`Add ${widgetSpecs[type].label}`}
                      aria-description={widgetSpecs[type].description}
                      onClick={() => dispatch({ type: "add", widgetType: type, container })}
                    >
                      <strong>{widgetSpecs[type].label}</strong>
                      <span>{widgetSpecs[type].description}</span>
                    </button>
                  ))}
              </div>
            </div>
          </div>
        }
        renderTile={(id, path) => (
          <WidgetWindow key={id} {...workspaceProps} widget={state.widgets[id]} path={path} />
        )}
      />
    </div>
  );
}

export function WidgetWorkspace(props: Props) {
  const { state, dispatch } = props;
  const [movingId, setMovingId] = useState<string | null>(null);
  const [liftedId, setLiftedId] = useState<string | null>(null);
  // Changing the layout during dragstart would cancel the drag, so wait until it has begun.
  useEffect(() => {
    if (!movingId) {
      setLiftedId(null);
      return;
    }
    const timer = setTimeout(() => setLiftedId(movingId));
    return () => clearTimeout(timer);
  }, [movingId]);
  useEffect(() => {
    if (!state.expandedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(":popover-open, dialog[open]"))
        dispatch({ type: "expand", id: null });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.expandedId, dispatch]);
  return (
    <MoveContext.Provider value={{ id: movingId, liftedId, setId: setMovingId }}>
      <div className="workspace-stage">
        <WorkspaceLayout {...props} expanded={state.expandedId} />
      </div>
    </MoveContext.Provider>
  );
}
