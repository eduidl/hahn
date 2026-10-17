import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type Dispatch,
  type DragEvent,
  type ReactNode,
} from "react";
import { Mosaic, MosaicWindow, type MosaicPath } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { Plot, defaultPlotView, type PlotView, type Series } from "./Plot";
import { timeFormatter } from "./timeDisplay";
import type { DropVerdict } from "./drop";
import { stateLabel } from "./data";
import { LogView } from "./LogView";
import { TableView } from "./TableView";
import type { MessageRecord } from "./useMessages";
import type { FieldIndex } from "./fieldIndex";
import { RawMessage } from "./RawMessage";
import { SeriesName } from "./SeriesName";
import { usePlayback } from "./playback";
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

const stateColors = ["#168aad", "#f77f00", "#7b2cbf", "#2a9d8f", "#e63946", "#4361ee", "#bc6c25", "#d45087"];
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
function StatePlayhead({ fullEnd }: { fullEnd: number }) {
  const time = usePlayback((s) => s.time);
  const ratio = Math.max(0, Math.min(1, time / fullEnd));
  return <div className="playhead" style={{ left: `${ratio * 100}%`, top: 0, bottom: 0 }} />;
}

function StatePlot({ widget, series, fullEnd, originNs }: { widget: Widget; series: Series[]; fullEnd: number; originNs: string | null }) {
  const formatter = timeFormatter(originNs, widget.timeDisplay);
  const visible = series.filter((s) => !s.hidden);
  const segments = useMemo(
    () => new Map(visible.map((item) => [item.key, stateSegments(item, fullEnd)])),
    [visible, fullEnd],
  );
  return (
    <div className="state-plot" aria-label="状態遷移">
      {visible.map((s) => (
        <div className="state-row" key={s.key}>
          <div className="state-label">
            <SeriesName topic={s.topic} path={s.path} />
          </div>
          <div className="state-track">
            {(segments.get(s.key) ?? []).map((segment, i) => {
              const left = Math.max(0, Math.min(100, segment.start / fullEnd * 100));
              const right = Math.max(left, Math.min(100, segment.end / fullEnd * 100));
              return (
                <div
                  key={`${segment.ns}-${i}`}
                  className="state-segment"
                  style={{ left: `${left}%`, width: `${right - left}%`, backgroundColor: segment.color }}
                  title={`${formatter.tooltip(segment.start)} · ${segment.value === "" ? "空文字列" : segment.value}`}
                >
                  {segment.value === "" ? (
                    <span className="state-empty">（空文字列）</span>
                  ) : (
                    <span>{segment.value}</span>
                  )}
                </div>
              );
            })}
            <StatePlayhead fullEnd={fullEnd} />
          </div>
        </div>
      ))}
      <div className="state-axis"><span>{formatter.tick(0).time}</span><span>{formatter.tick(fullEnd / 2).time}</span><span>{formatter.tick(fullEnd).time}</span></div>
    </div>
  );
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
                            {current ? "現在の種類" : widgetSpecs[type].description}
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
            {views[widget.type]()}
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
                    ? widgetSpecs[widget.type].emptyHint
                    : "ヘッダーから録画を開いてください"}
                </p>
              </div>
            )}
          </div>
          </>}
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
