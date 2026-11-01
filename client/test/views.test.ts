import { describe, expect, it } from "vitest";
import { addableFields, dropVerdict } from "../src/workspace/drop";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import type { Topic } from "../src/types";
import { fixedFrameOf } from "../src/data/useViewData";
import {
  addFieldAction,
  initialWorkspace,
  osmTiles,
  workspaceReducer,
  type Widget,
} from "../src/workspace/widgets";

const topic = (name: string, kinds: string[]): Topic => ({
  source: "r/0",
  topic: name,
  schema_name: "T",
  schema_encoding: null,
  views: kinds.map((kind) => ({ id: `v-${kind}`, kind, name: kind })),
  message_count: 1,
  error: null,
  fields: [{ path: ["x"], data_type: "float64" }],
});
const index = buildFieldIndex([
  topic("/camera", ["image"]),
  topic("/lidar", ["pointcloud"]),
  topic("/odom", ["pose"]),
  topic("/plain", []),
]);
function widgetOf(type: Widget["type"]) {
  const state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType: type,
  });
  return state;
}

describe("widgets showing views", () => {
  it("offer only whole topics with a view of their kinds", () => {
    const image = widgetOf("image").widgets["widget-1"];
    expect(addableFields(index, image).map((entry) => entry.topic.topic)).toEqual(["/camera"]);
    expect(addableFields(index, widgetOf("map").widgets["widget-1"])).toEqual([]);
    expect(
      addableFields(index, widgetOf("scene").widgets["widget-1"]).map((entry) => entry.topic.topic),
    ).toEqual(["/camera", "/lidar", "/odom"]);
    const plot = widgetOf("plot").widgets["widget-1"];
    expect(addableFields(index, plot).map((entry) => entry.label)).toContain("/camera · x");
  });
  it("requires an image before adding point clouds and replaces the image", () => {
    const imageIndex = buildFieldIndex([
      topic("/camera", ["image"]),
      topic("/camera2", ["image"]),
      topic("/lidar", ["pointcloud"]),
    ]);
    let state = widgetOf("image");
    const add = (name: string) => {
      const entry = imageIndex.candidates.image.find((item) => item.topic.topic === name)!;
      state = workspaceReducer(
        state,
        addFieldAction(state.widgets["widget-1"], entry.topic, entry.field, imageIndex),
      );
    };
    expect(
      dropVerdict(imageIndex, { source: "r/0", topic: "/lidar" }, state.widgets["widget-1"]),
    ).toMatchObject({ ok: false, reason: "Select an image topic first." });
    add("/lidar");
    expect(state.widgets["widget-1"].series).toEqual([]);
    add("/camera");
    add("/lidar");
    expect(
      dropVerdict(imageIndex, { source: "r/0", topic: "/camera2" }, state.widgets["widget-1"]),
    ).toMatchObject({ ok: true, replaces: true });
    add("/camera2");
    expect(state.widgets["widget-1"].series.map((item) => item.topic).sort()).toEqual([
      "/camera2",
      "/lidar",
    ]);
  });
  it("explain what they reject", () => {
    const image = widgetOf("image").widgets["widget-1"];
    expect(dropVerdict(index, { source: "r/0", topic: "/camera" }, image).ok).toBe(true);
    expect(
      dropVerdict(index, { source: "r/0", topic: "/camera", path: ["x"] }, image),
    ).toMatchObject({
      ok: false,
      reason: "Select a topic rather than a field.",
    });
    expect(dropVerdict(index, { source: "r/0", topic: "/plain" }, image)).toMatchObject({
      ok: false,
      reason: "T cannot be displayed.",
    });
  });
  it("remember which view of the topic they read", () => {
    const state = widgetOf("scene");
    const entry = addableFields(index, state.widgets["widget-1"]).find(
      (item) => item.topic.topic === "/lidar",
    )!;
    const next = workspaceReducer(
      state,
      addFieldAction(state.widgets["widget-1"], entry.topic, entry.field, index),
    );
    expect(next.widgets["widget-1"].series[0].view).toBe("v-pointcloud");
  });
  it("use OpenStreetMap tiles until told otherwise", () => {
    const state = widgetOf("map");
    expect(state.widgets["widget-1"].tileUrl).toBe(osmTiles);
    const off = workspaceReducer(state, { type: "tile-url", id: "widget-1", value: "" });
    expect(off.widgets["widget-1"].tileUrl).toBe("");
  });
  it("keep their settings when split, and reset the fixed frame with the run", () => {
    let state = workspaceReducer(widgetOf("scene"), {
      type: "fixed-frame",
      id: "widget-1",
      value: "base",
    });
    state = workspaceReducer(state, { type: "tile-url", id: "widget-1", value: "https://t/{z}" });
    const split = workspaceReducer(state, { type: "add", target: "widget-1", duplicate: true });
    expect(split.widgets[split.activeId!]).toMatchObject({
      fixedFrame: "base",
      tileUrl: "https://t/{z}",
    });
    const reopened = workspaceReducer(state, { type: "sources", open: new Set() });
    expect(reopened.widgets["widget-1"].fixedFrame).toBeNull();
  });
});

describe("the frame of a 3D widget", () => {
  const withFrame = () =>
    workspaceReducer(widgetOf("scene"), { type: "fixed-frame", id: "widget-1", value: "base" });
  it("is forgotten once its last topic is gone", () => {
    const series = {
      key: "k",
      source: "r/0",
      topic: "/t",
      path: [],
      color: "#fff",
      lineWidth: 1,
      hidden: false,
    };
    let state = workspaceReducer(withFrame(), {
      type: "series",
      id: "widget-1",
      update: () => [series],
    });
    expect(state.widgets["widget-1"].fixedFrame).toBe("base");
    state = workspaceReducer(state, { type: "series", id: "widget-1", update: () => [] });
    expect(state.widgets["widget-1"].fixedFrame).toBeNull();
  });
  it("is forgotten when the widget is cleared", () => {
    const state = workspaceReducer(withFrame(), { type: "clear", id: "widget-1" });
    expect(state.widgets["widget-1"].fixedFrame).toBeNull();
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
