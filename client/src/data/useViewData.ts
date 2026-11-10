import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePlayback, usePlaybackStore } from "../workspace/playback";
import { runUrl } from "./sources";
import { errorMessage, type Info, type Schemas, type Selected } from "../types";
import type { OnceState } from "./once";
import { useDataStore } from "./store";
import type { ResolvedFrames, ResolveOptions } from "./tfGraph";
import { lookaheadWindows, viewWindowNs, type ViewWindow } from "./viewCache";
import { frameIndexAt, type ViewFrame } from "./viewFrames";

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
export function useViewFrame(series: Selected | undefined, info: Info | null, batch = false) {
  const ns = usePlaybackNs(info);
  const playback = usePlaybackStore();
  const views = useDataStore().views;
  const token = useRef(Symbol("view-frame"));
  const previous = useRef<{ identity: string; frame: ViewFrame }>(undefined);
  const identity = series && info ? `${series.key}:${series.view}:${info.start_ns}` : null;
  const start = ns === null ? null : (ns / viewWindowNs) * viewWindowNs;
  const loaded = useLatestOnly<ViewWindow>(
    identity,
    start === null ? null : String(start),
    (key, _known, signal) => views.window(series!, BigInt(key), signal, batch),
  );
  useEffect(() => {
    if (series && identity && start !== null) return views.retain(series, start);
  }, [views, identity, start]);
  // Read ahead of the playback position, also while paused, so that playing goes on
  // into the next windows without waiting for them.
  const speed = usePlayback((s) => s.speed);
  const end = info ? BigInt(info.end_ns) : null;
  useEffect(() => {
    if (!series || !identity || start === null || end === null || end < start) return;
    const count = Math.min(lookaheadWindows(speed), Number((end - start) / viewWindowNs));
    return views.ahead(series, start, count, batch);
  }, [views, identity, start, end, speed, batch]);
  // A window read ahead is used at once, before the request for it answers.
  const window =
    loaded?.value?.start === start
      ? loaded.value
      : series && identity && start !== null
        ? views.peek(series, start)
        : undefined;
  const fallback = useLatestOnly<ViewFrame | null>(
    identity && (!window || window.tooLarge) ? `${identity}:${start}` : null,
    (!window || window.tooLarge) && ns !== null ? String(ns) : null,
    (key, known, signal) => views.latest(series!, key, known, signal),
  );
  const index = window?.frames && ns !== null ? frameIndexAt(window.frames, ns) : -1;
  const frame =
    !window || window.tooLarge
      ? fallback?.value
      : index >= 0
        ? window!.frames![index]
        : window?.seed;
  const error = loaded?.error ?? fallback?.error ?? "";
  const buffering = identity !== null && frame === undefined && !error;
  useEffect(() => {
    if (identity && frame) previous.current = { identity, frame };
  }, [identity, frame]);
  const displayed =
    frame === undefined &&
    identity &&
    ns !== null &&
    previous.current?.identity === identity &&
    BigInt(previous.current.frame.time_ns) <= ns
      ? previous.current.frame
      : frame;
  useEffect(() => {
    const current = token.current;
    playback.setBuffering(current, buffering);
    return () => playback.setBuffering(current, false);
  }, [playback, buffering]);
  return { frame: displayed, error };
}

/**
 * Holds every frame of a view in the store while the caller is shown, and gives how to
 * read them: once for all the widgets that show the view.
 */
export function useViewHistory(series: Pick<Selected, "source" | "topic" | "view">) {
  const views = useDataStore().views;
  const { source, topic, view } = series;
  useEffect(() => views.retainHistory({ source, topic, view }), [views, source, topic, view]);
  return useCallback(
    (signal: AbortSignal) => views.history({ source, topic, view }, signal),
    [views, source, topic, view],
  );
}

export type FrameInfo = Schemas["FrameInfo"];

const noSubscription = () => () => {};
const nothing: OnceState<FrameInfo[]> = { error: "", loading: false };
const noState = () => nothing;
const noFrames: FrameInfo[] = [];

/** The frames of the open run, read once for everyone who asks. None for another run. */
export function useRunFrames(runId: string | null) {
  const store = useDataStore();
  const resource = runId !== null && store.run === runId ? store.frames : undefined;
  const state = useSyncExternalStore(
    resource?.subscribe ?? noSubscription,
    resource?.getState ?? noState,
  );
  useEffect(() => resource?.load(), [resource]);
  return { frames: state.value ?? noFrames, error: state.error, loaded: state.value !== undefined };
}

/** The frames of the run of the given groups; none without groups. */
export function useFrames(sources: string[]) {
  const store = useDataStore();
  const shown = sources.some((source) => runUrl(source) === `/api/runs/${store.run}`);
  const { frames, error } = useRunFrames(shown ? store.run : null);
  return { frames, error };
}

/** What a 3D view renders in: the chosen frame, else the first root of the graph. */
export const fixedFrameOf = (chosen: string | null, frames: FrameInfo[]) =>
  chosen !== null && frames.some((f) => f.id === chosen)
    ? chosen
    : (frames.find((f) => f.parent === null)?.id ?? null);

const noVersion = () => 0;

/**
 * Transforms into `target` at `ns`, resolved here from the run's samples (ADR 0003).
 * While the samples around `ns` load, the last result stays, with its own `time_ns`.
 */
export function useTransforms(
  source: string | undefined,
  target: string | null,
  ns: string | null,
  /** Keeps a frame at its last known place once it is gone, as frames end at different times. */
  hold = false,
  options: ResolveOptions & {
    /**
     * The recording time whose samples to load, when `ns` is a measurement time: the
     * two clocks may differ entirely, as after replaying a recording.
     */
    near?: string | null;
  } = {},
) {
  const { axis = "time", interpolate = true } = options;
  const near = options.near ?? ns;
  const data = useDataStore();
  const store = source ? data.transforms(runUrl(source)) : undefined;
  const version = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getVersion ?? noVersion,
  );
  useEffect(() => {
    if (store && target && near !== null) void store.ensure(BigInt(near));
  }, [store, target, near]);
  const identity = store && target ? JSON.stringify([store.run, target, axis, interpolate]) : null;
  const current = useMemo(() => {
    if (!store || !target || ns === null || near === null || !store.covers(BigInt(near)))
      return undefined;
    const frames = store.graph().resolve(target, BigInt(ns), { axis, interpolate });
    return { time_ns: ns, target, frames };
  }, [store, target, ns, near, axis, interpolate, version]);
  const last = useRef<{ identity: string | null; value?: ResolvedFrames }>({ identity });
  if (last.current.identity !== identity) last.current = { identity };
  if (current) last.current.value = current;
  const value = current ?? last.current.value;
  const held = useRef<{ identity: string | null; frames: ResolvedFrames["frames"] }>({
    identity,
    frames: {},
  });
  const transforms = useMemo(() => {
    if (!hold || !value) return value;
    if (held.current.identity !== identity) held.current = { identity, frames: {} };
    held.current.frames = { ...held.current.frames, ...value.frames };
    return { ...value, frames: held.current.frames };
  }, [hold, identity, value]);
  return { transforms, error: store?.error() ?? "" };
}
