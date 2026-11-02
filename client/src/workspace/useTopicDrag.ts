import { useEffect, useRef, useState, type Dispatch, type DragEvent } from "react";
import { dropVerdict } from "./drop";
import type { FieldIndex } from "./fieldIndex";
import { addFieldAction, type Widget, type WorkspaceAction, type WorkspaceState } from "./widgets";
import { dragMime, parseDrop, type Topic, type TopicDrag } from "../types";

/** Moving topics and fields from the sidebar into widgets, by drag or from the keyboard. */
export function useTopicDrag(
  topics: Topic[],
  index: FieldIndex,
  workspace: WorkspaceState,
  dispatch: Dispatch<WorkspaceAction>,
) {
  const [drag, setDrag] = useState<TopicDrag | null>(null);
  const activeWidget = workspace.activeId ? workspace.widgets[workspace.activeId] : undefined;
  const startDrag = (event: DragEvent, payload: TopicDrag) => {
    event.stopPropagation();
    event.dataTransfer.setData(dragMime, JSON.stringify(payload));
    event.dataTransfer.setData(
      "text/plain",
      (topics.find((t) => t.source === payload.source && t.topic === payload.topic)?.topicName ??
        payload.topic) + (payload.path ? ` · ${payload.path.join(".")}` : ""),
    );
    event.dataTransfer.effectAllowed = "copy";
    setDrag(payload);
  };
  const drop = (event: DragEvent, widgetId = workspace.activeId) => {
    event.preventDefault();
    setDrag(null);
    const payload = parseDrop(event.dataTransfer.getData(dragMime), topics);
    const widget = widgetId ? workspace.widgets[widgetId] : undefined;
    if (!payload || !widget) return;
    event.stopPropagation();
    dispatch({ type: "select", id: widget.id });
    const verdict = dropVerdict(index, payload, widget);
    // Rejected drags never reach here: drop targets only accept fitting fields.
    if (verdict.ok)
      dispatch(addFieldAction(widget, verdict.entry.topic, verdict.entry.field, index));
  };
  /** Verdict for the in-progress drag, so widgets can show it before the drop. */
  const dragVerdict = (widget: Widget) => (drag ? dropVerdict(index, drag, widget) : null);
  const acceptDrag = (event: DragEvent) => {
    if (
      event.dataTransfer.types.includes(dragMime) &&
      activeWidget &&
      dragVerdict(activeWidget)?.ok
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };
  const [addStatus, setAddStatus] = useState("");
  const addStatusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(addStatusTimer.current), []);
  /** Adds without dragging; a drag would show the refusal on the widget, so show it here. */
  const addToSelected = (payload: TopicDrag) => {
    clearTimeout(addStatusTimer.current);
    const verdict = activeWidget
      ? dropVerdict(index, payload, activeWidget)
      : { ok: false as const, reason: "Add a widget first." };
    if (verdict.ok) {
      setAddStatus("");
      dispatch(addFieldAction(activeWidget!, verdict.entry.topic, verdict.entry.field, index));
      return;
    }
    setAddStatus(verdict.reason);
    addStatusTimer.current = setTimeout(() => setAddStatus(""), 5000);
  };
  return {
    startDrag,
    endDrag: () => setDrag(null),
    drop,
    dragVerdict,
    acceptDrag,
    addStatus,
    addToSelected,
  };
}
