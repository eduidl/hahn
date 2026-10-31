import { describe, expect, it } from "vitest";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { appendMessages, cellValue, defaultColumnWidth, tableColumns } from "../src/views/table";
import { keyOf, type Selected, type Topic } from "../src/types";
import {
  addSeries,
  initialWorkspace,
  requestedSeries,
  widgetSpecs,
  workspaceReducer,
} from "../src/workspace/widgets";

export const topic: Topic = {
  source: "r/0",
  topic: "/t",
  schema_name: "T",
  schema_encoding: null,
  views: [],
  message_count: 10,
  error: null,
  fields: [
    { path: ["pose"], data_type: "struct" },
    { path: ["pose", "x"], data_type: "float64" },
    { path: ["tags"], data_type: "list" },
    { path: ["count"], data_type: "int64" },
    { path: ["mode"], data_type: "enum", enum_values: [{ name: "ON", value: "1" }] },
  ],
};
export const selected = (path: string[] = [], dataType = "struct"): Selected => ({
  key: keyOf("r/0", "/t", path),
  source: "r/0",
  topic: "/t",
  path,
  dataType,
  color: "#fff",
  lineWidth: 1,
  hidden: false,
});

describe("table data", () => {
  it("expands schema leaves in order, keeps arrays whole and supports scalar roots", () => {
    const index = buildFieldIndex([topic]);
    expect(tableColumns(index, selected()).map((c) => c.label)).toEqual([
      "pose.x",
      "tags",
      "count",
      "mode",
    ]);
    expect(tableColumns(index, selected(["pose"]))).toEqual([
      { label: "x", path: ["x"], dataType: "float64", enumValues: undefined },
    ]);
    expect(tableColumns(index, selected(["count"], "int64"))[0].path).toEqual([]);
  });
  it.each([
    ["bool", 72],
    ["int8", 80],
    ["uint16", 88],
    ["int32", 104],
    ["int64", 160],
    ["uint64", 160],
    ["float32", 104],
    ["float64", 136],
    ["string", 160],
    ["wstring[<=32]", 160],
    ["f64[]", 180],
    ["bytes", 180],
  ])("uses a compact default width for %s", (dataType, width) => {
    expect(defaultColumnWidth({ dataType: String(dataType) })).toBe(width);
  });
  it("sizes enums from their labels and preserves scalar selection types", () => {
    expect(defaultColumnWidth({ dataType: "enum", enumValues: [{ name: "ON", value: "1" }] })).toBe(
      96,
    );
    expect(
      defaultColumnWidth({ dataType: "enum", enumValues: [{ name: "A".repeat(100), value: "1" }] }),
    ).toBe(160);
    const column = tableColumns(buildFieldIndex([topic]), selected(["count"], "int64"))[0];
    expect(defaultColumnWidth(column)).toBe(160);
  });
  it("formats missing, empty, enum and composite values without rounding integers", () => {
    expect(cellValue({ pose: null }, { label: "x", path: ["pose", "x"] })).toBe("—");
    expect(cellValue("", { label: "値", path: [] })).toBe("(empty string)");
    expect(cellValue("9007199254740993", { label: "値", path: [] })).toBe("9007199254740993");
    expect(cellValue([1, 2], { label: "値", path: [] })).toBe("[1,2]");
    expect(cellValue(1, { label: "値", path: [], enumValues: [{ name: "ON", value: "1" }] })).toBe(
      "ON",
    );
  });
  it("merges exact ns order and preserves stable duplicate messages across batches", () => {
    const rows = appendMessages([], [{ time_ns: "9007199254740994", value: "a" }]);
    expect(
      appendMessages(rows, [
        { time_ns: "9007199254740994", value: "b" },
        { time_ns: "9007199254740993", value: "c" },
      ]).map((r) => r.value),
    ).toEqual(["c", "a", "b"]);
  });
  it("replaces the selected subtree and keeps generic targets out of scalar requests", () => {
    const spec = widgetSpecs.table;
    let state = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "table" });
    const list = addSeries([selected()], topic, topic.fields[0], spec);
    expect(list).toHaveLength(1);
    expect(list[0].path).toEqual(["pose"]);
    state = workspaceReducer(state, { type: "series", id: "widget-2", update: () => list });
    expect(requestedSeries(state.widgets)).toEqual([]);
    state = workspaceReducer(state, { type: "add", target: "widget-2", duplicate: true });
    expect(state.widgets["widget-3"].type).toBe("table");
    expect(state.widgets["widget-3"].series).toEqual(list);
  });
  it("copies column settings independently and resets them when the target changes", () => {
    let state = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "table" });
    state = workspaceReducer(state, { type: "series", id: "widget-2", update: () => [selected()] });
    state = workspaceReducer(state, {
      type: "table-column",
      id: "widget-2",
      path: ["pose", "x"],
      visible: false,
    });
    state = workspaceReducer(state, {
      type: "table-column-width",
      id: "widget-2",
      path: ["pose", "x"],
      width: 320,
    });
    state = workspaceReducer(state, { type: "add", target: "widget-2", duplicate: true });
    expect(state.widgets["widget-3"].columnWidths).toEqual({ '["pose","x"]': 320 });
    state = workspaceReducer(state, {
      type: "table-column-width",
      id: "widget-3",
      path: ["pose", "x"],
      width: 400,
    });
    expect(state.widgets["widget-2"].columnWidths).toEqual({ '["pose","x"]': 320 });
    expect(state.widgets["widget-3"].hiddenColumns).toEqual(['["pose","x"]']);
    state = workspaceReducer(state, {
      type: "table-column",
      id: "widget-3",
      path: ["pose", "x"],
      visible: true,
    });
    expect(state.widgets["widget-2"].hiddenColumns).toEqual(['["pose","x"]']);
    expect(state.widgets["widget-3"].hiddenColumns).toEqual([]);
    state = workspaceReducer(state, {
      type: "series",
      id: "widget-2",
      update: () => [selected(["pose"])],
    });
    expect(state.widgets["widget-2"].hiddenColumns).toEqual([]);
    expect(state.widgets["widget-2"].columnWidths).toEqual({});
  });
  it("bounds column widths and rejects non-finite values", () => {
    let state = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "table" });
    state = workspaceReducer(state, { type: "series", id: "widget-2", update: () => [selected()] });
    state = workspaceReducer(state, {
      type: "table-column-width",
      id: "widget-2",
      path: null,
      width: -1,
    });
    expect(state.widgets["widget-2"].columnWidths.time).toBe(64);
    state = workspaceReducer(state, {
      type: "table-column-width",
      id: "widget-2",
      path: [],
      width: 9999,
    });
    expect(state.widgets["widget-2"].columnWidths["[]"]).toBe(2000);
    expect(
      workspaceReducer(state, { type: "table-column-width", id: "widget-2", path: [], width: NaN }),
    ).toBe(state);
  });
});
