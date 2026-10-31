import { useEffect, useRef, useState } from "react";
import type { FieldCache } from "./fieldCache";
import { appendPoints, consumeStream, point } from "./data";
import type { Series } from "../views/Plot";
import { messagesUrl } from "./sources";
import type { MessageRow } from "../views/table";
import { errorMessage, type Selected } from "../types";

export type CachedSeries = Series & {
  status: "loading" | "complete" | "stopped" | "error";
  received: number;
  error?: string;
};

/**
 * A full-recording cache. Viewport changes never enter the loading lifecycle.
 * Points are seconds from `origin`, the start of the open recordings, so only
 * a new origin invalidates them; opening another recording does not.
 */
export function useSeries(origin: string | null, selected: Selected[], sharedCache?: FieldCache) {
  const cache = useRef(new Map<string, CachedSeries>());
  const requests = useRef(new Map<AbortController, CachedSeries[]>());
  const dirty = useRef(false);
  const [revision, setRevision] = useState(0);
  // Fields are rebuilt from this key, so it must carry everything decoding needs.
  const selectionKey = JSON.stringify(
    selected.map(({ key, source, topic, path, dataType, enumValues }) => ({
      key,
      source,
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
  }, [origin]);

  useEffect(() => {
    if (origin === null) return;
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
    // Wait out quick field additions, without cancelling existing streams.
    const timer = setTimeout(() => {
      for (const field of fields) {
        if (!cache.current.has(field.key)) {
          const hit = sharedCache?.readScalar(field, field.dataType);
          if (hit) {
            cache.current.set(field.key, {
              ...field,
              points: hit.map((row) =>
                point(
                  { time_ns: row.time_ns, values: [row.value as number | string | boolean | null] },
                  0,
                  origin,
                  field.enumValues,
                ),
              ),
              status: "complete",
              received: hit.length,
            });
            dirty.current = true;
          } else if (sharedCache?.hasPendingScalar(field, field.dataType)) {
            const controller = new AbortController();
            const target: CachedSeries = { ...field, points: [], status: "loading", received: 0 };
            cache.current.set(field.key, target);
            requests.current.set(controller, [target]);
            dirty.current = true;
            sharedCache
              .load(field, controller.signal, (event) => {
                if (controller.signal.aborted) return;
                if (event.type === "batch")
                  target.points = appendPoints(
                    target.points,
                    event.rows.map((row) =>
                      point(
                        {
                          time_ns: row.time_ns,
                          values: [row.value as number | string | boolean | null],
                        },
                        0,
                        origin,
                        field.enumValues,
                      ),
                    ),
                  );
                if (event.type === "complete") target.status = "complete";
                if (event.type !== "error") target.received = event.scanned_messages;
                dirty.current = true;
              })
              .catch((error) => {
                if (!controller.signal.aborted) {
                  target.status = "error";
                  target.error = errorMessage(error);
                  dirty.current = true;
                }
              })
              .finally(() => requests.current.delete(controller));
          } else {
            const controller = new AbortController();
            const target: CachedSeries = {
              ...field,
              color: "",
              lineWidth: 1.5,
              hidden: false,
              points: [],
              status: "loading",
              received: 0,
            };
            cache.current.set(field.key, target);
            requests.current.set(controller, [target]);
            dirty.current = true;
            // Always load all timestamps, including the final message.
            fetch(messagesUrl(field, { exact: true }), { signal: controller.signal })
              .then((response) =>
                consumeStream<MessageRow>(response, (event) => {
                  if (controller.signal.aborted) return;
                  if (event.type === "batch") {
                    target.points = appendPoints(
                      target.points,
                      event.rows.map((row) =>
                        point(
                          {
                            time_ns: row.time_ns,
                            values: [row.value as number | string | boolean | null],
                          },
                          0,
                          origin,
                          field.enumValues,
                        ),
                      ),
                    );
                    target.received = event.scanned_messages;
                  }
                  if (event.type === "complete") {
                    target.status = "complete";
                    target.received = event.scanned_messages;
                    sharedCache?.putScalar(
                      target,
                      target.points.map((p) => ({ time_ns: p.ns, value: p.raw })),
                    );
                  }
                  dirty.current = true;
                }),
              )
              .catch((error) => {
                if (!controller.signal.aborted) {
                  target.status = "error";
                  target.error = errorMessage(error);
                  dirty.current = true;
                }
              })
              .finally(() => {
                requests.current.delete(controller);
              });
          }
        }
      }
    }, 120);
    return () => clearTimeout(timer);
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
