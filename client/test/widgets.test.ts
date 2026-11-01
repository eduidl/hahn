import { describe, expect, it } from "vitest";
import {
  initialWorkspace,
  workspaceReducer as reduce,
  requestedSeries,
  leaves,
  addAt,
  dropEdge,
} from "../src/workspace/widgets";
import { defaultPlotView } from "../src/views/Plot";
import { keyOf, type Selected } from "../src/types";
import { widgetSeries } from "../src/workspace/WidgetWorkspace";

const series: Selected = {
  key: keyOf("r/0", "/pose", ["x"]),
  source: "r/0",
  topic: "/pose",
  path: ["x"],
  color: "#ff0000",
  lineWidth: 0.1,
  hidden: false,
};
describe("widget workspace", () => {
  it("adds empty splits, removes leaves and selects a surviving widget", () => {
    let state = initialWorkspace();
    state = reduce(state, { type: "add", direction: "column" });
    expect(state.layout).toMatchObject({
      type: "split",
      direction: "column",
      children: ["widget-1", "widget-2"],
    });
    expect(state.activeId).toBe("widget-2");
    expect(state.widgets["widget-2"].series).toEqual([]);
    state = reduce(state, { type: "add", target: "widget-1" });
    expect(leaves(state.layout)).toEqual(["widget-1", "widget-3", "widget-2"]);
    state = reduce(state, { type: "remove", id: "widget-3" });
    expect(state.activeId).toBe("widget-1");
    state = reduce(state, { type: "remove", id: "widget-1" });
    expect(state.layout).toBe("widget-2");
    state = reduce(state, { type: "remove", id: "widget-2" });
    expect(state.layout).toBeNull();
    expect(state.activeId).toBeNull();
    expect(requestedSeries(state.widgets)).toEqual([]);
    state = reduce(state, { type: "add" });
    expect(state.layout).toBe("widget-4");
  });
  it("duplicates style independently while sharing recording field demand", () => {
    let state = reduce(initialWorkspace(), {
      type: "series",
      id: "widget-1",
      update: () => [series],
    });
    state = reduce(state, {
      type: "view",
      id: "widget-1",
      update: (view) => ({ ...view, x: { center: 1, zoom: 2 } }),
    });
    state = reduce(state, { type: "add", duplicate: true });
    expect(state.widgets["widget-2"].series).toEqual([series]);
    expect(state.widgets["widget-2"].view).toEqual(defaultPlotView());
    state = reduce(state, {
      type: "series",
      id: "widget-2",
      update: (list) =>
        list.map((s) => ({
          ...s,
          color: "#0000ff",
          lineWidth: 20,
          hidden: true,
        })),
    });
    expect(state.widgets["widget-1"].series[0]).toEqual(series);
    expect(requestedSeries(state.widgets)).toHaveLength(1);
    const points = [{ x: 0, y: 1, ns: "1", raw: 1 }];
    const data = [{ ...series, points }];
    const first = widgetSeries(state.widgets["widget-1"], data)[0];
    const second = widgetSeries(state.widgets["widget-2"], data)[0];
    expect(first.points).toBe(second.points);
    expect(first.color).toBe("#ff0000");
    expect(second.color).toBe("#0000ff");
    expect(second.lineWidth).toBe(20);
    expect(second.hidden).toBe(true);
    state = reduce(state, { type: "remove", id: "widget-2" });
    expect(requestedSeries(state.widgets)).toHaveLength(1);
  });
  it("adds a Data Source Info widget that requests no series", () => {
    let state = reduce(initialWorkspace(), { type: "add", widgetType: "source-info" });
    expect(state.widgets["widget-2"].type).toBe("source-info");
    state = reduce(state, { type: "change-type", id: "widget-1", widgetType: "source-info" });
    expect(state.widgets["widget-1"].type).toBe("source-info");
    expect(requestedSeries(state.widgets)).toEqual([]);
  });
  it("keeps State Transition and Time Series as independent widget types", () => {
    let state = reduce(initialWorkspace(), { type: "add", widgetType: "state" });
    expect(state.widgets["widget-2"].type).toBe("state");
    state = reduce(state, {
      type: "series",
      id: "widget-2",
      update: () => [{ ...series, dataType: "enum" }],
    });
    state = reduce(state, { type: "add", target: "widget-2", duplicate: true });
    expect(state.widgets["widget-3"].type).toBe("state");
    expect(state.widgets["widget-1"].type).toBe("plot");
  });
  it("preserves views during layout and selection changes and clears series on recording change", () => {
    let state = reduce(initialWorkspace(), {
      type: "series",
      id: "widget-1",
      update: () => [series],
    });
    state = reduce(state, {
      type: "view",
      id: "widget-1",
      update: (view) => ({ ...view, x: { center: -0.2, zoom: 3 } }),
    });
    state = reduce(state, { type: "add" });
    state = reduce(state, {
      type: "layout",
      layout: {
        type: "split",
        direction: "column",
        children: ["widget-2", "widget-1"],
        splitPercentages: [30, 70],
      },
    });
    state = reduce(state, { type: "select", id: "widget-1" });
    expect(state.widgets["widget-1"].view.x).toEqual({ center: -0.2, zoom: 3 });
    expect(
      reduce(state, {
        type: "layout",
        layout: {
          type: "tabs",
          tabs: ["widget-1", "widget-2"],
          activeTabIndex: 0,
        },
      }),
    ).toBe(state);
    const layout = state.layout;
    state = reduce(state, { type: "sources", open: new Set() });
    expect(state.layout).toBe(layout);
    expect(state.widgets["widget-1"].view).toEqual(defaultPlotView());
    expect(requestedSeries(state.widgets)).toEqual([]);
  });
  it("keeps series of recordings that stay open and resets views", () => {
    const other: Selected = { ...series, key: keyOf("r/1", "/pose", ["x"]), source: "r/1" };
    let state = reduce(initialWorkspace(), {
      type: "series",
      id: "widget-1",
      update: () => [series, other],
    });
    state = reduce(state, {
      type: "view",
      id: "widget-1",
      update: (view) => ({ ...view, x: { center: 0.2, zoom: 4 } }),
    });
    state = reduce(state, { type: "sources", open: new Set(["r/1", "r/2"]) });
    expect(state.widgets["widget-1"].series).toEqual([other]);
    expect(state.widgets["widget-1"].view).toEqual(defaultPlotView());
  });
  it("keeps views and frames but still drops closed series when restoring", () => {
    const other: Selected = { ...series, key: keyOf("r/1", "/pose", ["x"]), source: "r/1" };
    const zoomed = { x: { center: 0.2, zoom: 4 } };
    let state = reduce(initialWorkspace(), {
      type: "series",
      id: "widget-1",
      update: () => [series, other],
    });
    state = reduce(state, {
      type: "view",
      id: "widget-1",
      update: (view) => ({ ...view, ...zoomed }),
    });
    state = reduce(state, { type: "fixed-frame", id: "widget-1", value: "map" });
    state = reduce(state, { type: "sources", open: new Set(["r/1"]), keepViews: true });
    expect(state.widgets["widget-1"].series).toEqual([other]);
    expect(state.widgets["widget-1"].view.x).toEqual(zoomed.x);
    expect(state.widgets["widget-1"].fixedFrame).toBe("map");
  });
  it("temporarily expands without changing layout or widget state", () => {
    let state = reduce(initialWorkspace(), { type: "add" });
    const layout = state.layout;
    const widgets = state.widgets;
    state = reduce(state, { type: "expand", id: "widget-1" });
    expect(state.expandedId).toBe("widget-1");
    expect(state.activeId).toBe("widget-1");
    expect(state.layout).toBe(layout);
    expect(state.widgets).toBe(widgets);
    expect(reduce(state, { type: "layout", layout: "widget-1" })).toBe(state);
    state = reduce(state, { type: "expand", id: null });
    expect(state.layout).toBe(layout);
    expect(state.expandedId).toBeNull();
    state = reduce(state, { type: "expand", id: "widget-2" });
    state = reduce(state, { type: "remove", id: "widget-2" });
    expect(state.expandedId).toBeNull();
    expect(state.layout).toBe("widget-1");
  });
  it("maps a drop position to the nearest tile edge", () => {
    expect(dropEdge(10, 50, 100, 100)).toBe("left");
    expect(dropEdge(95, 50, 100, 100)).toBe("right");
    expect(dropEdge(50, 5, 100, 100)).toBe("top");
    expect(dropEdge(50, 90, 100, 100)).toBe("bottom");
  });
  it("places a dropped widget on the chosen side of the target", () => {
    let state = reduce(initialWorkspace(), addAt("state", "widget-1", "left"));
    expect(state.layout).toMatchObject({ direction: "row", children: ["widget-2", "widget-1"] });
    expect(state.widgets["widget-2"].type).toBe("state");
    state = reduce(state, addAt("plot", "widget-1", "bottom"));
    expect(state.layout).toMatchObject({
      direction: "row",
      children: ["widget-2", { direction: "column", children: ["widget-1", "widget-3"] }],
    });
    expect(state.activeId).toBe("widget-3");
  });
  it("switches a widget's type by replacing it with a fresh widget in the same slot", () => {
    let state = reduce(initialWorkspace(), {
      type: "series",
      id: "widget-1",
      update: () => [series],
    });
    state = reduce(state, { type: "change-type", id: "widget-1", widgetType: "state" });
    expect(state.widgets["widget-1"]).toMatchObject({
      id: "widget-1",
      type: "state",
      title: "State transition",
      series: [],
      view: defaultPlotView(),
    });
    expect(state.layout).toBe("widget-1");
  });
  it("duplicates the widget kind and series when splitting below", () => {
    let state = reduce(initialWorkspace(), {
      type: "change-type",
      id: "widget-1",
      widgetType: "state",
    });
    const flag = { ...series, dataType: "bool" };
    state = reduce(state, { type: "series", id: "widget-1", update: () => [flag] });
    state = reduce(state, {
      type: "add",
      target: "widget-1",
      direction: "column",
      duplicate: true,
    });
    expect(state.layout).toMatchObject({ direction: "column", children: ["widget-1", "widget-2"] });
    expect(state.widgets["widget-2"]).toMatchObject({
      type: "state",
      series: [flag],
      view: defaultPlotView(),
    });
    expect(state.widgets["widget-2"].series[0]).not.toBe(state.widgets["widget-1"].series[0]);
  });
  it("keeps legend settings per widget and copies them when splitting", () => {
    let state = initialWorkspace();
    expect(state.widgets["widget-1"].legend).toEqual({ visible: true, position: "top-left" });
    state = reduce(state, { type: "legend", id: "widget-1", value: { position: "bottom-left" } });
    state = reduce(state, { type: "legend", id: "widget-1", value: { visible: false } });
    expect(state.widgets["widget-1"].legend).toEqual({ visible: false, position: "bottom-left" });
    state = reduce(state, { type: "add", target: "widget-1", duplicate: true });
    expect(state.widgets["widget-2"].legend).toEqual({ visible: false, position: "bottom-left" });
  });
  it("clears only the target widget's series and view, keeping its settings", () => {
    let state = reduce(initialWorkspace(), { type: "add" });
    for (const id of ["widget-1", "widget-2"])
      state = reduce(state, { type: "series", id, update: () => [series] });
    state = reduce(state, {
      type: "view",
      id: "widget-1",
      update: (view) => ({ ...view, x: { center: 0.2, zoom: 4 } }),
    });
    state = reduce(state, { type: "clear", id: "widget-1" });
    expect(state.widgets["widget-1"]).toMatchObject({
      series: [],
      view: defaultPlotView(),
    });
    expect(state.widgets["widget-2"].series).toEqual([series]);
    expect(requestedSeries(state.widgets)).toEqual([series]);
  });
  it("resets the Y view only when the widget's value kind changes", () => {
    const zoomed = (state: ReturnType<typeof initialWorkspace>) =>
      reduce(state, {
        type: "view",
        id: "widget-1",
        update: (view) => ({ ...view, y: { center: 0.7, zoom: 3 }, pinnedYBase: [0, 1] }),
      });
    const numeric = { ...series, dataType: "float64" };
    let state = reduce(initialWorkspace(), {
      type: "series",
      id: "widget-1",
      update: () => [numeric],
    });
    state = zoomed(state);
    const other = { ...numeric, key: keyOf("r/0", "/pose", ["y"]), path: ["y"], dataType: "uint8" };
    state = reduce(state, { type: "series", id: "widget-1", update: (list) => [...list, other] });
    expect(state.widgets["widget-1"].view.pinnedYBase).toEqual([0, 1]);
    // Emptying the widget returns it to the unconstrained state.
    state = reduce(state, { type: "series", id: "widget-1", update: () => [] });
    expect(state.widgets["widget-1"].view.pinnedYBase).toBeNull();
    state = zoomed(state);
    state = reduce(state, {
      type: "series",
      id: "widget-1",
      update: () => [{ ...series, dataType: "enum", enumValues: [{ name: "IDLE", value: "0" }] }],
    });
    expect(state.widgets["widget-1"].view.y).toEqual(defaultPlotView().y);
    expect(state.widgets["widget-1"].view.pinnedYBase).toBeNull();
  });
});
