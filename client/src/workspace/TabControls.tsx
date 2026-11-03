import "./TabControls.css";
import { useEffect, useRef, useState, type Dispatch, type DragEvent } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  leaves,
  tabDragMime,
  widgetDragMime,
  widgetMoveMime,
  type TabWidget,
  type WorkspaceAction,
  type WidgetTab,
} from "./widgets";

const tabLabel = (tab: WidgetTab) => tab.title || "Untitled tab";

type Props = { widget: TabWidget; dispatch: Dispatch<WorkspaceAction> };

export function TabName({
  widget,
  tab,
  dispatch,
  autoFocus = false,
}: Props & { tab: WidgetTab; autoFocus?: boolean }) {
  const [title, setTitle] = useState(tab.title);
  useEffect(() => setTitle(tab.title), [tab.title]);
  const commit = () => {
    dispatch({ type: "tab-rename", id: widget.id, tabId: tab.id, title });
    setTitle(title.trim());
  };
  return (
    <input
      className="text-input tab-name-input"
      // biome-ignore lint/a11y/noAutofocus: shown only when the user asks to rename the tab
      autoFocus={autoFocus}
      aria-label={`${tabLabel(tab)} name`}
      placeholder="Enter tab name"
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setTitle(tab.title);
        }
      }}
    />
  );
}

