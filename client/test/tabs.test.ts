import { describe, expect, it } from "vitest";
import {
  addSelectedAction,
  canMove,
  containerLayout,
  initialWorkspace,
  leaves,
  ownerOf,
  requestedSeries,
  subtreeIds,
  workspaceReducer as reduce,
  type Container,
  type WorkspaceState,
} from "../src/workspace/widgets";
import { keyOf, type Selected } from "../src/types";

const first: Container = { widgetId: "widget-1", tabId: "tab-1" };
const second: Container = { ...first, tabId: "tab-2" };
const series: Selected = {
  key: keyOf("r/0", "/t", ["x"]),
  source: "r/0",
  topic: "/t",
  path: ["x"],
  color: "red",
  lineWidth: 2,
  hidden: false,
};
const initial = () =>
  reduce(initialWorkspace(), { type: "change-type", id: "widget-1", widgetType: "tabs" });
function invariant(state: WorkspaceState) {
  const ids = [
    ...leaves(state.layout),
    ...Object.values(state.widgets).flatMap((w) =>
      w.type === "tabs" ? w.tabs.flatMap((t) => leaves(t.layout)) : [],
    ),
  ];
  expect(ids.sort()).toEqual(Object.keys(state.widgets).sort());
  expect(new Set(ids).size).toBe(ids.length);
  for (const w of Object.values(state.widgets))
    if (w.type === "tabs") expect(ownerOf(state, w.id)).toBeUndefined();
  if (state.activeId) expect(state.widgets[state.activeId]).toBeDefined();
  if (state.expandedId) expect(state.widgets[state.expandedId]).toBeDefined();
}

describe("adding from the widget list", () => {
  const add = (state: WorkspaceState, type: Parameters<typeof addSelectedAction>[1]) =>
    reduce(state, addSelectedAction(state, type));

  it("adds beside the selected widget", () => {
    const state = add(initialWorkspace(), "log");
    expect(leaves(state.layout)).toEqual(["widget-1", "widget-2"]);
    expect(state.activeId).toBe("widget-2");
  });
  it("adds to the empty root when nothing is selected", () => {
    const empty = reduce(initialWorkspace(), { type: "remove", id: "widget-1" });
    expect(leaves(add(empty, "log").layout)).toHaveLength(1);
  });
  it("adds into the open tab when a Tab widget is selected", () => {
    const state = add(initial(), "log");
    expect(leaves(state.layout)).toEqual(["widget-1"]);
    expect(leaves(containerLayout(state, first))).toEqual([state.activeId]);
    invariant(state);
  });
  it("adds a Tab beside the selected Tab widget instead of nesting", () => {
    const state = add(initial(), "tabs");
    expect(leaves(state.layout)).toHaveLength(2);
    invariant(state);
  });
  it("adds a Tab beside the Tab widget holding the selected child", () => {
    const state = add(add(initial(), "log"), "tabs");
    expect(leaves(state.layout)).toHaveLength(2);
    expect(state.widgets[state.activeId!].type).toBe("tabs");
    invariant(state);
  });
  it("adds beside a selected child inside its tab", () => {
    const state = add(add(initial(), "log"), "table");
    expect(leaves(state.layout)).toEqual(["widget-1"]);
    expect(leaves(containerLayout(state, first))).toHaveLength(2);
    invariant(state);
  });
});

