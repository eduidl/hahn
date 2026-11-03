import type { components } from "./api.gen";

export type Schemas = components["schemas"];
export type RunList = Schemas["RunList"];
export type Run = Schemas["Run"];
export type Group = Schemas["Group"];
/** A group's summary, without a time range when the group has no messages. */
export type RecordingInfo = Schemas["RecordingInfo"];
/** A time axis to place values on: the open groups' messages together. */
export type Info = RecordingInfo & { start_ns: string; end_ns: string };
export type EnumValue = Schemas["EnumValue"];
/** A struct field as the UI browses it; see `flattenFields`. */
export type Field = Pick<Schemas["FieldType"], "data_type" | "type_name" | "enum_values"> & {
  path: string[];
};
const rosTypes: Record<string, string> = {
  // ROS has no bytes type; decoders map uint8[] to it.
  bytes: "uint8[]",
};
const protobufTypes: Record<string, string> = {
  float32: "float",
  float64: "double",
};
/** Type name in the schema's own language; decoder names for unknown encodings. */
export function displayType(type: string, encoding?: string | null): string {
  const names = encoding?.startsWith("ros")
    ? rosTypes
    : encoding === "protobuf"
      ? protobufTypes
      : {};
  return type
    .replace(/\b(string|wstring|bytes)\[<=\d+\]/g, "$1")
    .replace(/\[<=\d+\]/g, "[]")
    .replace(/\b\w+\b/g, (word) => names[word] ?? word);
}
export const isNumericField = (field: { data_type: string }): boolean =>
  /^(u?int(?:8|16|32|64)|float(?:32|64))$/.test(field.data_type);
export function enumDefinitionsMatch(a: EnumValue[] = [], b: EnumValue[] = []) {
  const canonical = (values: EnumValue[]) =>
    values
      .map(({ name, value }) => [name, value] as const)
      .sort((x, y) => Number(x[1]) - Number(y[1]) || x[0].localeCompare(y[0]));
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** Value domain of a series; a widget only overlays series of one domain. */
export type ValueKind =
  | { type: "numeric" }
  | { type: "bool" }
  | { type: "string" }
  | { type: "enum"; values: EnumValue[] }
  /** Structs, arrays, bytes, maps and JSON documents: only generic viewers show these. */
  | { type: "other" };
export function valueKind(
  dataType: string | undefined,
  enumValues?: EnumValue[],
): ValueKind | null {
  if (dataType === "bool") return { type: "bool" };
  if (dataType === "enum") return { type: "enum", values: enumValues ?? [] };
  if (dataType !== undefined && /^w?string(\[<=\d+\])?$/.test(dataType)) return { type: "string" };
  if (dataType === undefined) return null;
  return isNumericField({ data_type: dataType }) ? { type: "numeric" } : { type: "other" };
}
export const fieldKind = (field: Field) => valueKind(field.data_type, field.enum_values);
/** The first series fixes the kind; an empty widget is unconstrained (null). */
export const seriesKind = (series: Selected[]): ValueKind | null =>
  series.length ? valueKind(series[0].dataType, series[0].enumValues) : null;
export function kindsMatch(a: ValueKind | null, b: ValueKind | null) {
  if (a === null || b === null) return a === b;
  if (a.type !== b.type) return false;
  return a.type !== "enum" || enumDefinitionsMatch(a.values, (b as typeof a).values);
}
export const isDiscreteKind = (kind: ValueKind | null) => kind !== null && kind.type !== "numeric";
export type Topic = Omit<Schemas["Topic"], "fields" | "meta_fields" | "id"> & {
  id?: string;
  topicName?: string;
  /** Message fields, then meta fields under `metaPrefix`. */
  fields: Field[];
  /** The open group the topic belongs to (see `sourceOf`); added by the client. */
  source: string;
};
export type PointMarkers = "show" | "hide";
export type Selected = {
  key: string;
  source: string;
  topic: string;
  topicName?: string;
  path: string[];
  color: string;
  lineWidth: number;
  /** Whether a plot marks each sample; absent means automatic. */
  pointMarkers?: PointMarkers;
  hidden: boolean;
  dataType?: string;
  enumValues?: EnumValue[];
  /** Distance in meters of an image plane in a 3D view. */
  imageDistance?: number;
  /** How many seconds of pose history to show; absent means all history. */
  trailDuration?: number;
  /** The view of the topic to read, in widgets that show converted values. */
  view?: string;
};
/** The flat field list the UI browses; list elements are part of their list. */
export function flattenFields(fields: Schemas["Field"][], prefix: string[] = []): Field[] {
  return fields.flatMap(({ name, data_type, type_name, enum_values, fields: children }) => {
    const path = [...prefix, name];
    const field: Field = { path, data_type, type_name, enum_values };
    return [field, ...flattenFields(children ?? [], path)];
  });
}
/** Meta fields live beside the message, so their paths must not read as its fields. */
export const metaPrefix = "$meta";
export const isMetaPath = (path: string[]) => path[0] === metaPrefix;
export const metaFields = (fields: Schemas["Field"][]): Field[] =>
  flattenFields(fields, [metaPrefix]);
export const colors = ["#91b8ff", "#f3bf78", "#d69bf3", "#ed8e9f", "#7dd9e4", "#b8d88a"];
/** Topic names are only unique within one recording. */
export const topicKey = (source: string, topic: string) => JSON.stringify([source, topic]);
export const keyOf = (source: string, topic: string, path: string[]) =>
  JSON.stringify([source, topic, path]);
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export type TopicDrag = { source: string; topic: string; path?: string[] };
export const dragMime = "application/x-hahn-topic";

/** Only accept known sources; a browser drop is untrusted input. */
export function parseDrop(text: string, topics: Topic[]): TopicDrag | null {
  try {
    const payload = JSON.parse(text) as TopicDrag;
    const topic = topics.find((t) => t.source === payload.source && t.topic === payload.topic);
    if (!topic) return null;
    if (
      payload.path !== undefined &&
      (!Array.isArray(payload.path) ||
        !topic.fields.some((f) => JSON.stringify(f.path) === JSON.stringify(payload.path)))
    )
      return null;
    return { source: topic.source, topic: topic.topic, path: payload.path };
  } catch {
    return null;
  }
}
