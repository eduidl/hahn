import type { FieldIndex, IndexedField } from "./fieldIndex";
import {
  displayType,
  keyOf,
  kindsMatch,
  seriesKind,
  topicKey,
  type TopicDrag,
  type ValueKind,
} from "./types";
import {
  acceptsKind,
  maxFieldsPerTopic,
  widgetSpecs,
  type Widget,
  type WidgetSpec,
} from "./widgets";

export type DropVerdict =
  | { ok: true; entry: IndexedField; replaces: boolean }
  | { ok: false; reason: string };

const kindLabel = (kind: ValueKind["type"] | undefined) =>
  kind === "numeric" ? "数値" : (kind ?? "未対応");

function mismatchReason(current: ValueKind | null, added: ValueKind | null) {
  if (current?.type === "enum" && added?.type === "enum")
    return "定義の異なる enum は重ねられません。";
  return `${kindLabel(current?.type)} の系列に ${kindLabel(added?.type)} は重ねられません。`;
}

/** Checks that depend on the widget's current series; null when the field fits. */
function widgetReason(entry: IndexedField, widget: Widget, spec: WidgetSpec) {
  if (widget.series.some((s) => s.key === entry.key)) return "追加済みです。";
  // A single-series widget replaces its series, so nothing else constrains it.
  if (spec.maxSeries === 1) return null;
  const current = seriesKind(widget.series);
  if (spec.sameKind && current !== null && !kindsMatch(current, entry.kind))
    return mismatchReason(current, entry.kind);
  if (widget.series.length >= spec.maxSeries) return `${spec.maxSeries}系列までです。`;
  const { source, topic } = entry.topic;
  if (
    widget.series.filter((s) => s.source === source && s.topic === topic).length >=
    maxFieldsPerTopic
  )
    return `1トピック${maxFieldsPerTopic}フィールドまでです。`;
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
  if (!topic) return { ok: false, reason: "トピックが見つかりません。" };
  if (topic.error) return { ok: false, reason: "読み込めないトピックです。" };
  if (topic.message_count === 0) return { ok: false, reason: "メッセージがありません。" };
  const accepted = [...spec.accepts].map(kindLabel).join("・");
  // A dragged topic stands for its root message (empty path).
  const entry = index.byKey.get(keyOf(drag.source, drag.topic, drag.path ?? []));
  if (!entry) return { ok: false, reason: "フィールドが見つかりません。" };
  if (!acceptsKind(spec, entry.kind))
    return {
      ok: false,
      // The primitive name (`struct`, `uint32`, ...) keeps the reason short.
      reason: `${displayType(entry.field.data_type, topic.schema_encoding)} は扱えません。${accepted} を指定してください。`,
    };
  const reason = widgetReason(entry, widget, spec);
  if (reason) return { ok: false, reason };
  return { ok: true, entry, replaces: spec.maxSeries === 1 && widget.series.length > 0 };
}

/** Fields that can be added to the widget right now, from the cached candidates. */
export const addableFields = (index: FieldIndex, widget: Widget): IndexedField[] =>
  index.candidates[widget.type].filter(
    (entry) => widgetReason(entry, widget, widgetSpecs[widget.type]) === null,
  );
