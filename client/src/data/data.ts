import type { EnumValue, Schemas } from "../types";

export type Row = { time_ns: string; values: (number | string | boolean | null)[] };
type MessagesEvent = Schemas["MessagesEvent"];
/** The schema's events, generic over the row type the reader decodes them into. */
export type StreamEvent<T = Row> =
  | Exclude<MessagesEvent, { type: "batch" }>
  | (Omit<Extract<MessagesEvent, { type: "batch" }>, "rows"> & { rows: T[] });
export type Point = {
  x: number;
  y: number | null;
  raw: number | string | boolean | null;
  ns: string;
};
/** A discrete value as text: enum variant names, `true`/`false`, strings as is. */
export function stateLabel(raw: number | string | boolean | null, enumValues?: EnumValue[]) {
  if (typeof raw === "boolean") return raw ? "true" : "false";
  return enumValues?.find((entry) => entry.value === String(raw))?.name ?? String(raw);
}
export const secondsFrom = (ns: string, origin: string) =>
  Number(BigInt(ns) - BigInt(origin)) / 1e9;

export function point(
  row: Row,
  field: number,
  origin: string,
  enumValues: EnumValue[] = [],
): Point {
  const raw = row.values[field];
  const enumValue =
    typeof raw === "string"
      ? Number(enumValues.find((entry) => entry.name === raw)?.value ?? raw)
      : NaN;
  const n =
    raw === null ? NaN : typeof raw === "string" && enumValues.length ? enumValue : Number(raw);
  return {
    x: secondsFrom(row.time_ns, origin),
    y: Number.isFinite(n) ? n : null,
    raw,
    ns: row.time_ns,
  };
}

export function lowerBound(points: Point[], x: number): number {
  let lo = 0,
    hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function nearest(points: Point[], x: number): Point | undefined {
  const i = lowerBound(points, x);
  if (i === 0) return points[0];
  if (i === points.length) return points[i - 1];
  return x - points[i - 1].x < points[i].x - x ? points[i - 1] : points[i];
}

/** Keep file-order ties stable without repeatedly sorting the entire recording. */
export function appendPoints(current: Point[], incoming: Point[]): Point[] {
  incoming.sort((a, b) => a.x - b.x);
  if (!current.length || !incoming.length || incoming[0].x >= current[current.length - 1].x) {
    for (const p of incoming) current.push(p);
    return current;
  }
  const merged: Point[] = [];
  let a = 0,
    b = 0;
  while (a < current.length && b < incoming.length)
    merged.push(current[a].x <= incoming[b].x ? current[a++] : incoming[b++]);
  while (a < current.length) merged.push(current[a++]);
  while (b < incoming.length) merged.push(incoming[b++]);
  return merged;
}

export async function consumeStream<T = Row>(
  response: Response,
  onEvent: (event: StreamEvent<T>) => void,
) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "",
    complete = false;
  const accept = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as StreamEvent<T>;
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "complete") complete = true;
    onEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        accept(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (done) break;
    }
    accept(pending);
    if (!complete) throw new Error("Stream ended before completion");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