describe("Tab workspace", () => {
  it("uses unnumbered default names while keeping distinct widget and tab IDs", () => {
    let state = reduce(initialWorkspace(), { type: "add", duplicate: true });
    expect(Object.values(state.widgets).map((w) => w.title)).toEqual([
      "Time series",
      "Time series",
    ]);
    expect(Object.keys(state.widgets)).toEqual(["widget-1", "widget-2"]);
    state = reduce(state, { type: "change-type", id: "widget-1", widgetType: "tabs" });
    state = reduce(state, { type: "tab-add", id: "widget-1" });
    const w = state.widgets["widget-1"];
    expect(w.title).toBe("Tab");
    expect(w.type === "tabs" && w.tabs.map((tab) => [tab.id, tab.title])).toEqual([
      ["tab-1", ""],
      ["tab-2", ""],
    ]);
  });

  it("adds independent split layouts, retains hidden demand, and selects the first visible child", () => {
    let state = reduce(initial(), { type: "add", container: first });
    state = reduce(state, { type: "series", id: "widget-2", update: () => [series] });
    state = reduce(state, {
      type: "view",
      id: "widget-2",
      update: (view) => ({ ...view, x: { center: 5, zoom: 4 } }),
    });
    state = reduce(state, { type: "add", target: "widget-2", direction: "column" });
    const layout = containerLayout(state, first);
    expect(leaves(layout)).toEqual(["widget-2", "widget-3"]);
    expect(state.layout).toBe("widget-1");
    state = reduce(state, { type: "tab-add", id: "widget-1" });
    expect(state.activeId).toBe("widget-1");
    state = reduce(state, { type: "add", container: second, widgetType: "table" });
    expect(containerLayout(state, second)).toBe("widget-4");
    expect(containerLayout(state, first)).toBe(layout);
    expect(requestedSeries(state.widgets)).toEqual([series]);
    state = reduce(state, { type: "tab-select", id: "widget-1", tabId: "tab-1" });
    expect(state.activeId).toBe("widget-2");
    expect(state.widgets["widget-2"].view.x).toEqual({ center: 5, zoom: 4 });
    invariant(state);
  });

  it("renames, orders, removes tabs and never reuses tab IDs", () => {
    let state = initial();
    expect(reduce(state, { type: "tab-remove", id: "widget-1", tabId: "tab-1" })).toBe(state);
    state = reduce(state, { type: "tab-add", id: "widget-1" });
    state = reduce(state, {
      type: "tab-rename",
      id: "widget-1",
      tabId: "tab-2",
      title: "  Sensors  ",
    });
    const cleared = reduce(state, {
      type: "tab-rename",
      id: "widget-1",
      tabId: "tab-2",
      title: " ",
    });
    expect(
      cleared.widgets["widget-1"].type === "tabs" && cleared.widgets["widget-1"].tabs[1].title,
    ).toBe("");
    state = reduce(state, {
      type: "tab-reorder",
      id: "widget-1",
      tabId: "tab-2",
      beforeId: "tab-1",
    });
    const w = state.widgets["widget-1"];
    expect(w.type === "tabs" && w.tabs.map((tab) => tab.title)).toEqual(["Sensors", ""]);
    state = reduce(state, { type: "tab-remove", id: "widget-1", tabId: "tab-2" });
    state = reduce(state, { type: "tab-add", id: "widget-1" });
    expect(state.widgets["widget-1"].type === "tabs" && state.widgets["widget-1"].activeTabId).toBe(
      "tab-3",
    );
    invariant(state);
  });

  it("moves normal widgets between root, tabs and separate Tab widgets without changing settings", () => {
    let state = reduce(initial(), { type: "add", container: first });
    state = reduce(state, { type: "series", id: "widget-2", update: () => [series] });
    const original = state.widgets["widget-2"];
    state = reduce(state, { type: "move", id: "widget-2", target: "widget-1", edge: "left" });
    expect(leaves(state.layout)).toEqual(["widget-2", "widget-1"]);
    expect(containerLayout(state, first)).toBeNull();
    expect(state.widgets["widget-2"]).toBe(original);
    state = reduce(state, { type: "tab-add", id: "widget-1" });
    state = reduce(state, { type: "move", id: "widget-2", container: second });
    expect(state.layout).toBe("widget-1");
    expect(ownerOf(state, "widget-2")).toEqual(second);
    state = reduce(state, { type: "add", target: "widget-1", widgetType: "tabs" });
    const other = { widgetId: "widget-3", tabId: "tab-1" };
    state = reduce(state, { type: "move", id: "widget-2", container: other });
    expect(containerLayout(state, other)).toBe("widget-2");
    expect(state.widgets["widget-2"]).toBe(original);
    invariant(state);
  });

  it("moves a tab's layout and settings between root Tabs and inserts beside the destination tab", () => {
    let state = reduce(initial(), { type: "add", container: first });
    state = reduce(state, { type: "series", id: "widget-2", update: () => [series] });
    state = reduce(state, {
      type: "view",
      id: "widget-2",
      update: (view) => ({ ...view, x: { center: 5, zoom: 4 } }),
    });
    state = reduce(state, { type: "tab-rename", id: "widget-1", tabId: "tab-1", title: "Sensors" });
    state = reduce(state, { type: "tab-add", id: "widget-1" });
    state = reduce(state, { type: "add", target: "widget-1", widgetType: "tabs" });
    state = reduce(state, {
      type: "tab-rename",
      id: "widget-3",
      tabId: "tab-1",
      title: "Existing",
    });
    const original = state.widgets["widget-2"];
    const demand = requestedSeries(state.widgets);
    state = reduce(state, { type: "expand", id: "widget-2" });
    state = reduce(state, {
      type: "tab-move",
      id: "widget-1",
      tabId: "tab-1",
      targetId: "widget-3",
      beforeId: "tab-1",
    });
    expect(ownerOf(state, "widget-2")).toEqual({ widgetId: "widget-3", tabId: "tab-2" });
    expect(state.widgets["widget-2"]).toBe(original);
    expect(requestedSeries(state.widgets)).toEqual(demand);
    const source = state.widgets["widget-1"],
      target = state.widgets["widget-3"];
    expect(source.type === "tabs" && source.tabs.map((t) => t.id)).toEqual(["tab-2"]);
    expect(target.type === "tabs" && target.tabs.map((t) => [t.id, t.title])).toEqual([
      ["tab-2", "Sensors"],
      ["tab-1", "Existing"],
    ]);
    expect(state.activeId).toBe("widget-2");
    expect(state.expandedId).toBeNull();
    invariant(state);
  });

  it("leaves an empty tab at the source and replaces only an empty default destination", () => {
    let state = reduce(initial(), { type: "add", container: first });
    state = reduce(state, { type: "add", target: "widget-1", widgetType: "tabs" });
    state = reduce(state, {
      type: "tab-move",
      id: "widget-1",
      tabId: "tab-1",
      targetId: "widget-3",
    });
    const source = state.widgets["widget-1"],
      target = state.widgets["widget-3"];
    expect(source.type === "tabs" && source.tabs).toEqual([
      { id: "tab-2", title: "", layout: null },
    ]);
    expect(target.type === "tabs" && target.tabs).toEqual([
      { id: "tab-2", title: "", layout: "widget-2" },
    ]);
    const moved = state;
    expect(
      reduce(state, { type: "tab-move", id: "widget-1", tabId: "tab-1", targetId: "widget-3" }),
    ).toBe(moved);
    state = reduce(state, { type: "tab-add", id: "widget-3" });
    expect(
      state.widgets["widget-3"].type === "tabs" && state.widgets["widget-3"].tabs.map((t) => t.id),
    ).toEqual(["tab-2", "tab-3"]);
    invariant(state);
  });

  it("preserves a populated destination and inserts after the requested tab", () => {
    let state = reduce(initial(), { type: "add", target: "widget-1", widgetType: "tabs" });
    state = reduce(state, { type: "add", container: { widgetId: "widget-2", tabId: "tab-1" } });
    state = reduce(state, { type: "tab-add", id: "widget-2" });
    state = reduce(state, {
      type: "tab-move",
      id: "widget-1",
      tabId: "tab-1",
      targetId: "widget-2",
      beforeId: "tab-1",
      after: true,
    });
    const target = state.widgets["widget-2"];
    expect(target.type === "tabs" && target.tabs.map((t) => [t.id, t.layout])).toEqual([
      ["tab-1", "widget-3"],
      ["tab-3", null],
      ["tab-2", null],
    ]);
    expect(state.activeId).toBe("widget-2");
    invariant(state);
  });

  it("rejects invalid tab moves without changing either widget", () => {
    let state = reduce(initial(), { type: "add", target: "widget-1", widgetType: "tabs" });
    state = reduce(state, { type: "add", target: "widget-1" });
    for (const [id, tabId, targetId, beforeId] of [
      ["widget-1", "tab-1", "widget-1", undefined],
      ["widget-1", "missing", "widget-2", undefined],
      ["widget-1", "tab-1", "missing", undefined],
      ["widget-3", "tab-1", "widget-2", undefined],
      ["widget-1", "tab-1", "widget-3", undefined],
      ["widget-1", "tab-1", "widget-2", "missing"],
    ])
      expect(
        reduce(state, { type: "tab-move", id: id!, tabId: tabId!, targetId: targetId!, beforeId }),
      ).toBe(state);
    invariant(state);
  });

  it("rejects nested Tabs through add, duplicate, move and type changes without changing state", () => {
    let state = reduce(initial(), { type: "add", container: first });
    state = reduce(state, { type: "add", target: "widget-1", widgetType: "tabs" });
    expect(leaves(state.layout)).toEqual(["widget-1", "widget-3"]);
    expect(reduce(state, { type: "add", container: first, widgetType: "tabs" })).toBe(state);
    expect(reduce(state, { type: "add", target: "widget-2", widgetType: "tabs" })).toBe(state);
    expect(
      reduce(state, { type: "add", target: "widget-3", container: first, duplicate: true }),
    ).toBe(state);
    expect(reduce(state, { type: "change-type", id: "widget-2", widgetType: "tabs" })).toBe(state);
    expect(canMove(state, "widget-3", first)).toBe(false);
    expect(reduce(state, { type: "move", id: "widget-3", container: first })).toBe(state);
    expect(reduce(state, { type: "move", id: "widget-3", target: "widget-2" })).toBe(state);
    expect(reduce(state, { type: "move", id: "widget-1", container: first })).toBe(state);
    invariant(state);
  });

  it("rejects missing targets and invalid layout updates atomically", () => {
    const state = reduce(initial(), { type: "add", container: first });
    expect(reduce(state, { type: "move", id: "widget-2", target: "missing" })).toBe(state);
    expect(
      reduce(state, {
        type: "move",
        id: "widget-2",
        container: { widgetId: "widget-1", tabId: "missing" },
      }),
    ).toBe(state);
    expect(reduce(state, { type: "layout", container: first, layout: "widget-1" })).toBe(state);
    expect(reduce(state, { type: "series", id: "widget-1", update: () => [series] })).toBe(state);
    invariant(state);
  });

  it("reorders and resizes only the specified container", () => {
    let state = reduce(initial(), { type: "add", container: first });
    state = reduce(state, { type: "add", target: "widget-2" });
    const layout = {
      type: "split" as const,
      direction: "column" as const,
      children: ["widget-3", "widget-2"],
      splitPercentages: [30, 70],
    };
    state = reduce(state, { type: "layout", container: first, layout });
    expect(containerLayout(state, first)).toEqual(layout);
    expect(state.layout).toBe("widget-1");
    state = reduce(state, { type: "move", id: "widget-3", target: "widget-2", edge: "bottom" });
    expect(containerLayout(state, first)).toMatchObject({
      direction: "column",
      children: ["widget-2", "widget-3"],
    });
    invariant(state);
  });

  it("duplicates and deletes containers with all children while sharing series demand", () => {
    let state = reduce(initial(), { type: "add", container: first });
    state = reduce(state, { type: "add", container: first });
    state = reduce(state, { type: "series", id: "widget-3", update: () => [series] });
    state = reduce(state, { type: "add", target: "widget-1", duplicate: true });
    const copyIds = subtreeIds(state, "widget-4");
    expect(copyIds).toHaveLength(3);
    expect(copyIds.some((id) => ["widget-1", "widget-2", "widget-3"].includes(id))).toBe(false);
    const copiedSeries = state.widgets[copyIds[2]].series;
    expect(copiedSeries).toEqual([series]);
    expect(copiedSeries[0]).not.toBe(state.widgets["widget-3"].series[0]);
    expect(requestedSeries(state.widgets)).toEqual([series]);
    state = reduce(state, { type: "remove", id: "widget-1" });
    expect(Object.keys(state.widgets).sort()).toEqual([...copyIds].sort());
    expect(requestedSeries(state.widgets)).toEqual([series]);
    state = reduce(state, { type: "remove", id: "widget-4" });
    expect(state.widgets).toEqual({});
    expect(requestedSeries(state.widgets)).toEqual([]);
    invariant(state);
  });

  it.each(["clear", "change-type", "tab-remove"] as const)(
    "%s releases all descendants and repairs selection and expansion",
    (type) => {
      let state = reduce(initial(), { type: "add", container: first });
      state = reduce(state, { type: "add", container: first });
      state = reduce(state, { type: "series", id: "widget-3", update: () => [series] });
      if (type === "tab-remove") state = reduce(state, { type: "tab-add", id: "widget-1" });
      state = reduce(state, { type: "expand", id: "widget-3" });
      state = reduce(
        state,
        type === "change-type"
          ? { type, id: "widget-1", widgetType: "raw" }
          : type === "tab-remove"
            ? { type, id: "widget-1", tabId: "tab-1" }
            : { type, id: "widget-1" },
      );
      expect(Object.keys(state.widgets)).toEqual(["widget-1"]);
      expect(state.activeId).toBe("widget-1");
      expect(state.expandedId).toBeNull();
      expect(requestedSeries(state.widgets)).toEqual([]);
      invariant(state);
    },
  );
});
