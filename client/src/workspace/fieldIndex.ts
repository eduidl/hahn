import {
  displayType,
  fieldKind,
  keyOf,
  topicKey,
  type Field,
  type Topic,
  type ValueKind,
} from "../types";
import { acceptsField, widgetSpecs, widgetTypes, type Widget } from "./widgets";

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
  /** By `topicKey`. */
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
    // The topic itself is its root message, a struct with an empty path.
    const root: Field = {
      path: [],
      data_type: "struct",
      type_name: topic.schema_name ?? undefined,
    };
    for (const field of [root, ...topic.fields]) {
      const key = keyOf(topic.source, topic.topic, field.path);
      byKey.set(key, {
        key,
        topic,
        field,
        kind: fieldKind(field),
        label: field.path.length ? `${topic.topic} · ${field.path.join(".")}` : topic.topic,
        typeLabel: typeLabel(topic, field),
      });
    }
  }
  // Unreadable or empty topics have nothing to show in any widget.
  const readable = [...byKey.values()].filter(
    (entry) => !entry.topic.error && entry.topic.message_count !== 0,
  );
  const candidates = Object.fromEntries(
    widgetTypes.map((type) => [
      type,
      readable.filter((entry) =>
        acceptsField(widgetSpecs[type], entry.topic, entry.field.path, entry.kind),
      ),
    ]),
  ) as FieldIndex["candidates"];
  return {
    topics: new Map(topics.map((topic) => [topicKey(topic.source, topic.topic), topic])),
    byKey,
    candidates,
  };
}