/** Removes a tab, asking first if that would also remove widgets. */
function RemoveTabButton({
  widget,
  tab,
  dispatch,
  label,
  className,
}: Props & { tab: WidgetTab; label: string; className?: string }) {
  const [confirming, setConfirming] = useState(false);
  const remove = () => dispatch({ type: "tab-remove", id: widget.id, tabId: tab.id });
  const count = leaves(tab.layout).length;
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={label}
        disabled={widget.tabs.length === 1}
        onClick={() => (count ? setConfirming(true) : remove())}
      >
        ×
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Delete tab "${tabLabel(tab)}"?`}
        message={`This removes ${count === 1 ? "1 widget in this tab and its series" : `${count} widgets in this tab and their series`}. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={remove}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

export function TabSettings({ widget, dispatch }: Props) {
  return (
    <div className="tab-settings">
      {widget.tabs.map((tab, i) => (
        <div className="tab-settings-row" key={tab.id}>
          <button
            type="button"
            className="small-button"
            aria-label={`Show ${tabLabel(tab)}`}
            aria-pressed={widget.activeTabId === tab.id}
            onClick={() => dispatch({ type: "tab-select", id: widget.id, tabId: tab.id })}
          >
            {i + 1}
          </button>
          <TabName widget={widget} tab={tab} dispatch={dispatch} />
          <button
            type="button"
            className="small-button"
            aria-label={`Move ${tabLabel(tab)} earlier`}
            disabled={i === 0}
            onClick={() =>
              dispatch({
                type: "tab-reorder",
                id: widget.id,
                tabId: tab.id,
                beforeId: widget.tabs[i - 1].id,
              })
            }
          >
            ↑
          </button>
          <button
            type="button"
            className="small-button"
            aria-label={`Move ${tabLabel(tab)} later`}
            disabled={i === widget.tabs.length - 1}
            onClick={() =>
              dispatch({
                type: "tab-reorder",
                id: widget.id,
                tabId: widget.tabs[i + 1].id,
                beforeId: tab.id,
              })
            }
          >
            ↓
          </button>
          <RemoveTabButton
            widget={widget}
            tab={tab}
            dispatch={dispatch}
            label={`Delete tab ${tabLabel(tab)}`}
            className="small-button"
          />
        </div>
      ))}
      <button
        type="button"
        aria-label="Add tab"
        onClick={() => dispatch({ type: "tab-add", id: widget.id })}
      >
        + Tab
      </button>
    </div>
  );
}

export function TabBar({
  widget,
  dispatch,
  acceptWidget,
  dropWidget,
}: Props & {
  acceptWidget: (event: DragEvent) => boolean;
  dropWidget: (event: DragEvent, tabId: string) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hovered = useRef<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const clear = () => {
    clearTimeout(timer.current);
    hovered.current = null;
  };
  useEffect(() => clear, []);
  const select = (tabId: string) => dispatch({ type: "tab-select", id: widget.id, tabId });
  const dropTab = (event: DragEvent, beforeId?: string, after = false) => {
    if (!event.dataTransfer.types.includes(tabDragMime)) return;
    event.preventDefault();
    event.stopPropagation();
    clear();
    try {
      const source = JSON.parse(event.dataTransfer.getData(tabDragMime));
      if (typeof source?.widgetId !== "string" || typeof source?.tabId !== "string") return;
      if (source.widgetId === widget.id)
        dispatch({
          type: "tab-reorder",
          id: widget.id,
          tabId: source.tabId,
          beforeId: beforeId ?? widget.tabs[widget.tabs.length - 1].id,
          after: beforeId ? after : true,
        });
      else
        dispatch({
          type: "tab-move",
          id: source.widgetId,
          tabId: source.tabId,
          targetId: widget.id,
          beforeId,
          after,
        });
    } catch {
      /* Ignore unrelated drag payloads. */
    }
  };
  return (
    <div
      className="widget-tab-bar"
      role="tablist"
      aria-label="Tabs"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(tabDragMime)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => dropTab(event)}
    >
      {widget.tabs.map((tab, i) => (
        <div className="widget-tab-item" data-active={widget.activeTabId === tab.id} key={tab.id}>
          {editing === tab.id ? (
            <div onBlur={() => setEditing(null)}>
              <TabName autoFocus widget={widget} tab={tab} dispatch={dispatch} />
            </div>
          ) : (
            <button
              type="button"
              role="tab"
              id={`${widget.id}-${tab.id}`}
              aria-controls={`${widget.id}-${tab.id}-panel`}
              aria-selected={widget.activeTabId === tab.id}
              tabIndex={widget.activeTabId === tab.id ? 0 : -1}
              draggable
              onClick={() => select(tab.id)}
              onDoubleClick={() => setEditing(tab.id)}
              onKeyDown={(event) => {
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? widget.tabs.length - 1
                      : event.key === "ArrowRight"
                        ? (i + 1) % widget.tabs.length
                        : event.key === "ArrowLeft"
                          ? (i + widget.tabs.length - 1) % widget.tabs.length
                          : null;
                if (next === null) return;
                event.preventDefault();
                select(widget.tabs[next].id);
                document.getElementById(`${widget.id}-${widget.tabs[next].id}`)?.focus();
              }}
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.setData(
                  tabDragMime,
                  JSON.stringify({ widgetId: widget.id, tabId: tab.id }),
                );
                event.dataTransfer.setData("text/plain", tabLabel(tab));
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={clear}
              onDragOver={(event) => {
                const widgetDrag =
                  event.dataTransfer.types.includes(widgetMoveMime) ||
                  event.dataTransfer.types.includes(widgetDragMime);
                if (
                  widgetDrag
                    ? !acceptWidget(event)
                    : !event.dataTransfer.types.includes(tabDragMime)
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = event.dataTransfer.types.includes(widgetDragMime)
                  ? "copy"
                  : "move";
                if (widgetDrag && widget.activeTabId !== tab.id && hovered.current !== tab.id) {
                  clear();
                  hovered.current = tab.id;
                  timer.current = setTimeout(() => {
                    select(tab.id);
                    clear();
                  }, 500);
                }
              }}
              onDragLeave={clear}
              onDrop={(event) => {
                clear();
                if (event.dataTransfer.types.includes(tabDragMime)) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  dropTab(event, tab.id, event.clientX > rect.left + rect.width / 2);
                } else if (acceptWidget(event)) dropWidget(event, tab.id);
              }}
            >
              <span className={tab.title ? undefined : "tab-name-placeholder"}>
                {tabLabel(tab)}
              </span>
            </button>
          )}
          {widget.activeTabId === tab.id && (
            <RemoveTabButton
              widget={widget}
              tab={tab}
              dispatch={dispatch}
              label={`Delete tab ${tabLabel(tab)}`}
              className="widget-tab-close"
            />
          )}
        </div>
      ))}
      <button
        type="button"
        aria-label="Add tab"
        onClick={() => dispatch({ type: "tab-add", id: widget.id })}
      >
        +
      </button>
    </div>
  );
}
