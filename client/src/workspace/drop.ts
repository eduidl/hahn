import type { FieldIndex, IndexedField } from "./fieldIndex";
import {
  displayType,
  keyOf,
  kindsMatch,
  seriesKind,
  topicKey,
  type TopicDrag,
  type ValueKind,
} from "../types";
import {
  acceptsField,
  maxFieldsPerTopic,
  selectedViewKind,
  viewFor,
  widgetSpecs,
  type Widget,
  type WidgetSpec,
} from "./widgets";

export type DropVerdict =
  | { ok: true; entry: IndexedField; replaces: boolean }
  | { ok: false; reason: string };

const kindLabel = (kind: ValueKind["type"] | undefined) =>
  kind === "numeric" ? "numeric" : (kind ?? "Unsupported");

function mismatchReason(current: ValueKind | null, added: ValueKind | null) {
  if (current?.type === "enum" && added?.type === "enum")
    return "Enums with different definitions cannot be combined.";
  return `Only ${kindLabel(current?.type)} fields can be added.`;
}

/** Checks that depend on the widget's current series; null when the field fits. */
function widgetReason(entry: IndexedField, widget: Widget, spec: WidgetSpec, index: FieldIndex) {
  if (widget.series.some((s) => s.key === entry.key)) return "Already added";
  if (
    widget.type === "image" &&
    viewFor(spec, entry.topic)?.kind !== "image" &&
    !widget.series.some((item) => selectedViewKind(index, item) === "image")
  )
    return "Select an image topic first.";
  // A single-series widget replaces its series, so nothing else constrains it.
  if (spec.maxSeries === 1) return null;
  const current = seriesKind(widget.series);
  if (spec.sameKind && current !== null && !kindsMatch(current, entry.kind))
    return mismatchReason(current, entry.kind);
  if (widget.series.length >= spec.maxSeries)
    return `A maximum of ${spec.maxSeries} series is allowed.`;
  const { source, topic } = entry.topic;
  if (
    widget.series.filter((s) => s.source === source && s.topic === topic).length >=
    maxFieldsPerTopic
  )
    return `A maximum of ${maxFieldsPerTopic} fields per topic is allowed.`;
  return null;
}

/**
 * Whether a dragged topic or field can be added to a widget. Used while
 * dragging, to mark each widget, and on drop. Reasons are shown on the widget
 * during the drag, so they omit the topic and field names.
 */
export function dropVerdict(
  index: FieldIndex,
  drag: TopicDrag,
  widget: Widget,
  spec: WidgetSpec = widgetSpecs[widget.type],
): DropVerdict {
  const topic = index.topics.get(topicKey(drag.source, drag.topic));
  if (!topic) return { ok: false, reason: "Topic not found" };
  if (topic.error) return { ok: false, reason: "This topic cannot be read." };
  if (topic.message_count === 0) return { ok: false, reason: "No messages" };
  if (!spec.accepts.size && !spec.viewKinds?.size)
    return { ok: false, reason: "This widget does not take topics." };
  const accepted = [...spec.accepts].map(kindLabel).join(", ");
  // A dragged topic stands for its root message (empty path).
  const entry = index.byKey.get(keyOf(drag.source, drag.topic, drag.path ?? []));
  if (!entry) return { ok: false, reason: "Field not found" };
  if (spec.viewKinds && !acceptsField(spec, topic, entry.field.path, entry.kind))
    return {
      ok: false,
      reason: entry.field.path.length
        ? "Select a topic rather than a field."
        : `${topic.schema_name ?? "This type"} cannot be displayed.`,
    };
  if (!spec.viewKinds && !acceptsField(spec, topic, entry.field.path, entry.kind))
    return {
      ok: false,
      // The primitive name (`struct`, `uint32`, ...) keeps the reason short.
      reason: `${displayType(entry.field.data_type, topic.schema_encoding)} is not supported. This widget accepts ${accepted} fields.`,
    };
  const reason = widgetReason(entry, widget, spec, index);
  if (reason) return { ok: false, reason };
  return {
    ok: true,
    entry,
    replaces:
      (spec.maxSeries === 1 && widget.series.length > 0) ||
      (widget.type === "image" &&
        viewFor(spec, entry.topic)?.kind === "image" &&
        widget.series.some((item) => selectedViewKind(index, item) === "image")),
  };
}

/** The widget's cached candidates: those it can take right now, and why it cannot take the rest. */
export function pickableFields(index: FieldIndex, widget: Widget) {
  const addable: IndexedField[] = [];
  const unavailable: { entry: IndexedField; reason: string }[] = [];
  for (const entry of index.candidates[widget.type]) {
    const reason = widgetReason(entry, widget, widgetSpecs[widget.type], index);
    if (reason === null) addable.push(entry);
    else unavailable.push({ entry, reason });
  }
  return { addable, unavailable };
}

/** Fields that can be added to the widget right now, from the cached candidates. */
export const addableFields = (index: FieldIndex, widget: Widget): IndexedField[] =>
  pickableFields(index, widget).addable;
