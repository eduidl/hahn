import { useEffect, useRef, useState } from "react";
import { appendPoints, consumeStream, point } from "./data";
import type { Series } from "./Plot";
import { errorMessage, type Info, type Selected } from "./types";

export type CachedSeries = Series & {
  topic: string;
  status: "loading" | "complete" | "stopped" | "error";
  received: number;
  error?: string;
};

/** A full-recording cache. Viewport changes never enter the loading lifecycle. */
export function useSeries(
  fileId: number | null,
  info: Info | null,
  selected: Selected[],
) {
  const cache = useRef(new Map<string, CachedSeries>());
  const requests = useRef(new Map<AbortController, CachedSeries[]>());
  const dirty = useRef(false);
  const [revision, setRevision] = useState(0);
  // Fields are rebuilt from this key, so it must carry everything decoding needs.
  const selectionKey = JSON.stringify(
    selected.map(({ key, topic, path, dataType, enumValues }) => ({
      key,
      topic,
      path,
      dataType,
      enumValues,
    })),
  );

  useEffect(() => {
    cache.current = new Map();
    dirty.current = true;
    return () => {
      for (const controller of requests.current.keys()) controller.abort();
      requests.current.clear();
    };
  }, [fileId, info]);

  useEffect(() => {
    if (fileId === null || !info) return;
    const fields = JSON.parse(selectionKey) as Selected[];
    const keys = new Set(fields.map((f) => f.key));
    for (const [controller, targets] of requests.current) {
      if (targets.every((t) => !keys.has(t.key))) {
        controller.abort();
        targets.forEach((t) => {
          t.status = "stopped";
        });
        requests.current.delete(controller);
        dirty.current = true;
      }
    }
    // Group quick field additions, without cancelling existing streams.
    const timer = setTimeout(() => {
      const groups = new Map<string, Selected[]>();
      for (const field of fields) {
        if (!cache.current.has(field.key))
          groups.set(field.topic, [...(groups.get(field.topic) ?? []), field]);
      }
      // Several widgets may request more than the API's 64-field batch limit.
      const batches = [...groups].flatMap(([topic, fields]) =>
        Array.from({ length: Math.ceil(fields.length / 64) }, (_, i) => ({
          topic,
          group: fields.slice(i * 64, (i + 1) * 64),
        })),
      );
      for (const { topic, group } of batches) {
        const controller = new AbortController();
        const targets = group.map((field) => {
          const target: CachedSeries = {
            key: field.key,
            topic,
            path: field.path,
            color: "",
            lineWidth: 1.5,
            hidden: false,
            points: [],
            dataType: field.dataType,
            enumValues: field.enumValues,
            status: "loading",
            received: 0,
          };
          cache.current.set(field.key, target);
          return target;
        });
        requests.current.set(controller, targets);
        dirty.current = true;
        fetch(`/api/files/${fileId}/series`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Always load all timestamps, including the final message.
          body: JSON.stringify({ topic, fields: group.map((f) => f.path) }),
          signal: controller.signal,
        })
          .then((response) =>
            consumeStream(response, (event) => {
              if (controller.signal.aborted) return;
              if (event.type === "batch") {
                targets.forEach((target, i) => {
                  target.points = appendPoints(
                    target.points,
                    event.rows.map((row) =>
                      point(row, i, info.start_ns, targets[i].enumValues),
                    ),
                  );
                  target.received = event.scanned_messages;
                });
              }
              if (event.type === "complete")
                targets.forEach((target) => {
                  target.status = "complete";
                  target.received = event.scanned_messages;
                });
              dirty.current = true;
            }),
          )
          .catch((error) => {
            if (!controller.signal.aborted) {
              targets.forEach((target) => {
                target.status = "error";
                target.error = errorMessage(error);
              });
              dirty.current = true;
            }
          })
          .finally(() => {
            requests.current.delete(controller);
          });
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [fileId, info, selectionKey]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (dirty.current) {
        dirty.current = false;
        setRevision((n) => n + 1);
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const records = selected
    .map((field) => cache.current.get(field.key))
    .filter((r): r is CachedSeries => !!r);
  const plotted = selected.flatMap((field) => {
    const data = cache.current.get(field.key);
    return data
      ? [
          {
            ...data,
            color: field.color,
            lineWidth: field.lineWidth,
            hidden: field.hidden,
          },
        ]
      : [];
  });
  const stop = () => {
    for (const [controller, targets] of requests.current) {
      controller.abort();
      targets.forEach((target) => {
        target.status = "stopped";
      });
    }
    requests.current.clear();
    dirty.current = true;
  };
  return {
    plotted,
    records,
    revision,
    stop,
    busy: records.some((r) => r.status === "loading"),
  };
}
