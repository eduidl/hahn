import "./WidgetWorkspace.css";
import {
  Suspense,
  createContext,
  lazy,
  useContext,
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type DragEvent,
  type ReactNode,
} from "react";
import { TabBar } from "./TabControls";
import { WidgetControls } from "./WidgetControls";
import { WidgetDropTarget } from "./WidgetDropTarget";
import { Mosaic, MosaicWindow, type MosaicPath } from "react-mosaic-component";
import { Plot, defaultPlotView, type PlotView, type Series } from "../views/Plot";
import { StatePlot } from "../views/StatePlot";
import type { DropVerdict } from "./drop";
import { ValueChangesView } from "../views/ValueChangesView";
import { TableView } from "../views/TableView";
import type { MessageRecord } from "../data/useMessages";
import type { FieldIndex } from "./fieldIndex";
import { RawMessage } from "../views/RawMessage";
import { TfTree } from "../views/TfTree";
import { SourceInfo } from "../views/SourceInfo";
import type { OpenSource } from "../data/sources";
import { ImageView } from "../views/ImageView";
import { widgetDragImage } from "./widgetDragImage";
import { flattenMapsForDragImage } from "../views/mapDragImage";
import { SourceNames } from "../data/sources";
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
  widgetDragMime,
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

/** Just enough to find the widget again. How small to make one is up to the user. */
const minimumWidgetPixels = 10;

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
  const [sceneResetCount, setSceneResetCount] = useState(0);
  const verdict = widget.type === "tabs" ? null : dragVerdict(widget);
  const onViewChange = useCallback(
    (update: (view: PlotView) => PlotView) => dispatch({ type: "view", id: widget.id, update }),
    [dispatch, widget.id],
  );
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
                // Maps first: their tiles beyond the view would count as overflow.
                const restoreMaps = flattenMapsForDragImage(frame);
                const { image, cleanup } = widgetDragImage(frame, widget.title);
                event.dataTransfer.setDragImage(image, event.clientX - left, event.clientY - top);
                // The browser takes the image once this handler has returned.
                setTimeout(() => {
                  restoreMaps();
                  cleanup();
                });
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
          <WidgetControls
            widget={widget}
            state={state}
            dispatch={dispatch}
            info={info}
            canReset={canReset}
            onResetView={() => onViewChange(() => defaultPlotView())}
            onResetScene={() => setSceneResetCount((count) => count + 1)}
            onOpenSettings={openSettings}
          />
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
        resize={{ minimumPaneSizePercentage: 0, minimumPaneSizePx: minimumWidgetPixels }}
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
