// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPlotView, type PlotView, type Series } from "../src/views/Plot";
import { StatePlot } from "../src/views/StatePlot";
import { PlaybackContext, createPlaybackStore } from "../src/workspace/playback";
import { initialWorkspace } from "../src/workspace/widgets";

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

describe("State transition zoom", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
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
  it("keeps the view on double-click", () => {
    const zoomed = { center: 0.5, zoom: 2 };
    const { track } = setup({ ...defaultPlotView(), x: zoomed });
    fireEvent.doubleClick(track);
    expect(view.x).toEqual(zoomed);
  });
});
