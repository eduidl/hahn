// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackBar } from "./PlaybackBar";
import { PlaybackContext, createPlaybackStore } from "./playback";
import type { Info } from "./types";

const info: Info = {
  start_ns: "1000000000",
  end_ns: "11000000000",
  message_count: 2,
};

afterEach(cleanup);

function renderBar(recording: Info | null = info) {
  const store = createPlaybackStore(
    () => 1,
    () => {},
  );
  store.reset(recording ? 10 : 0);
  render(
    <PlaybackContext.Provider value={store}>
      <PlaybackBar info={recording} fullEnd={10} busy={false} stop={vi.fn()} />
    </PlaybackContext.Provider>,
  );
  return store;
}

describe("PlaybackBar", () => {
  it("toggles playback with the button and Space", () => {
    const store = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "再生" }));
    expect(store.getState().playing).toBe(true);
    fireEvent.keyDown(document.body, { key: " " });
    expect(store.getState().playing).toBe(false);
    expect(screen.getByRole("button", { name: "再生" })).toBeTruthy();
  });

  it("steps with the arrow keys", () => {
    const store = renderBar();
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(store.getState().time).toBeCloseTo(0.9);
  });

  it("keeps arrow shortcuts while a button has focus", () => {
    const store = renderBar();
    fireEvent.keyDown(screen.getByRole("button", { name: "末尾へ" }), {
      key: "ArrowRight",
    });
    expect(store.getState().time).toBeCloseTo(0.1);
  });

  it("ignores shortcuts typed into form controls", () => {
    const store = renderBar();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: " " });
    expect(store.getState().playing).toBe(false);
  });

  it("changes speed and loop", () => {
    const store = renderBar();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "ループ再生" }));
    expect(store.getState()).toMatchObject({ speed: 2, loop: true });
    expect(
      screen.getByRole("button", { name: "ループ再生" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("disables the controls without a recording", () => {
    const store = renderBar(null);
    expect(
      (screen.getByRole("button", { name: "再生" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(document.body, { key: " " });
    expect(store.getState().playing).toBe(false);
  });
});
