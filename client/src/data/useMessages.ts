import { useEffect, useRef, useState } from "react";
import { FieldCache, holdHistories } from "./fieldCache";
import { appendMessages, type MessageRow } from "../views/table";
import { errorMessage, type Selected } from "../types";
import type { Widget } from "../workspace/widgets";

export type MessageRecord = {
  key: string;
  source: string;
  topic: string;
  topicName?: string;
  rows: MessageRow[];
  status: "loading" | "complete" | "error";
  received: number;
  error?: string;
};

export function useMessages(
  origin: string | null,
  widgets: Record<string, Widget>,
  sharedCache?: FieldCache,
) {
  const [localCache] = useState(() => new FieldCache());
  const fields = sharedCache ?? localCache;
  const cache = useRef(new Map<string, MessageRecord>());
  const requests = useRef(new Map<string, AbortController>());
  const held = useRef(new Map<string, () => void>());
  const dirty = useRef(false);
  const [revision, setRevision] = useState(0);
  const selections = [
    ...new Map(
      Object.values(widgets)
        .filter((w) => w.type === "table")
        .flatMap((w) => w.series)
        .map((s) => [s.key, s]),
    ).values(),
  ].sort((a, b) => a.path.length - b.path.length);
  const selectionKey = JSON.stringify(
    selections.map(({ key, source, topic, topicName, path }) => ({
      key,
      source,
      topic,
      topicName,
      path,
    })),
  );

  useEffect(() => {
    cache.current.clear();
    if (!sharedCache) fields.clear();
    // A new origin comes with a new or cleared cache.
    held.current = new Map();
    dirty.current = true;
    return () => {
      for (const controller of requests.current.values()) controller.abort();
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
    holdHistories(fields, held.current, selected);
    if (origin === null) return;
    for (const s of selected) {
      if (cache.current.has(s.key)) continue;
      const record: MessageRecord = {
        key: s.key,
        source: s.source,
        topic: s.topic,
        topicName: s.topicName,
        rows: [],
        status: "loading",
        received: 0,
      };
      const controller = new AbortController();
      cache.current.set(s.key, record);
      requests.current.set(s.key, controller);
      dirty.current = true;
      fields
        .load(s, controller.signal, (event) => {
          if (controller.signal.aborted) return;
          if (event.type === "batch") {
            record.rows = appendMessages(record.rows, event.rows);
            record.received = event.scanned_messages;
          } else if (event.type === "complete") {
            record.status = "complete";
            record.received = event.scanned_messages;
          }
          dirty.current = true;
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            record.status = "error";
            record.error = errorMessage(error);
            dirty.current = true;
          }
        })
        .finally(() => {
          if (requests.current.get(s.key) === controller) requests.current.delete(s.key);
        });
    }
  }, [origin, selectionKey]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (dirty.current) {
        dirty.current = false;
        setRevision((n) => n + 1);
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const records = selections.flatMap((s) => {
    const record = cache.current.get(s.key);
    return record ? [record] : [];
  });
  return { records, revision, busy: records.some((r) => r.status === "loading") };
}
