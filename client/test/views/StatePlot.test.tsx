// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPlotView, type PlotView, type Series } from "../../src/views/Plot";
import { StatePlot, stateBands } from "../../src/views/StatePlot";
import { PlaybackContext, createPlaybackStore } from "../../src/workspace/playback";
import { initialWorkspace } from "../../src/workspace/widgets";

const series = {
  key: "k",
  source: "r/0",
  topic: "/t",
  path: ["mode"],
  color: "red",
  lineWidth: 1,
  hidden: false,
  dataType: "string",
  points: [
    { x: 0, y: null, ns: "0", raw: "A" },
    { x: 5, y: null, ns: "5", raw: "B" },
  ],
} as unknown as Series;

let view: PlotView;
function setup(initial: PlotView = defaultPlotView()) {
  const store = createPlaybackStore(
    () => 1,
    () => {},
  );
  store.reset(10);
  function Harness() {
    const [current, setCurrent] = useState(initial);
    view = current;
    const props: ComponentProps<typeof StatePlot> = {
      widget: { ...initialWorkspace().widgets["widget-1"], type: "state", view: current },
      series: [series],
      fullEnd: 10,
      originNs: "0",
      onViewChange: (update) => setCurrent(update),
    };
    return (
      <PlaybackContext.Provider value={store}>
        <StatePlot {...props} />
      </PlaybackContext.Provider>
    );
  }
  render(<Harness />);
  const track = document.querySelector<HTMLElement>(".state-track")!;
  track.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
  return { store, track };
}
const wheel = (target: Element, deltaY: number, clientX = 25) => {
  const event = new WheelEvent("wheel", { deltaY, clientX, bubbles: true, cancelable: true });
  fireEvent(target, event);
  return event;
};

const state = (start: number, end: number, value = "A") => ({
  start,
  end,
  value,
  color: "red",
  ns: String(start),
});

describe("State timeline bands", () => {
  it("merges states too short to draw, instead of widening each one", () => {
    const flips = Array.from({ length: 2000 }, (_, i) =>
      state(i / 100, (i + 1) / 100, i % 2 ? "A" : "B"),
    );
    const bands = stateBands(flips, [0, 20], 1000);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ start: 0, end: 20, segment: null, count: 2000 });
  });
  it("shows each state again once zoomed in far enough", () => {
    const flips = Array.from({ length: 2000 }, (_, i) =>
      state(i / 100, (i + 1) / 100, i % 2 ? "A" : "B"),
    );
    const bands = stateBands(flips, [0, 1], 1000);
    expect(bands.every((band) => band.segment)).toBe(true);
    expect(bands.length).toBeGreaterThanOrEqual(100);
  });
  it("keeps one short state as itself between long ones", () => {
    const bands = stateBands(
      [state(0, 5), state(5, 5.001, "SPIKE"), state(5.001, 10)],
      [0, 10],
      100,
    );
    expect(bands.map((band) => band.segment?.value)).toEqual(["A", "SPIKE", "A"]);
  });
  it("does not merge across a visible gap", () => {
    const bands = stateBands([state(0, 0.01), state(5, 5.01)], [0, 10], 100);
    expect(bands).toHaveLength(2);
  });
  it("clips to the visible range and skips the rest", () => {
    const bands = stateBands([state(0, 2), state(2, 6, "B"), state(6, 10)], [3, 5], 100);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ start: 3, end: 5, count: 1 });
  });
  it("draws nothing until the width is known", () => {
    expect(stateBands([state(0, 1)], [0, 1], 0)).toEqual([]);
  });
});

