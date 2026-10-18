export type FileEntry = { id: number; name: string; size_bytes: number; format: string };
export type Info = {
  start_ns: string;
  end_ns: string;
  message_count: number | null;
};
export type EnumValue = { name: string; value: number };
export type Field = { path: string[]; data_type: string; type_name?: string; enum_values?: EnumValue[] };
const rosTypes: Record<string, string> = {
  i8: "int8", i16: "int16", i32: "int32", i64: "int64",
  u8: "uint8", u16: "uint16", u32: "uint32", u64: "uint64",
  f32: "float32", f64: "float64",
  // ROS has no bytes type; decoders map uint8[] to it.
  bytes: "uint8[]",
};
const protobufTypes: Record<string, string> = {
  i32: "int32", i64: "int64", u32: "uint32", u64: "uint64",
  f32: "float", f64: "double",
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
export const isNumericField = (field: Field): boolean =>
  /^(i8|i16|i32|i64|u8|u16|u32|u64|f32|f64)$/.test(field.data_type);
export const isStateField = (field: Field): boolean =>
  field.data_type === "bool" || field.data_type === "enum";
export function enumDefinitionsMatch(a: EnumValue[] = [], b: EnumValue[] = []) {
  const canonical = (values: EnumValue[]) =>
    values.map(({ name, value }) => [name, value] as const).sort((x, y) =>
      x[1] - y[1] || x[0].localeCompare(y[0]),
    );
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** Value domain of a series; a widget only overlays series of one domain. */
export type ValueKind =
  | { type: "numeric" }
  | { type: "bool" }
  | { type: "string" }
  | { type: "enum"; values: EnumValue[] }
  /** Structs, arrays, bytes and maps: only generic viewers show these. */
  | { type: "other" };
export function valueKind(
  dataType: string | undefined,
  enumValues?: EnumValue[],
): ValueKind | null {
  if (dataType === "bool") return { type: "bool" };
  if (dataType === "enum") return { type: "enum", values: enumValues ?? [] };
  if (dataType !== undefined && /^w?string(\[<=\d+\])?$/.test(dataType))
    return { type: "string" };
  if (dataType === undefined) return null;
  return isNumericField({ path: [], data_type: dataType })
    ? { type: "numeric" }
    : { type: "other" };
}
export const fieldKind = (field: Field) =>
  valueKind(field.data_type, field.enum_values);
/** The first series fixes the kind; an empty widget is unconstrained (null). */
export const seriesKind = (series: Selected[]): ValueKind | null =>
  series.length ? valueKind(series[0].dataType, series[0].enumValues) : null;
export function kindsMatch(a: ValueKind | null, b: ValueKind | null) {
  if (a === null || b === null) return a === b;
  if (a.type !== b.type) return false;
  return a.type !== "enum" || enumDefinitionsMatch(a.values, (b as typeof a).values);
}
export const isDiscreteKind = (kind: ValueKind | null) =>
  kind !== null && kind.type !== "numeric";
export type Topic = {
  /** The recording (file id) the topic belongs to; added by the client. */
  source: number;
  topic: string;
  schema_name: string | null;
  schema_encoding?: string | null;
  message_count: number | null;
  fields: Field[];
  error: string | null;
};
export type Selected = {
  key: string;
  source: number;
  topic: string;
  path: string[];
  color: string;
  lineWidth: number;
  hidden: boolean;
  dataType?: string;
  enumValues?: EnumValue[];
};
export const colors = [
  "#91b8ff",
  "#f3bf78",
  "#d69bf3",
  "#ed8e9f",
  "#7dd9e4",
  "#b8d88a",
];
/** Topic names are only unique within one recording. */
export const topicKey = (source: number, topic: string) =>
  JSON.stringify([source, topic]);
export const keyOf = (source: number, topic: string, path: string[]) =>
  JSON.stringify([source, topic, path]);
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export type TopicDrag = { source: number; topic: string; path?: string[] };
export const dragMime = "application/x-hahn-topic";

/** Only accept known sources; a browser drop is untrusted input. */
export function parseDrop(text: string, topics: Topic[]): TopicDrag | null {
  try {
    const payload = JSON.parse(text) as TopicDrag;
    const topic = topics.find(
      (t) => t.source === payload.source && t.topic === payload.topic,
    );
    if (!topic) return null;
    if (
      payload.path !== undefined &&
      (!Array.isArray(payload.path) ||
        !topic.fields.some(
          (f) => JSON.stringify(f.path) === JSON.stringify(payload.path),
        ))
    )
      return null;
    return { source: topic.source, topic: topic.topic, path: payload.path };
  } catch {
    return null;
  }
}
