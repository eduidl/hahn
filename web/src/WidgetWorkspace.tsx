import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type Dispatch,
  type DragEvent,
} from "react";
import { Mosaic, MosaicWindow, type MosaicPath } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { Plot, defaultPlotView, type PlotView, type Series } from "./Plot";
import { timeFormatter } from "./timeDisplay";
import type { DropVerdict } from "./drop";
import { SeriesName } from "./SeriesName";
import { dragMime, type Info } from "./types";
import {
  addAt,
  compatibleSeries,
  widgetSpecs,
  widgetTypes,
  dropEdge,
  widgetDragMime,
  type DropEdge,
  type Widget,
  type WorkspaceAction,
  type WorkspaceState,
} from "./widgets";

type Props = {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  data: Series[];
  info: Info | null;
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

function WidgetDropTarget({ onDrop }: { onDrop: (edge: DropEdge) => void }) {
  const [edge, setEdge] = useState<DropEdge | null>(null);
  const edgeAt = (event: DragEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return dropEdge(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
    );
  };
  return (
    <div
      className="widget-drop"
      aria-label="ウィジェットの配置先"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(widgetDragMime)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setEdge(edgeAt(event));
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(widgetDragMime)) return;
        event.preventDefault();
        event.stopPropagation();
        onDrop(edgeAt(event));
        setEdge(null);
      }}
    >
      {edge && <div className={`widget-drop-preview ${edge}`} />}
    </div>
  );
}

