import { describe, expect, it } from "vitest";
import { advance, createPlaybackStore, type PlaybackState } from "../src/workspace/playback";

const state = (patch: Partial<PlaybackState> = {}): PlaybackState => ({
  time: 0,
  playing: true,
  speed: 1,
  loop: false,
  end: 10,
  ...patch,
});

/** Store driven by manual frames instead of requestAnimationFrame. */
function manualStore() {
  let pending: ((now: number) => void) | null = null;
  const store = createPlaybackStore(
    (callback) => {
      pending = callback;
      return 1;
    },
    () => {
      pending = null;
    },
  );
  const frame = (now: number) => {
    const callback = pending;
    pending = null;
    callback?.(now);
  };
  return { store, frame, scheduled: () => pending !== null };
}

describe("advance", () => {
  it("moves by wall-clock time scaled by speed", () => {
    expect(advance(state({ time: 1 }), 0.5).time).toBe(1.5);
    expect(advance(state({ time: 1, speed: 2 }), 0.5).time).toBe(2);
  });

  it("does nothing while paused", () => {
    const paused = state({ playing: false, time: 3 });
    expect(advance(paused, 1)).toBe(paused);
  });

  it("stops at the end without loop", () => {
    expect(advance(state({ time: 9.5 }), 1)).toMatchObject({
      time: 10,
      playing: false,
    });
  });

  it("wraps to the start with loop, carrying the overshoot", () => {
    const next = advance(state({ time: 9.5, loop: true }), 1);
    expect(next.playing).toBe(true);
    expect(next.time).toBeCloseTo(0.5);
  });
});

describe("createPlaybackStore", () => {
  it("advances on animation frames only while playing", () => {
    const { store, frame, scheduled } = manualStore();
    store.reset(10);
    store.play();
    frame(1000);
    frame(1500);
    expect(store.getState().time).toBeCloseTo(0.5);
    store.pause();
    expect(scheduled()).toBe(false);
    store.play();
    // The pause must not count toward elapsed time.
    frame(9000);
    frame(9100);
    expect(store.getState().time).toBeCloseTo(0.6);
  });

  it("restarts from the beginning when played at the end", () => {
    const { store } = manualStore();
    store.reset(10);
    store.seek(10);
    store.play();
    expect(store.getState()).toMatchObject({ time: 0, playing: true });
  });

  it("clamps seek and step to the recording", () => {
    const { store } = manualStore();
    store.reset(10);
    store.seek(20);
    expect(store.getState().time).toBe(10);
    store.step(-30);
    expect(store.getState().time).toBe(0);
    store.seek(Number.NaN);
    expect(store.getState().time).toBe(0);
  });

  it("does not play without a recording", () => {
    const { store, scheduled } = manualStore();
    store.play();
    expect(store.getState().playing).toBe(false);
    expect(scheduled()).toBe(false);
  });

  it("waits for every buffering consumer without adding the waiting time", () => {
    const { store, frame } = manualStore();
    const first = Symbol(),
      second = Symbol();
    store.reset(10);
    store.play();
    frame(1000);
    store.setBuffering(first, true);
    store.setBuffering(second, true);
    frame(2000);
    expect(store.getState().time).toBe(0);
    store.setBuffering(first, false);
    frame(3000);
    expect(store.getState().time).toBe(0);
    store.setBuffering(second, false);
    frame(9000);
    expect(store.getState().time).toBe(0);
    frame(9100);
    expect(store.getState().time).toBeCloseTo(0.1);
    expect(store.isBuffering()).toBe(false);
  });

  it("reset rewinds and stops but keeps speed and loop", () => {
    const { store } = manualStore();
    store.reset(10);
    store.setSpeed(2);
    store.setLoop(true);
    store.seek(4);
    store.play();
    store.reset(20);
    expect(store.getState()).toEqual({
      time: 0,
      playing: false,
      speed: 2,
      loop: true,
      end: 20,
    });
  });
});
