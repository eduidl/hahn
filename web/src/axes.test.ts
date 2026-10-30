import { describe, expect, it } from "vitest";
import {
  axisRange,
  defaultView,
  isDefaultView,
  panAxis,
  selectAxis,
  seriesYRange,
  discreteYValues,
  zoomAxis,
} from "./axes";
import type { Series } from "./Plot";

describe("independent axis magnification", () => {
  it("zooms around the pointer while keeping the other axis unchanged", () => {
    const initial = defaultView();
    const x = zoomAxis(initial, 2, 0.25);
    expect(x.zoom).toBe(2);
    expect(axisRange([0, 600], x)).toEqual([75, 375]);
    expect(axisRange([-20, 80], initial)).toEqual([-20, 80]);
    const y = zoomAxis(initial, 2, 0.75);
    expect(axisRange([-20, 80], y)).toEqual([17.5, 67.5]);
    expect(axisRange([0, 600], x)).toEqual([75, 375]);
  });

  it("clamps magnification at 1x without constraining position", () => {
    expect(zoomAxis(defaultView(), 1 / 1.1, 0.4)).toEqual(defaultView());
    expect(axisRange([-10, 10], zoomAxis(defaultView(), 0.001, 0.5))).toEqual([
      -10, 10,
    ]);
    expect(axisRange([0, 600], panAxis(defaultView(), -1))).toEqual([-600, 0]);
    expect(axisRange([0, 600], panAxis(defaultView(), 1))).toEqual([600, 1200]);
  });

  it("does not snap panned views back into the recording when zooming or selecting", () => {
    const panned = panAxis(defaultView(), -1);
    const zoomed = zoomAxis(panned, 2, 0.5);
    expect(axisRange([0, 100], zoomed)).toEqual([-75, -25]);
    expect(selectAxis(panned, 0.25, 0.75)).toEqual(zoomed);
    const anchored = zoomAxis(panned, 1.1, 0.25);
    const before = panned.center + (0.25 - 0.5) / panned.zoom;
    const after = anchored.center + (0.25 - 0.5) / anchored.zoom;
    expect(after).toBeCloseTo(before, 12);
  });

  it("uses the same 1.1 ratio at every magnification with inverse zoom-out", () => {
    let view = defaultView();
    expect(zoomAxis(view, 1.1, 0.5).zoom).toBe(1.1);
    for (let i = 0; i < 20; i++) view = zoomAxis(view, 1.1, 0.5);
    expect(view.zoom).toBeCloseTo(1.1 ** 20, 10);
    expect(zoomAxis({ ...view, zoom: 100 }, 1.1, 0.5).zoom).toBe(110);
    expect(zoomAxis(zoomAxis(defaultView(), 1.1, 0.5), 1 / 1.1, 0.5)).toEqual(
      defaultView(),
    );
    for (let i = 0; i < 30; i++) view = zoomAxis(view, 1 / 1.1, 0.5);
    expect(view).toEqual(defaultView());
  });

  it("recognizes the initial view, pan-only changes, and reset", () => {
    expect(isDefaultView(defaultView())).toBe(true);
    expect(isDefaultView(panAxis(defaultView(), 0.1))).toBe(false);
    expect(isDefaultView(zoomAxis(defaultView(), 1.1, 0.5))).toBe(false);
    expect(isDefaultView({ center: 0.5 + 1e-12, zoom: 1 + 1e-12 })).toBe(true);
    const selected = selectAxis(defaultView(), 0.25, 0.75);
    expect(selected.zoom).toBe(2);
    expect(axisRange([0, 100], selected)).toEqual([25, 75]);
    expect(axisRange([0, 100], defaultView())).toEqual([0, 100]);
  });

  it("derives the Y reference from all loaded samples, including offscreen peaks", () => {
    const series: Series = {
      key: "x",
      source: "r/0",
      topic: "/t",
      path: ["x"],
      color: "#fff",
      lineWidth: 1.5,
      hidden: false,
      points: [
        { x: 0, y: 0, raw: 0, ns: "0" },
        { x: 100, y: 100, raw: 100, ns: "100" },
        { x: 101, y: null, raw: null, ns: "101" },
      ],
    };
    expect(seriesYRange([series])).toEqual([-8, 108]);
    expect(seriesYRange([{ ...series, hidden: true }])).toEqual([-1, 1]);
    expect(seriesYRange([])).toEqual([-1, 1]);
    const [min, max] = seriesYRange([
      { ...series, points: [series.points[0]] },
    ]);
    expect(max).toBeGreaterThan(min);
  });
  it("builds ordered discrete Y categories from visible series", () => {
    const base: Series = {
      key: "x", source: "r/0", topic: "/t", path: ["x"], color: "#fff", lineWidth: 1, hidden: false,
      points: [
        { x: 0, y: 3, raw: 3, ns: "0" },
        { x: 1, y: 1, raw: 1, ns: "1" },
        { x: 2, y: 3, raw: 3, ns: "2" },
        { x: 3, y: null, raw: null, ns: "3" },
      ],
    };
    expect(discreteYValues([base])).toEqual([1, 3]);
    expect(discreteYValues([{ ...base, hidden: true }])).toEqual([]);
  });
});
