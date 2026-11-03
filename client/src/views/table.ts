import type { FieldIndex } from "../workspace/fieldIndex";
import { isMetaPath, topicKey, type EnumValue, type Schemas, type Selected } from "../types";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** The schema leaves `value` as any JSON; a recursive schema cannot be generated. */
export type MessageRow = Omit<Schemas["MessageResponse"], "value"> & { value: Json };
export type TableColumn = {
  label: string;
  path: string[];
  dataType?: string;
  enumValues?: EnumValue[];
};

const minColumnWidth = 64;
const maxColumnWidth = 2000;
export const clampColumnWidth = (width: number) =>
  Math.max(minColumnWidth, Math.min(maxColumnWidth, Math.round(width)));

/** Compact type-based defaults; explicit user widths take precedence. */
export function defaultColumnWidth(column: Pick<TableColumn, "dataType" | "enumValues">): number {
  switch (column.dataType) {
    case "bool":
      return 72;
    case "int8":
    case "uint8":
      return 80;
    case "int16":
    case "uint16":
      return 88;
    case "int32":
    case "uint32":
    case "float32":
      return 104;
    case "int64":
    case "uint64":
      return 160;
    case "float64":
      return 136;
    case "enum": {
      const length = (column.enumValues ?? []).reduce(
        (max, entry) => Math.max(max, entry.name.length),
        0,
      );
      return Math.max(96, Math.min(160, length * 7 + 36));
    }
    default:
      if (/^w?string(\[<=\d+\])?$/.test(column.dataType ?? "")) return 160;
      return 180;
  }
}

/** Schema paths, rather than a sample message, keep missing fields as stable columns. */
export function tableColumns(index: FieldIndex, selected: Selected): TableColumn[] {
  const root = index.byKey.get(selected.key)?.field;
  if (root?.data_type !== "struct")
    return [
      {
        label: "Value",
        path: [],
        dataType: root?.data_type ?? selected.dataType,
        enumValues: root?.enum_values ?? selected.enumValues,
      },
    ];
  const fields = index.topics.get(topicKey(selected.source, selected.topic))?.fields ?? [];
  return fields
    .filter(
      (field) =>
        field.data_type !== "struct" &&
        !isMetaPath(field.path) &&
        field.path.length > selected.path.length &&
        selected.path.every((part, i) => field.path[i] === part),
    )
    .map((field) => ({
      label: field.path.slice(selected.path.length).join("."),
      path: field.path.slice(selected.path.length),
      dataType: field.data_type,
      enumValues: field.enum_values,
    }));
}

export function cellValue(value: Json, column: TableColumn): string {
  let cell: Json | undefined = value;
  for (const part of column.path) {
    if (cell === null || typeof cell !== "object" || Array.isArray(cell)) return "—";
    cell = Object.hasOwn(cell, part) ? cell[part] : undefined;
  }
  if (cell == null) return "—";
  if (cell === "") return "(empty string)";
  if (typeof cell === "object") return JSON.stringify(cell);
  return column.enumValues?.find((entry) => entry.value === String(cell))?.name ?? String(cell);
}

/** Exact nanosecond order and stable ties, even across successive batches. */
export function appendMessages(current: MessageRow[], incoming: MessageRow[]): MessageRow[] {
  const compare = (a: MessageRow, b: MessageRow) => {
    const x = BigInt(a.time_ns),
      y = BigInt(b.time_ns);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  incoming.sort(compare);
  if (
    !current.length ||
    !incoming.length ||
    compare(current[current.length - 1], incoming[0]) <= 0
  ) {
    for (const row of incoming) current.push(row);
    return current;
  }
  const merged: MessageRow[] = [];
  let a = 0,
    b = 0;
  while (a < current.length && b < incoming.length)
    merged.push(compare(current[a], incoming[b]) <= 0 ? current[a++] : incoming[b++]);
  return merged.concat(current.slice(a), incoming.slice(b));
}
