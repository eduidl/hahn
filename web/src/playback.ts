import { createContext, useContext, useSyncExternalStore } from "react";

/** Playback position in seconds from the recording start, like `Point.x`. */
export type PlaybackState = {
  time: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  end: number;
};

export const playbackSpeeds = [0.1, 0.25, 0.5, 1, 2, 5, 10];

const clamp = (time: number, end: number) =>
  Math.max(0, Math.min(end, Number.isFinite(time) ? time : 0));

/** Advance the playhead by wall-clock seconds; stops or wraps at the end. */
export function advance(state: PlaybackState, dt: number): PlaybackState {
  if (!state.playing) return state;
  const time = state.time + dt * state.speed;
  if (time < state.end) return { ...state, time };
  if (state.loop && state.end > 0)
    return { ...state, time: (time - state.end) % state.end };
  return { ...state, time: state.end, playing: false };
}

export type PlaybackStore = ReturnType<typeof createPlaybackStore>;

export function createPlaybackStore(
  frame: (callback: (now: number) => void) => number = (callback) =>
    requestAnimationFrame(callback),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id),
) {
  let state: PlaybackState = {
    time: 0,
    playing: false,
    speed: 1,
    loop: false,
    end: 0,
  };
  const listeners = new Set<() => void>();
  const waiting = new Set<symbol>();
  let request: number | null = null;
  let last: number | null = null;

  const tick = (now: number) => {
    request = null;
    if (last !== null && !waiting.size) set(advance(state, (now - last) / 1000));
    last = now;
    schedule();
  };
  const schedule = () => {
    if (state.playing && request === null) request = frame(tick);
    if (!state.playing) {
      if (request !== null) cancelFrame(request);
      request = null;
      last = null;
    }
  };
  const set = (next: PlaybackState) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const update = (patch: Partial<PlaybackState>) => {
    set({ ...state, ...patch });
    schedule();
  };

  const play = () => {
    if (state.end <= 0) return;
    // Replaying from the end restarts the recording, as media players do.
    update({ playing: true, time: state.time >= state.end ? 0 : state.time });
  };
  const pause = () => update({ playing: false });

  return {
    getState: () => state,
    isBuffering: () => waiting.size > 0,
    setBuffering: (consumer: symbol, active: boolean) => {
      const was = waiting.size > 0;
      if (active) waiting.add(consumer);
      else waiting.delete(consumer);
      if (was && !waiting.size) last = null;
      if (was !== (waiting.size > 0)) listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    play,
    pause,
    toggle: () => (state.playing ? pause() : play()),
    seek: (time: number) => update({ time: clamp(time, state.end) }),
    step: (dt: number) => update({ time: clamp(state.time + dt, state.end) }),
    setSpeed: (speed: number) => update({ speed }),
    setLoop: (loop: boolean) => update({ loop }),
    /** Rewind and stop for a new recording, keeping speed and loop preferences. */
    reset: (end: number) => update({ time: 0, playing: false, end }),
  };
}

export const PlaybackContext = createContext<PlaybackStore | null>(null);

export function usePlaybackStore(): PlaybackStore {
  const store = useContext(PlaybackContext);
  if (!store) throw new Error("PlaybackContext is missing");
  return store;
}

/** Subscribe to one slice so only the components that need it re-render per frame. */
export function usePlayback<T>(select: (state: PlaybackState) => T): T {
  const store = usePlaybackStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
