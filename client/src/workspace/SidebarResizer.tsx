import "./SidebarResizer.css";
import type { KeyboardEvent, PointerEvent } from "react";

export const minSidebarWidth = 200;
export const maxSidebarWidth = 600;
/** The workspace keeps at least this much next to the sidebar. */
const minMainWidth = 320;
const keyStep = 20;

export function clampSidebarWidth(width: number, available: number) {
  const max = Math.min(maxSidebarWidth, available - minMainWidth);
  return Math.round(Math.max(minSidebarWidth, Math.min(max, width)));
}

/** The sidebar's right edge. Sits inside the sidebar, whose position it measures from. */
export function SidebarResizer({ onResize }: { onResize: (width: number) => void }) {
  const resize = (element: Element, width: number) => {
    const available = element.closest(".workspace")!.getBoundingClientRect().width;
    onResize(clampSidebarWidth(width, available));
  };
  const onPointerMove = (event: PointerEvent<HTMLHRElement>) => {
    const handle = event.currentTarget;
    if (!handle.hasPointerCapture(event.pointerId)) return;
    resize(handle, event.clientX - handle.parentElement!.getBoundingClientRect().left);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLHRElement>) => {
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    const handle = event.currentTarget;
    resize(handle, handle.parentElement!.getBoundingClientRect().width + direction * keyStep);
  };
  return (
    <hr
      className="sidebar-resizer"
      aria-label="Resize sidebar"
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); // Keeps the drag from selecting text.
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
    />
  );
}