describe("State timeline zoom", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private notify: (entries: unknown[]) => void) {}
        observe() {
          this.notify([{ contentRect: { width: 100 } }]);
        }
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("leaves out the axis without visible rows", () => {
    render(
      <PlaybackContext.Provider value={createPlaybackStore()}>
        <StatePlot
          widget={{ ...initialWorkspace().widgets["widget-1"], type: "state" }}
          series={[]}
          fullEnd={10}
          originNs="0"
          onViewChange={() => {}}
        />
      </PlaybackContext.Provider>,
    );
    expect(document.querySelector(".state-axis")).toBeNull();
  });
  it("zooms around the pointer over a bar instead of scrolling", () => {
    const { track } = setup();
    const event = wheel(track, -100);
    expect(event.defaultPrevented).toBe(true);
    expect(view.x.zoom).toBeCloseTo(1.1);
    // The time under the pointer stays put: 25% of the full range before and after.
    expect(view.x.center - 0.25 / view.x.zoom).toBeCloseTo(0.5 - 0.25);
  });
  it("zooms over a label as well", () => {
    setup();
    const event = wheel(screen.getByText("mode"), -100);
    expect(event.defaultPrevented).toBe(true);
    expect(view.x.zoom).toBeGreaterThan(1);
  });
  it("stays inside the recording when zooming out somewhere else", () => {
    const { track } = setup();
    for (let i = 0; i < 20; i++) wheel(track, -100, 5);
    for (let i = 0; i < 10; i++) {
      wheel(track, 100, 95);
      const half = 0.5 / view.x.zoom;
      expect(view.x.center - half).toBeGreaterThanOrEqual(-1e-9);
      expect(view.x.center + half).toBeLessThanOrEqual(1 + 1e-9);
    }
    for (let i = 0; i < 20; i++) wheel(track, 100, 95);
    expect(view.x.zoom).toBeCloseTo(1);
    expect(view.x.center).toBeCloseTo(0.5);
  });
  it("does not zoom out below the full range", () => {
    const { track } = setup();
    wheel(track, 100);
    expect(view.x).toEqual(defaultPlotView().x);
  });
  it("seeks to the time shown at the click while zoomed", () => {
    const { store, track } = setup({ ...defaultPlotView(), x: { center: 0.5, zoom: 2 } });
    fireEvent.click(track, { clientX: 50 });
    expect(store.getState().time).toBeCloseTo(5);
    fireEvent.click(track, { clientX: 0 });
    expect(store.getState().time).toBeCloseTo(2.5);
  });
  it("positions segments from the visible range", () => {
    setup({ ...defaultPlotView(), x: { center: 0.5, zoom: 2 } });
    const [a, b] = [...document.querySelectorAll<HTMLElement>(".state-segment")];
    expect(a.style.left).toBe("0%");
    expect(b.style.left).toBe("50%");
    expect(b.style.width).toBe("50%");
  });
  it("skips segments outside the visible range and hides an off-screen playhead", () => {
    const { store } = setup({ ...defaultPlotView(), x: { center: 0.9, zoom: 10 } });
    expect(document.querySelectorAll(".state-segment")).toHaveLength(1);
    expect(store.getState().time).toBe(0);
    expect(document.querySelector(".playhead")).toBeNull();
  });
  it("labels only bands wide enough to read", () => {
    setup();
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("B")).toBeTruthy();
    expect(document.querySelectorAll(".state-segment-labeled")).toHaveLength(2);
  });
  describe("drag", () => {
    const pointer = (type: string, target: Element, clientX: number) => {
      const event = new MouseEvent(type, { clientX, bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(target, event);
    };
    const press = (track: Element) => {
      (track as HTMLElement).setPointerCapture = () => {};
      pointer("pointerdown", track, 50);
    };
    it("pans the time range while zoomed, without moving the playback position", () => {
      const { store, track } = setup({ ...defaultPlotView(), x: { center: 0.5, zoom: 2 } });
      press(track);
      pointer("pointermove", track, 30);
      pointer("pointerup", track, 30);
      fireEvent.click(track, { clientX: 30 });
      // 20% of the track at 2x zoom is 10% of the recording.
      expect(view.x.center).toBeCloseTo(0.6);
      expect(store.getState().time).toBe(0);
    });
    it("stops at the ends of the recording", () => {
      const { track } = setup({ ...defaultPlotView(), x: { center: 0.5, zoom: 2 } });
      press(track);
      pointer("pointermove", track, -500);
      expect(view.x.center).toBeCloseTo(0.75);
    });
    it("treats a small movement as a click", () => {
      const { store, track } = setup({ ...defaultPlotView(), x: { center: 0.5, zoom: 2 } });
      press(track);
      pointer("pointermove", track, 48);
      pointer("pointerup", track, 48);
      fireEvent.click(track, { clientX: 50 });
      expect(view.x.center).toBeCloseTo(0.5);
      expect(store.getState().time).toBeCloseTo(5);
    });
    it("keeps the full range when not zoomed", () => {
      const { track } = setup();
      press(track);
      pointer("pointermove", track, 10);
      expect(view.x).toEqual(defaultPlotView().x);
    });
  });
  it("keeps the view on double-click", () => {
    const zoomed = { center: 0.5, zoom: 2 };
    const { track } = setup({ ...defaultPlotView(), x: zoomed });
    fireEvent.doubleClick(track);
    expect(view.x).toEqual(zoomed);
  });
});
