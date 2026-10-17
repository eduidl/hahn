import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldCache, type FieldTarget } from "./fieldCache";
import type { MessageRow } from "./table";
const root: FieldTarget = { source: 0, topic: "/t", path: [] };
const child = { ...root, path: ["pose", "x"] };
const rows: MessageRow[] = [
  { time_ns: "1000000000", value: { pose: { x: 1 }, text: "a" } },
  { time_ns: "1000000000", value: { pose: { x: 2 }, text: "b" } },
  { time_ns: "2000000000", value: { pose: null, text: "c" } },
];
const stream = (values = rows) => new Response(JSON.stringify({ type: "batch", rows: values, scanned_messages: values.length }) + "\n" + JSON.stringify({ type: "complete", scanned_messages: values.length }) + "\n");
afterEach(() => vi.unstubAllGlobals());
const load = (cache: FieldCache, target = root) => cache.load(target, new AbortController().signal, () => {});

