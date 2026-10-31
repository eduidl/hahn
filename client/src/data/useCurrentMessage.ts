import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FieldCache, useFieldCache } from "./fieldCache";
import { usePlayback, usePlaybackStore } from "../workspace/playback";
import { messageAt } from "../views/TableView";
import type { MessageRow } from "../views/table";
import { errorMessage, keyOf, type Info, type Selected } from "../types";

// Aligned windows let widgets and forward/backward seeks reuse the same requests.
const windowNs = 2_000_000_000n;
export function useCurrentMessage(series: Selected | undefined, info: Info | null) {
  const playback = usePlaybackStore();
  const consumer = useRef(Symbol("current-message"));
  const shared = useFieldCache();
  const [local] = useState(() => new FieldCache());
  const cache = shared ?? local;
  const time = usePlayback((s) => s.time);
  const revision = useSyncExternalStore(cache.subscribe, () => cache.revision);
  const ns = info ? BigInt(info.start_ns) + BigInt(Math.round(time * 1e9)) : 0n;
  const start = (ns / windowNs) * windowNs;
  const key = series ? keyOf(series.source, series.topic, series.path) : "";
  const identity = `${key}:${info?.start_ns}:${start}`;
  const [fallback, setFallback] = useState<{ identity: string; row: MessageRow | null }>();
  const [failure, setFailure] = useState<{ identity: string; error: string }>();
  const previous = useRef<{ key: string; row: MessageRow }>(undefined);
  const rows = useMemo(() => {
    if (!series || !info) return undefined;
    return cache.read(series, `${start}:${start + windowNs}`);
  }, [cache, revision, key, info?.start_ns, String(start)]);
  const index = rows ? messageAt(rows, ns) : -1;
  const previousStart = start - windowNs;
  const previousRows =
    series && start >= windowNs ? cache.read(series, `${previousStart}:${start}`) : undefined;
  const previousIdentity = `${key}:${info?.start_ns}:${previousStart}`;
  const predecessor =
    info && start <= BigInt(info.start_ns)
      ? null
      : previousRows
        ? (previousRows.at(-1) ??
          (fallback?.identity === previousIdentity
            ? fallback.row
            : info && previousStart <= BigInt(info.start_ns)
              ? null
              : undefined))
        : undefined;
  const seed = rows ? (fallback?.identity === identity ? fallback.row : predecessor) : undefined;
  const needsSeed =
    !!series && !!info && !!rows && index < 0 && seed === undefined && !cache.hasHistory(series);

  useEffect(() => {
    if (!series || !info) return;
    const controller = new AbortController();
    const release = cache.retain(series, `${start}:${start + windowNs}`);
    const load = async () => {
      if (cache.hasHistory(series)) return;
      // Complete the current window first, then prefetch two windows ahead.
      await cache.load(series, controller.signal, () => {}, {
        start_ns: String(start),
        end_ns: String(start + windowNs),
      });
      if (controller.signal.aborted) return;
      for (let i = 1n; i <= 2n; i++) {
        if (controller.signal.aborted || start + i * windowNs > BigInt(info.end_ns)) break;
        await cache.load(series, controller.signal, () => {}, {
          start_ns: String(start + i * windowNs),
          end_ns: String(start + (i + 1n) * windowNs),
        });
      }
    };
    load().catch((error) => {
      if (!controller.signal.aborted) setFailure({ identity, error: errorMessage(error) });
    });
    return () => {
      controller.abort();
      release();
    };
  }, [cache, identity]);
  useEffect(() => {
    if (!series || !needsSeed) return;
    let active = true;
    cache.seed(series, String(start)).then(
      (row) => {
        if (active) setFallback({ identity, row });
      },
      (error) => {
        if (active) setFailure({ identity, error: errorMessage(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [cache, identity, needsSeed]);
  useEffect(() => {
    if (rows && index < 0 && predecessor !== undefined && fallback?.identity !== identity) {
      setFallback({ identity, row: predecessor });
    }
  }, [identity, rows, index, predecessor, fallback?.identity]);
  useEffect(
    () => () => {
      if (!shared) local.clear();
    },
    [local, shared],
  );

  const message =
    index >= 0
      ? rows![index]
      : seed !== undefined
        ? seed
        : rows && series && cache.hasHistory(series)
          ? null
          : undefined;
  const error = failure?.identity === identity ? failure.error : "";
  const buffering = !!series && !!info && message === undefined && !error;
  const target = `${key}:${info?.start_ns}`;
  useEffect(() => {
    if (message) previous.current = { key: target, row: message };
  }, [message, target]);
  const displayed =
    message ??
    (series &&
    info &&
    previous.current?.key === target &&
    BigInt(previous.current.row.time_ns) <= ns
      ? previous.current.row
      : message);
  useEffect(() => {
    const token = consumer.current;
    playback.setBuffering(token, buffering);
    return () => playback.setBuffering(token, false);
  }, [playback, buffering]);
  return { message: displayed, error };
}