function TimeSeriesWindow({
  widget,
  path,
  ...props
}: Props & { widget: Widget; path: MosaicPath }) {
  const {
    state,
    dispatch,
    data,
    info,
    fullEnd,
    revision,
    dragVerdict,
    drop,
    openSettings,
  } = props;
  const [canReset, setCanReset] = useState(false);
  const verdict = dragVerdict(widget);
  const onViewChange = useCallback(
    (update: (view: PlotView) => PlotView) =>
      dispatch({ type: "view", id: widget.id, update }),
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
  return (
    <section
      className="widget-shell"
      aria-label={widget.title}
      data-widget-id={widget.id}
      onPointerDownCapture={() => dispatch({ type: "select", id: widget.id })}
      onFocusCapture={() => dispatch({ type: "select", id: widget.id })}
    >
      {props.widgetDrag && (
        <WidgetDropTarget
          onDrop={(edge) => dispatch(addAt(props.widgetDrag!, widget.id, edge))}
        />
      )}
      <MosaicWindow<string>
        path={path}
        title={widget.title}
        draggable={!state.expandedId}
        className={state.activeId === widget.id ? "widget-active" : ""}
        onDragStart={() => dispatch({ type: "select", id: widget.id })}
        toolbarControls={
          <>
            <button
              className="widget-icon"
              aria-label={`${widget.title} ${state.expandedId === widget.id ? "を元の配置に戻す" : "を最大化"}`}
              title={
                state.expandedId === widget.id
                  ? "元の配置に戻す（Escape）"
                  : "最大化"
              }
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
              aria-label={`${widget.title} の設定`}
              title="パネル設定"
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
              aria-label={`${widget.title} のメニュー`}
              title="ウィジェットの操作"
              style={{ anchorName: menuAnchor }}
            >
              ⋯
            </button>
            <div
              id={menuId}
              className="widget-actions"
              popover="auto"
              role="menu"
              aria-label={`${widget.title} の操作`}
              style={{ positionAnchor: menuAnchor }}
              onToggle={(event) => {
                if (event.newState === "closed") {
                  clearTimeout(submenuTimer.current);
                  setChangingType(false);
                }
              }}
            >
              <button role="menuitem" onClick={() => action("row")}>
                左右に分割
              </button>
              <button role="menuitem" onClick={() => action("column")}>
                上下に分割
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
                  ウィジェットを変更 <span aria-hidden="true">›</span>
                </button>
                {changingType && (
                  <div
                    className="widget-actions submenu"
                    role="menu"
                    aria-label="ウィジェットの種類"
                    style={{ positionAnchor: submenuAnchor }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft") setChangingType(false);
                    }}
                  >
                    {widgetTypes.map((type) => {
                      const current = type === widget.type;
                      const removed =
                        widget.series.length -
                        compatibleSeries(type, widget.series).length;
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
                            {current
                              ? "現在の種類"
                              : removed > 0
                                ? `表示できない ${removed} 系列を外します`
                                : widgetSpecs[type].description}
                          </small>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                role="menuitem"
                disabled={!widget.series.length}
                onClick={() => action("clear")}
              >
                クリア
              </button>
              <button
                role="menuitem"
                className="danger"
                onClick={() => action("remove")}
              >
                削除
              </button>
            </div>
          </>
        }
      >
        <div className="widget-content">
          <div className="widget-plot-toolbar">
            <span>{widget.series.length} 系列</span>
            <div className="toolbar">
              {widget.type === "time-series" && <div className="drag-mode" role="group" aria-label="ドラッグ操作">
                <button
                  aria-pressed={widget.mode === "pan"}
                  onClick={() =>
                    dispatch({ type: "mode", id: widget.id, mode: "pan" })
                  }
                >
                  パン
                </button>
                <button
                  aria-pressed={widget.mode === "zoom"}
                  onClick={() =>
                    dispatch({ type: "mode", id: widget.id, mode: "zoom" })
                  }
                >
                  範囲ズーム
                </button>
              </div>}
              {widget.type === "time-series" && <button
                disabled={!info || !canReset}
                onClick={() => onViewChange(() => defaultPlotView())}
              >
                リセット
              </button>}
            </div>
          </div>
          <div
            className={`chart-area ${verdict ? (verdict.ok ? "drop-ready" : "drop-rejected") : ""}`}
            onDragOver={(event) => {
              // Leaving the default (no preventDefault) shows a not-allowed cursor.
              if (!verdict?.ok || !event.dataTransfer.types.includes(dragMime)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => drop(event, widget.id)}
            aria-label={`${widget.title} へのドロップ領域`}
          >
            {widget.type === "time-series" ? <Plot
              series={widgetSeries(widget, data)}
              fullEnd={fullEnd}
              originNs={info?.start_ns ?? null}
              timeDisplay={widget.timeDisplay}
              revision={revision}
              mode={widget.mode}
              view={widget.view}
              onViewChange={onViewChange}
              onCanReset={setCanReset}
            /> : <StatePlot widget={widget} series={widgetSeries(widget, data)} fullEnd={fullEnd} originNs={info?.start_ns ?? null} />}
            {verdict && (
              <div className={`drop-overlay ${verdict.ok ? "" : "rejected"}`}>
                {verdict.ok
                  ? verdict.replaces
                    ? "ここにドロップして置き換え"
                    : "ここにドロップして追加"
                  : verdict.reason}
              </div>
            )}
            {!widget.series.length && !verdict && (
              <div className="empty">
                <p>
                  {info
                    ? widget.type === "state" ? "bool / enum フィールドをドロップ" : "数値・bool・enum フィールドをドロップ"
                    : "ヘッダーから録画を開いてください"}
                </p>
              </div>
            )}
          </div>
        </div>
      </MosaicWindow>
    </section>
  );
}

export function WidgetWorkspace(props: Props) {
  const { state, dispatch } = props;
  const displayedLayout = state.expandedId ?? state.layout;
  useEffect(() => {
    if (!state.expandedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(":popover-open"))
        dispatch({ type: "expand", id: null });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.expandedId, dispatch]);
  return (
    <div className="workspace-stage">
      <div className="mosaic-host">
        <Mosaic<string>
          value={displayedLayout}
          onChange={(layout) => dispatch({ type: "layout", layout })}
          className="hahn-mosaic"
          dropBehavior="split"
          resize={{ minimumPaneSizePx: { row: 320, column: 260 } }}
          zeroStateView={
            <div
              className={`workspace-empty ${props.widgetDrag ? "drop-ready" : ""}`}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(widgetDragMime)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(event) => {
                if (!props.widgetDrag) return;
                event.preventDefault();
                dispatch({ type: "add", widgetType: props.widgetDrag });
              }}
            >
              <p>ウィジェットがありません</p>
              <p>「ウィジェットを追加」からここへドラッグしてください。</p>
            </div>
          }
          renderTile={(id, path) => (
            <TimeSeriesWindow
              key={id}
              {...props}
              widget={state.widgets[id]}
              path={path}
            />
          )}
        />
      </div>
    </div>
  );
}
