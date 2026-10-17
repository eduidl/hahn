import { useEffect, useRef, useState } from "react";
import { FieldCache } from "./fieldCache";
import { appendMessages, type MessageRow } from "./table";
import { errorMessage, type Selected } from "./types";
import type { Widget } from "./widgets";

export type MessageRecord = {
  key: string;
  source: number;
  topic: string;
  rows: MessageRow[];
  status: "loading" | "complete" | "stopped" | "error";
  received: number;
  error?: string;
};

export function useMessages(origin: string | null, widgets: Record<string, Widget>, sharedCache?: FieldCache) {
  const [localCache] = useState(() => new FieldCache());
  const fields = sharedCache ?? localCache;
  const cache = useRef(new Map<string, MessageRecord>());
  const requests = useRef(new Map<string, AbortController>());
  const dirty = useRef(false);
  const [revision, setRevision] = useState(0);
  const selections = [...new Map(Object.values(widgets).filter((w) => w.type === "table")
    .flatMap((w) => w.series).map((s) => [s.key, s])).values()].sort((a, b) => a.path.length - b.path.length);
  const selectionKey = JSON.stringify(selections.map(({ key, source, topic, path }) => ({ key, source, topic, path })));

  useEffect(() => {
    cache.current.clear();
    if (!sharedCache) fields.clear();
    dirty.current = true;
    return () => {
      requests.current.forEach((controller) => controller.abort());
      requests.current.clear();
    };
  }, [origin]);

  useEffect(() => {
    const selected = JSON.parse(selectionKey) as Selected[];
    const keys = new Set(selected.map((s) => s.key));
    for (const [key, controller] of requests.current) {
      if (!keys.has(key)) {
        controller.abort();
        requests.current.delete(key);
      }
    }
    // Histories are larger than scalar series; release them when no widget uses them.
    for (const key of cache.current.keys()) if (!keys.has(key)) cache.current.delete(key);
    if (origin === null) return;
    for (const s of selected) {
      if (cache.current.has(s.key)) continue;
      const record: MessageRecord = { key: s.key, source: s.source, topic: s.topic, rows: [], status: "loading", received: 0 };
      const controller = new AbortController();
      cache.current.set(s.key, record);
      requests.current.set(s.key, controller);
      dirty.current = true;
      fields.load(s, controller.signal, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "batch") {
          record.rows = appendMessages(record.rows, event.rows);
          record.received = event.scanned_messages;
        } else if (event.type === "complete") {
          record.status = "complete";
          record.received = event.scanned_messages;
        }
        dirty.current = true;
      }).catch((error) => {
        if (!controller.signal.aborted) {
          record.status = "error";
          record.error = errorMessage(error);
          dirty.current = true;
        }
      }).finally(() => {
        if (requests.current.get(s.key) === controller) requests.current.delete(s.key);
      });
    }
  }, [origin, selectionKey]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (dirty.current) { dirty.current = false; setRevision((n) => n + 1); }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const records = selections.flatMap((s) => {
    const record = cache.current.get(s.key);
    return record ? [record] : [];
  });
  const stop = () => {
    for (const [key, controller] of requests.current) {
      controller.abort();
      const record = cache.current.get(key);
      if (record) record.status = "stopped";
    }
    requests.current.clear();
    dirty.current = true;
  };
  return { records, revision, stop, busy: records.some((r) => r.status === "loading") };
}
