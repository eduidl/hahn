import { describe, expect, it } from "vitest";
import { addableFields, dropVerdict } from "./drop";
import { buildFieldIndex } from "./fieldIndex";
import type { Topic } from "./types";
import { fixedFrameOf } from "./useViewData";
import { addFieldAction, initialWorkspace, osmTiles, workspaceReducer, type Widget } from "./widgets";

const topic = (name: string, kinds: string[]): Topic => ({
  source: "r/0", topic: name, schema_name: "T", schema_encoding: null, views: kinds.map((kind) => ({ id: `v-${kind}`, kind, name: kind })),
  message_count: 1, error: null, fields: [{ path: ["x"], data_type: "float64" }],
});
const index = buildFieldIndex([topic("/camera", ["image"]), topic("/lidar", ["pointcloud"]), topic("/plain", [])]);
function widgetOf(type: Widget["type"]) {
  const state = workspaceReducer(initialWorkspace(), { type: "change-type", id: "widget-1", widgetType: type });
  return state;
}

describe("widgets showing views", () => {
  it("offer only whole topics with a view of their kinds", () => {
    const image = widgetOf("image").widgets["widget-1"];
    expect(addableFields(index, image).map((entry) => entry.topic.topic)).toEqual(["/camera"]);
    expect(addableFields(index, widgetOf("map").widgets["widget-1"])).toEqual([]);
    const plot = widgetOf("time-series").widgets["widget-1"];
    expect(addableFields(index, plot).map((entry) => entry.label)).toContain("/camera · x");
  });
  it("explain what they reject", () => {
    const image = widgetOf("image").widgets["widget-1"];
    expect(dropVerdict(index, { source: "r/0", topic: "/camera" }, image).ok).toBe(true);
    expect(dropVerdict(index, { source: "r/0", topic: "/camera", path: ["x"] }, image)).toMatchObject({
      ok: false, reason: "フィールドではなくトピックを指定してください。",
    });
    expect(dropVerdict(index, { source: "r/0", topic: "/plain" }, image)).toMatchObject({ ok: false, reason: "T は表示できません。" });
  });
  it("remember which view of the topic they read", () => {
    const state = widgetOf("scene");
    const entry = addableFields(index, state.widgets["widget-1"])[0];
    const next = workspaceReducer(state, addFieldAction(state.widgets["widget-1"], entry.topic, entry.field));
    expect(next.widgets["widget-1"].series[0].view).toBe("v-pointcloud");
  });
  it("use OpenStreetMap tiles until told otherwise", () => {
    const state = widgetOf("map");
    expect(state.widgets["widget-1"].tileUrl).toBe(osmTiles);
    const off = workspaceReducer(state, { type: "tile-url", id: "widget-1", value: "" });
    expect(off.widgets["widget-1"].tileUrl).toBe("");
  });
  it("keep their settings when split, and reset the fixed frame with the run", () => {
    let state = workspaceReducer(widgetOf("scene"), { type: "fixed-frame", id: "widget-1", value: "base" });
    state = workspaceReducer(state, { type: "tile-url", id: "widget-1", value: "https://t/{z}" });
    const split = workspaceReducer(state, { type: "add", target: "widget-1", duplicate: true });
    expect(split.widgets[split.activeId!]).toMatchObject({ fixedFrame: "base", tileUrl: "https://t/{z}" });
    const reopened = workspaceReducer(state, { type: "sources", open: new Set() });
    expect(reopened.widgets["widget-1"].fixedFrame).toBeNull();
  });
});

describe("fixedFrameOf", () => {
  const frames = [
    { id: "base", parent: "map" },
    { id: "map", parent: null },
  ];
  it("prefers the chosen frame and falls back to a root", () => {
    expect(fixedFrameOf("base", frames)).toBe("base");
    expect(fixedFrameOf(null, frames)).toBe("map");
    expect(fixedFrameOf("gone", frames)).toBe("map");
    expect(fixedFrameOf(null, [])).toBeNull();
  });
});
