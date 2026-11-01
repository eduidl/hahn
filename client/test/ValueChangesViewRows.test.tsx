// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Series } from "../src/views/Plot";
import { ValueChangesView } from "../src/views/ValueChangesView";
import { PlaybackContext, createPlaybackStore } from "../src/workspace/playback";
import { initialWorkspace } from "../src/workspace/widgets";

const series = (topic: string) =>
  ({
    key: topic,
    source: "r/0",
    topic,
    path: ["mode"],
    color: "red",
    lineWidth: 1,
    hidden: false,
    dataType: "string",
    points: [{ x: 0, y: null, ns: "0", raw: "A" }],
  }) as unknown as Series;

let resize: (height: number) => void;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: { contentRect: { height: number } }[]) => void) {
        resize = (height) => callback([{ contentRect: { height } }]);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("names the topic so that the same field of two topics can be told apart", () => {
  render(
    <PlaybackContext.Provider value={createPlaybackStore()}>
      <ValueChangesView
        widget={initialWorkspace().widgets["widget-1"]}
        series={[series("/a"), series("/b")]}
        originNs="0"
        revision={0}
      />
    </PlaybackContext.Provider>,
  );
  act(() => resize(500));
  const names = screen
    .getAllByRole("button")
    .map((row) => row.querySelector(".value-changes-series"));
  expect(names.map((name) => name?.textContent)).toEqual(["/a · mode", "/b · mode"]);
});
