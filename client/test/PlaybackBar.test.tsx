// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackBar } from "../src/workspace/PlaybackBar";
import { PlaybackContext, createPlaybackStore } from "../src/workspace/playback";
import type { Info } from "../src/types";

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
  it.each([
    ["summary", "summary"],
    ["field row", "div"],
  ])("leaves Space to a focused %s", (_, tag) => {
    const store = renderBar();
    const element = document.body.appendChild(document.createElement(tag));
    if (tag === "div") element.setAttribute("role", "button");
    fireEvent.keyDown(element, { key: " " });
    element.remove();
    expect(store.getState().playing).toBe(false);
  });
  it("toggles playback with the button and Space", () => {
    const store = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(store.getState().playing).toBe(true);
    fireEvent.keyDown(document.body, { key: " " });
    expect(store.getState().playing).toBe(false);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("steps with the arrow keys", () => {
    const store = renderBar();
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(store.getState().time).toBeCloseTo(0.9);
  });

  it("keeps arrow shortcuts while a button has focus", () => {
    const store = renderBar();
    fireEvent.keyDown(screen.getByRole("button", { name: "Go to end" }), {
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
    fireEvent.click(screen.getByRole("button", { name: "Loop playback" }));
    expect(store.getState()).toMatchObject({ speed: 2, loop: true });
    expect(screen.getByRole("button", { name: "Loop playback" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("disables the controls without a recording", () => {
    const store = renderBar(null);
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: " " });
    expect(store.getState().playing).toBe(false);
  });

  it("shows buffering in the existing status area without inserting a playback bar item", () => {
    const store = renderBar();
    const status = screen.getByRole("status");
    const bar = screen.getByLabelText("Playback");
    const children = [...bar.children];
    const token = Symbol();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => store.setBuffering(token, true));
    expect(status.textContent).toContain("Buffering…");
    expect([...bar.children]).toEqual(children);
    act(() => store.setBuffering(token, false));
    expect(status.textContent).toContain("READY");
    expect([...bar.children]).toEqual(children);
  });
});
