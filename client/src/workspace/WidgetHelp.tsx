import "./WidgetHelp.css";
import { useId, useRef } from "react";

/** A title bar button listing how to operate a widget, on hover, focus or tap. */
export function WidgetHelp({ title, controls }: { title: string; controls: readonly string[] }) {
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  // Hover and focus can both ask, so force the state rather than toggling it.
  const show = (open: boolean) => popover.current?.togglePopover(open);
  const anchor = `--help-${id.replace(/\W/g, "")}`;
  return (
    <>
      <button
        className="widget-icon widget-help"
        aria-label={`${title} controls`}
        aria-describedby={id}
        style={{ anchorName: anchor }}
        onPointerEnter={() => show(true)}
        onPointerLeave={(event) => {
          // A tap has no hover to end, so it stays open until focus leaves.
          if (event.pointerType === "mouse") show(false);
        }}
        onFocus={() => show(true)}
        onBlur={() => show(false)}
      >
        ?
      </button>
      <div
        id={id}
        ref={popover}
        className="popover-surface widget-help-list"
        popover="manual"
        role="tooltip"
        style={{ positionAnchor: anchor }}
      >
        {controls.map((control) => {
          const [input, action] = control.split(": ");
          return (
            <div key={control} className="widget-help-row">
              <kbd>{input}</kbd>
              <span>{action}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
