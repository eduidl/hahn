import { useState, type DragEvent } from "react";
import { dropEdge, widgetDragMime, widgetMoveMime, type DropEdge } from "./widgets";

export function WidgetDropTarget({
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
