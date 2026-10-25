import { useEffect, useRef, useState, type Dispatch, type DragEvent } from "react";
import { tabDragMime, widgetDragMime, widgetMoveMime, type TabWidget, type WorkspaceAction, type WidgetTab } from "./widgets";

const tabLabel = (tab: WidgetTab) => tab.title || "タブ名を入力";

type Props = { widget: TabWidget; dispatch: Dispatch<WorkspaceAction> };

export function TabName({ widget, tab, dispatch, autoFocus = false }: Props & { tab: WidgetTab; autoFocus?: boolean }) {
  const [title, setTitle] = useState(tab.title);
  useEffect(() => setTitle(tab.title), [tab.title]);
  const commit = () => {
    dispatch({ type: "tab-rename", id: widget.id, tabId: tab.id, title });
    setTitle(title.trim());
  };
  return <input className="tab-name-input" autoFocus={autoFocus} aria-label={`${tabLabel(tab)} の名前`} placeholder="タブ名を入力" value={title}
    onChange={(event) => setTitle(event.target.value)} onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") { setTitle(tab.title); }
    }} />;
}

export function TabSettings({ widget, dispatch }: Props) {
  return <div className="tab-settings">
    <p className="help">各タブに複数のウィジェットを配置できます。名前や順序を変更できます。</p>
    {widget.tabs.map((tab, i) => <div className="tab-settings-row" key={tab.id}>
      <button aria-label={`${tabLabel(tab)} を表示`} aria-pressed={widget.activeTabId === tab.id}
        onClick={() => dispatch({ type: "tab-select", id: widget.id, tabId: tab.id })}>{i + 1}</button>
      <TabName widget={widget} tab={tab} dispatch={dispatch} />
      <button aria-label={`${tabLabel(tab)} を前へ`} disabled={i === 0}
        onClick={() => dispatch({ type: "tab-reorder", id: widget.id, tabId: tab.id, beforeId: widget.tabs[i - 1].id })}>↑</button>
      <button aria-label={`${tabLabel(tab)} を後ろへ`} disabled={i === widget.tabs.length - 1}
        onClick={() => dispatch({ type: "tab-reorder", id: widget.id, tabId: widget.tabs[i + 1].id, beforeId: tab.id })}>↓</button>
      <button aria-label={`${tabLabel(tab)} を削除`} disabled={widget.tabs.length === 1}
        onClick={() => dispatch({ type: "tab-remove", id: widget.id, tabId: tab.id })}>×</button>
    </div>)}
    <button onClick={() => dispatch({ type: "tab-add", id: widget.id })}>＋ タブを追加</button>
  </div>;
}

export function TabBar({ widget, dispatch, acceptWidget, dropWidget }: Props & {
  acceptWidget: (event: DragEvent) => boolean;
  dropWidget: (event: DragEvent, tabId: string) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hovered = useRef<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const clear = () => { clearTimeout(timer.current); hovered.current = null; };
  useEffect(() => clear, []);
  const select = (tabId: string) => dispatch({ type: "tab-select", id: widget.id, tabId });
  const dropTab = (event: DragEvent, beforeId?: string, after = false) => {
    if (!event.dataTransfer.types.includes(tabDragMime)) return;
    event.preventDefault(); event.stopPropagation(); clear();
    try {
      const source = JSON.parse(event.dataTransfer.getData(tabDragMime));
      if (typeof source?.widgetId !== "string" || typeof source?.tabId !== "string") return;
      if (source.widgetId === widget.id) dispatch({ type: "tab-reorder", id: widget.id, tabId: source.tabId,
        beforeId: beforeId ?? widget.tabs[widget.tabs.length - 1].id, after: beforeId ? after : true });
      else dispatch({ type: "tab-move", id: source.widgetId, tabId: source.tabId, targetId: widget.id, beforeId, after });
    } catch { /* Ignore unrelated drag payloads. */ }
  };
  return <div className="widget-tab-bar" role="tablist" aria-label={`${widget.title} のタブ`}
    onDragOver={(event) => {
      if (!event.dataTransfer.types.includes(tabDragMime)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    }} onDrop={(event) => dropTab(event)}>
    {widget.tabs.map((tab, i) => <div className="widget-tab-item" data-active={widget.activeTabId === tab.id} key={tab.id}>
      {editing === tab.id ? <div onBlur={() => setEditing(null)}><TabName autoFocus widget={widget} tab={tab} dispatch={dispatch} /></div> :
        <button role="tab" id={`${widget.id}-${tab.id}`} aria-controls={`${widget.id}-${tab.id}-panel`}
          aria-selected={widget.activeTabId === tab.id} tabIndex={widget.activeTabId === tab.id ? 0 : -1}
          draggable onClick={() => select(tab.id)} onDoubleClick={() => setEditing(tab.id)}
          onKeyDown={(event) => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? widget.tabs.length - 1 :
              event.key === "ArrowRight" ? (i + 1) % widget.tabs.length : event.key === "ArrowLeft" ? (i + widget.tabs.length - 1) % widget.tabs.length : null;
            if (next === null) return;
            event.preventDefault(); select(widget.tabs[next].id);
            document.getElementById(`${widget.id}-${widget.tabs[next].id}`)?.focus();
          }}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.setData(tabDragMime, JSON.stringify({ widgetId: widget.id, tabId: tab.id }));
            event.dataTransfer.setData("text/plain", tabLabel(tab));
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={clear}
          onDragOver={(event) => {
            const widgetDrag = event.dataTransfer.types.includes(widgetMoveMime) || event.dataTransfer.types.includes(widgetDragMime);
            if (widgetDrag ? !acceptWidget(event) : !event.dataTransfer.types.includes(tabDragMime)) return;
            event.preventDefault(); event.stopPropagation();
            event.dataTransfer.dropEffect = event.dataTransfer.types.includes(widgetDragMime) ? "copy" : "move";
            if (widgetDrag && widget.activeTabId !== tab.id && hovered.current !== tab.id) {
              clear(); hovered.current = tab.id;
              timer.current = setTimeout(() => { select(tab.id); clear(); }, 500);
            }
          }} onDragLeave={clear}
          onDrop={(event) => {
            clear();
            if (event.dataTransfer.types.includes(tabDragMime)) {
              const rect = event.currentTarget.getBoundingClientRect();
              dropTab(event, tab.id, event.clientX > rect.left + rect.width / 2);
            } else if (acceptWidget(event)) dropWidget(event, tab.id);
          }}><span className={tab.title ? undefined : "tab-name-placeholder"}>{tabLabel(tab)}</span></button>}
      {widget.activeTabId === tab.id && <button className="widget-tab-close" aria-label={`${tabLabel(tab)} を閉じる`}
        disabled={widget.tabs.length === 1}
        onClick={() => dispatch({ type: "tab-remove", id: widget.id, tabId: tab.id })}>×</button>}
    </div>)}
    <button aria-label={`${widget.title} にタブを追加`} onClick={() => dispatch({ type: "tab-add", id: widget.id })}>＋</button>
  </div>;
}
