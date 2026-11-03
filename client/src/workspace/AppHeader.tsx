import "./AppHeader.css";
import { widgetDragMime, widgetSpecs, widgetTypes, type Widget } from "./widgets";
import { TimeDisplayToggle, TimeZoneSelect } from "./TimeZoneSelect";
import type { TimeDisplay, TimeZoneSource } from "../timeDisplay";
import type { Info, Run } from "../types";

type Group = { source: string; name: string };

export function AppHeader({
  run,
  groups,
  sources,
  info,
  timeDisplay,
  zoneSource,
  serverZone,
  sidebarOpen,
  onOpenRuns,
  onToggleSource,
  onAddWidget,
  onWidgetDrag,
  onTimeDisplay,
  onZoneSource,
  onToggleSidebar,
}: {
  run: Run | null;
  groups: Group[];
  sources: string[];
  info: Info | null;
  timeDisplay: TimeDisplay;
  zoneSource: TimeZoneSource;
  serverZone: string | null;
  sidebarOpen: boolean;
  onOpenRuns: () => void;
  onToggleSource: (id: string, open: boolean) => void;
  onAddWidget: (type: Widget["type"]) => void;
  onWidgetDrag: (type: Widget["type"] | null) => void;
  onTimeDisplay: (display: TimeDisplay) => void;
  onZoneSource: (source: TimeZoneSource) => void;
  onToggleSidebar: () => void;
}) {
  const addFromCatalog = (type: Widget["type"]) => {
    onAddWidget(type);
    document.getElementById("widget-catalog")?.hidePopover();
  };
  return (
    <header>
      <div className="header-start">
        <div className="brand">
          <img
            className="brand-mark"
            src={new URL("../assets/favicon.svg", import.meta.url).href}
            alt=""
          />
          hahn
        </div>
        <button
          type="button"
          className="runs-trigger"
          aria-label={run ? `Select run: ${run.name}` : undefined}
          title={run?.name}
          onClick={onOpenRuns}
        >
          {run ? (
            <>
              <span className="runs-trigger-name">{run.name}</span>
              <span>▾</span>
            </>
          ) : (
            "Select run"
          )}
        </button>
        {groups.length > 1 && (
          <button
            type="button"
            className="group-trigger"
            popoverTarget="group-menu"
            aria-label="Open groups"
            title="Open groups"
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v3" />
              <path d="M4 20h15l3-10H7L4 20 2 8h5" />
            </svg>
          </button>
        )}
      </div>
      <div
        id="group-menu"
        className="popover-surface group-menu"
        popover="auto"
        role="dialog"
        aria-label="Open groups"
      >
        <h2>Open groups</h2>
        <p className="help">Open groups are displayed on a shared timeline.</p>
        <div className="group-list">
          {groups.map((g) => (
            <label key={g.source} className="group-option">
              <input
                type="checkbox"
                checked={sources.includes(g.source)}
                onChange={(e) => onToggleSource(g.source, e.target.checked)}
              />
              <span className="group-name" title={g.name}>
                {g.name}
              </span>
            </label>
          ))}
        </div>
        <div className="file-detail">
          {sources.length
            ? `${sources.length} groups open · ${info?.message_count?.toLocaleString() ?? "—"} messages`
            : `${groups.length} groups`}
        </div>
      </div>

      <button
        type="button"
        className="sidebar-toggle"
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        aria-expanded={sidebarOpen}
        onClick={onToggleSidebar}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="4" width="18" height="20" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </button>
      <button
        type="button"
        className="add-widget"
        aria-label="Add widget"
        title="Add widget"
        popoverTarget="widget-catalog"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <path d="M17.5 14v7M14 17.5h7" />
        </svg>
      </button>
      <div
        id="widget-catalog"
        className="popover-surface widget-catalog"
        popover="auto"
        role="dialog"
        aria-label="Add widget"
      >
        <p className="help">Click to add on the left, or drag to a position.</p>
        {widgetTypes.map((type) => (
          // biome-ignore lint/a11y/useSemanticElements: Firefox does not drag a <button>.
          <div
            key={type}
            className="widget-catalog-item"
            role="button"
            tabIndex={0}
            draggable
            onClick={() => addFromCatalog(type)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              addFromCatalog(type);
            }}
            onDragStart={(event) => {
              event.dataTransfer.setData(widgetDragMime, type);
              // react-dnd (used by the mosaic) cancels drags without a native type.
              event.dataTransfer.setData("text/plain", widgetSpecs[type].label);
              event.dataTransfer.effectAllowed = "copy";
              onWidgetDrag(type);
              // The list would cover the drop targets. Hiding the source during
              // dragstart cancels the drag, so wait until it has begun.
              setTimeout(() => document.getElementById("widget-catalog")?.hidePopover());
            }}
            onDragEnd={() => onWidgetDrag(null)}
          >
            <strong>{widgetSpecs[type].label}</strong>
            <span>{widgetSpecs[type].description}</span>
          </div>
        ))}
      </div>
      <TimeDisplayToggle value={timeDisplay} onChange={onTimeDisplay} />
      <TimeZoneSelect
        source={zoneSource}
        serverZone={serverZone}
        atMs={info ? Number(BigInt(info.start_ns) / 1_000_000n) : undefined}
        onChange={onZoneSource}
      />
    </header>
  );
}
