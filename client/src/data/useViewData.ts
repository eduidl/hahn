import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayback, usePlaybackStore } from "../workspace/playback";
import { get, runUrl } from "./sources";
import { errorMessage, type Info, type Schemas, type Selected } from "../types";
import { fetchLatestFrame, type ViewFrame } from "./viewFrames";

type Loaded<T> = { identity: string; value?: T; error?: string };

/**
 * Follows `key` with at most one request at a time, skipping keys passed meanwhile,
 * so a value that changes on every animation frame cannot queue up or starve.
 * The value stays until the next one arrives; `identity` starts over.
 */
export function useLatestOnly<T>(
  identity: string | null,
  key: string | null,
  load: (key: string, previous: T | undefined, signal: AbortSignal) => Promise<T>,
) {
  const [loaded, setLoaded] = useState<Loaded<T>>();
  const wanted = useRef(key);
  wanted.current = key;
  const loader = useRef(load);
  loader.current = load;
  const run = useRef<{
    controller: AbortController;
    busy: boolean;
    fetched: string | null;
    value?: T;
  }>(undefined);
  const kick = async () => {
    const current = run.current;
    if (!current || current.busy || identity === null) return;
    current.busy = true;
    while (
      wanted.current !== null &&
      wanted.current !== current.fetched &&
      !current.controller.signal.aborted
    ) {
      const next = wanted.current;
      current.fetched = next;
      try {
        current.value = await loader.current(next, current.value, current.controller.signal);
        if (!current.controller.signal.aborted) setLoaded({ identity, value: current.value });
      } catch (error) {
        if (!current.controller.signal.aborted) setLoaded({ identity, error: errorMessage(error) });
      }
    }
    current.busy = false;
  };
  useEffect(() => {
    if (identity === null) return;
    const controller = new AbortController();
    run.current = { controller, busy: false, fetched: null };
    void kick();
    return () => {
      controller.abort();
      run.current = undefined;
    };
  }, [identity]);
  useEffect(() => void kick(), [key]);
  return loaded?.identity === identity ? loaded : undefined;
}

/** The playback position in recording time, while a run is open. */
export function usePlaybackNs(info: Info | null) {
  const time = usePlayback((s) => s.time);
  return info ? BigInt(info.start_ns) + BigInt(Math.round(time * 1e9)) : null;
}

/** The view's frame at the playback position: undefined until known, null when none. */
export function useViewFrame(series: Selected | undefined, info: Info | null) {
  const ns = usePlaybackNs(info);
  const playback = usePlaybackStore();
  const token = useRef(Symbol("view-frame"));
  const identity = series && info ? `${series.key}:${series.view}:${info.start_ns}` : null;
  const loaded = useLatestOnly<ViewFrame | null>(
    identity,
    ns === null ? null : String(ns),
    (key, known, signal) => fetchLatestFrame(series!, key, known, signal),
  );
  const buffering = identity !== null && !loaded;
  useEffect(() => {
    const current = token.current;
    playback.setBuffering(current, buffering);
    return () => playback.setBuffering(current, false);
  }, [playback, buffering]);
  return { frame: loaded?.value, error: loaded?.error ?? "" };
}

export type FrameInfo = Schemas["FrameInfo"];

/** The frames of the runs of the given groups, without duplicates. */
export function useFrames(sources: string[]) {
  const key = JSON.stringify([...new Set(sources.map(runUrl))].sort());
  const [state, setState] = useState<{ key: string; frames: FrameInfo[]; error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    const list: string[] = JSON.parse(key);
    Promise.all(list.map((run) => get<Schemas["FrameList"]>(`${run}/frames`, controller.signal)))
      .then((lists) => {
        const byId = new Map(lists.flatMap((l) => l.frames).map((f) => [f.id, f]));
        setState({ key, frames: [...byId.values()], error: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ key, frames: [], error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [key]);
  const frames = useMemo(() => (state?.key === key ? state.frames : []), [state, key]);
  return { frames, error: state?.key === key ? state.error : "" };
}

/** What a 3D view renders in: the chosen frame, else the first root of the graph. */
export const fixedFrameOf = (chosen: string | null, frames: FrameInfo[]) =>
  chosen !== null && frames.some((f) => f.id === chosen)
    ? chosen
    : (frames.find((f) => f.parent === null)?.id ?? null);

/** Transforms into `target` at `ns`, following it like `useViewFrame`. */
export function useTransforms(
  source: string | undefined,
  target: string | null,
  ns: string | null,
  /** Keeps a frame at its last known place once it is gone, as frames end at different times. */
  hold = false,
) {
  const identity = source && target ? `${runUrl(source)}:${target}` : null;
  const loaded = useLatestOnly<Schemas["Transforms"]>(identity, ns, (key, _, signal) =>
    get(
      `${runUrl(source!)}/transforms?${new URLSearchParams({ target: target!, time_ns: key })}`,
      signal,
    ),
  );
  const held = useRef<{ identity: string | null; frames: Schemas["Transforms"]["frames"] }>({
    identity,
    frames: {},
  });
  const transforms = useMemo(() => {
    const value = loaded?.value;
    if (!hold || !value) return value;
    if (held.current.identity !== identity) held.current = { identity, frames: {} };
    held.current.frames = { ...held.current.frames, ...value.frames };
    return { ...value, frames: held.current.frames };
  }, [hold, identity, loaded?.value]);
  return { transforms, error: loaded?.error ?? "" };
}
