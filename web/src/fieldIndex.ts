import { displayType, fieldKind, keyOf, type Field, type Topic, type ValueKind } from "./types";
import { acceptsKind, widgetSpecs, widgetTypes, type Widget } from "./widgets";

export type IndexedField = {
  key: string;
  topic: Topic;
  field: Field;
  kind: ValueKind | null;
  /** `topic · path`, for searching. */
  label: string;
  typeLabel: string;
};
/**
 * Per-recording facts about every field, computed once when the topic list
 * loads. Only widget-dependent checks (current series) are left for later.
 */
export type FieldIndex = {
  topics: Map<string, Topic>;
  byKey: Map<string, IndexedField>;
  /** Fields each widget type can display at all, in topic list order. */
  candidates: Record<Widget["type"], IndexedField[]>;
};

export const typeLabel = (topic: Topic, field: Field) =>
  field.type_name
    ? displayType(field.type_name)
    : displayType(field.data_type, topic.schema_encoding);

export function buildFieldIndex(topics: Topic[]): FieldIndex {
  const byKey = new Map<string, IndexedField>();
  for (const topic of topics) {
    for (const field of topic.fields) {
      const key = keyOf(topic.topic, field.path);
      byKey.set(key, {
        key,
        topic,
        field,
        kind: fieldKind(field),
        label: `${topic.topic} · ${field.path.join(".")}`,
        typeLabel: typeLabel(topic, field),
      });
    }
  }
  const readable = [...byKey.values()].filter((entry) => !entry.topic.error);
  const candidates = Object.fromEntries(
    widgetTypes.map((type) => [
      type,
      readable.filter((entry) => acceptsKind(widgetSpecs[type], entry.kind)),
    ]),
  ) as FieldIndex["candidates"];
  return {
    topics: new Map(topics.map((topic) => [topic.topic, topic])),
    byKey,
    candidates,
  };
}
