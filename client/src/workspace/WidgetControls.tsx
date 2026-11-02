import { useEffect, useRef, useState, type Dispatch } from "react";
import { WidgetHelp } from "./WidgetHelp";
import {
  canPlaceWidget,
  ownerOf,
  widgetSpecs,
  widgetTypes,
  type Widget,
  type WorkspaceAction,
  type WorkspaceState,
} from "./widgets";
import { isDefaultView } from "../views/axes";
import type { Info } from "../types";

/** The buttons and the actions menu in a widget's title bar. */
export function WidgetControls({
  widget,
  state,
  dispatch,
  info,
  canReset,
  onResetView,
  onResetScene,
  onOpenSettings,
}: {
  widget: Widget;
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  info: Info | null;
  canReset: boolean;
  onResetView: () => void;
  onResetScene: () => void;
  onOpenSettings: () => void;
}) {
  const owner = ownerOf(state, widget.id);
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
  const hasViewControls = widget.type === "plot" || widget.type === "state";
  return (
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
      {(hasViewControls || widget.type === "scene") && (
        <>
          <button
            className="widget-icon"
            aria-label="Reset view"
            title="Reset view"
            disabled={
              widget.type !== "scene" &&
              (!info || !(widget.type === "state" ? !isDefaultView(widget.view.x) : canReset))
            }
            onClick={() => (widget.type === "scene" ? onResetScene() : onResetView())}
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
          onOpenSettings();
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
        className="popover-surface widget-actions"
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
              className="popover-surface widget-actions submenu"
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
                      <small>{current ? "Current type" : widgetSpecs[type].description}</small>
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
  );
}
