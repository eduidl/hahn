import { describe, expect, it } from "vitest";
import { addableFields, dropVerdict } from "../src/workspace/drop";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { keyOf, type Field, type Selected, type Topic } from "../src/types";
import {
  addSeries,
  initialWorkspace,
  requestedSeries,
  widgetSpecs,
  type Widget,
} from "../src/workspace/widgets";

const idle = [{ name: "IDLE", value: "0" }];
const fields: Field[] = [
  { path: ["speed"], data_type: "float64" },
  { path: ["flag"], data_type: "bool" },
  { path: ["mode"], data_type: "enum", enum_values: idle },
  { path: ["other_mode"], data_type: "enum", enum_values: [{ name: "RUN", value: "0" }] },
  { path: ["name"], data_type: "string" },
  { path: ["pose"], data_type: "struct", type_name: "geometry_msgs/msg/Pose" },
];
const topic: Topic = {
  source: "r/0",
  topic: "/t",
  schema_name: "pkg/msg/T",
  schema_encoding: "ros2msg",
  views: [],
  message_count: 1,
  fields,
  error: null,
};
const broken: Topic = { ...topic, topic: "/broken", error: "bad schema" };
const silent: Topic = { ...topic, topic: "/silent", message_count: 0 };
const index = buildFieldIndex([topic, broken, silent]);
const selected = (field: Field): Selected => ({
  key: keyOf("r/0", "/t", field.path),
  source: "r/0",
  topic: "/t",
  path: field.path,
  color: "",
  lineWidth: 1,
  hidden: false,
  dataType: field.data_type,
  enumValues: field.enum_values,
});
const widget = (type: Exclude<Widget["type"], "tabs">, series: Field[] = []): Widget => ({
  ...initialWorkspace().widgets["widget-1"],
  type,
  series: series.map(selected),
});
const verdict = (path: string[] | undefined, w: Widget) =>
  dropVerdict(index, { source: "r/0", topic: "/t", path }, w);

describe("field index", () => {
  it("caches statically compatible fields per widget type, skipping unreadable topics", () => {
    const paths = (type: Widget["type"]) =>
      index.candidates[type].map((entry) => entry.field.path.join("."));
    expect(paths("plot")).toEqual(["speed", "flag", "mode", "other_mode"]);
    expect(paths("state")).toEqual(["flag", "mode", "other_mode", "name"]);
    expect(index.byKey.get(keyOf("r/0", "/t", ["speed"]))).toMatchObject({
      kind: { type: "numeric" },
      typeLabel: "float64",
      label: "/t · speed",
    });
  });
});

describe("drop verdict", () => {
  it("lets an empty time series take any supported kind, then only the same kind", () => {
    expect(verdict(["speed"], widget("plot")).ok).toBe(true);
    expect(verdict(["mode"], widget("plot")).ok).toBe(true);
    expect(verdict(["name"], widget("plot"))).toEqual({
      ok: false,
      reason: "string is not supported. This widget accepts numeric, bool, enum fields.",
    });
    expect(verdict(["flag"], widget("plot", [fields[0]]))).toEqual({
      ok: false,
      reason: "Only numeric fields can be added.",
    });
    expect(verdict(["other_mode"], widget("plot", [fields[2]]))).toEqual({
      ok: false,
      reason: "Enums with different definitions cannot be combined.",
    });
  });

  it("lets state widgets mix bool and enum definitions but not numbers", () => {
    expect(verdict(["mode"], widget("state", [fields[1]])).ok).toBe(true);
    expect(verdict(["other_mode"], widget("state", [fields[2]])).ok).toBe(true);
    expect(verdict(["name"], widget("state", [fields[1]])).ok).toBe(true);
    expect(verdict(["speed"], widget("state"))).toEqual({
      ok: false,
      reason: "float64 is not supported. This widget accepts bool, enum, string fields.",
    });
  });

  it("shows JSON documents in Table and Raw message only", () => {
    const json = buildFieldIndex([
      { ...topic, fields: [{ path: ["json"], data_type: "json", type_name: "json" }] },
    ]);
    const accepted = (type: Exclude<Widget["type"], "tabs">, path: string[]) =>
      dropVerdict(json, { source: "r/0", topic: "/t", path }, widget(type)).ok;
    for (const path of [["json"], []]) {
      expect(accepted("table", path)).toBe(true);
      expect(accepted("raw", path)).toBe(true);
      expect(accepted("plot", path)).toBe(false);
      expect(accepted("state", path)).toBe(false);
      expect(accepted("value-changes", path)).toBe(false);
    }
  });

  it("explains that widgets without topic input take no topics", () => {
    expect(verdict(undefined, widget("source-info"))).toEqual({
      ok: false,
      reason: "This widget does not take topics.",
    });
  });
  it("rejects duplicates, structs, topics and unreadable topics", () => {
    expect(verdict(["speed"], widget("plot", [fields[0]]))).toMatchObject({
      reason: "Already added",
    });
    expect(verdict(["pose"], widget("plot"))).toMatchObject({
      reason: expect.stringMatching(/^struct is not supported/),
    });
    expect(verdict(undefined, widget("plot"))).toMatchObject({
      reason: expect.stringMatching(/^struct is not supported/),
    });
    expect(
      dropVerdict(index, { source: "r/0", topic: "/broken", path: ["speed"] }, widget("plot")).ok,
    ).toBe(false);
    expect(
      dropVerdict(index, { source: "r/0", topic: "/silent", path: ["speed"] }, widget("plot")),
    ).toEqual({
      ok: false,
      reason: "No messages",
    });
  });

  it("replaces the series of a single-series widget", () => {
    const single = { ...widgetSpecs["plot"], maxSeries: 1 };
    const w = widget("plot", [fields[0]]);
    expect(
      dropVerdict(index, { source: "r/0", topic: "/t", path: ["flag"] }, w, single),
    ).toMatchObject({ ok: true, replaces: true });
    expect(addSeries(w.series, topic, fields[1], single).map((s) => s.key)).toEqual([
      keyOf("r/0", "/t", ["flag"]),
    ]);
  });
});

describe("raw message widget", () => {
  it("takes any field or the topic itself, one at a time", () => {
    expect(verdict(undefined, widget("raw"))).toMatchObject({ ok: true, replaces: false });
    expect(verdict(["pose"], widget("raw", [fields[0]]))).toMatchObject({
      ok: true,
      replaces: true,
    });
    expect(verdict(["speed"], widget("raw", [fields[0]]))).toMatchObject({
      reason: "Already added",
    });
    expect(addableFields(index, widget("raw")).map((entry) => entry.label)).toContain("/t");
  });

  it("does not load its selection as an exact series", () => {
    const raw = { ...widget("raw", [fields[5]]), id: "raw" };
    const plot = { ...widget("plot", [fields[0]]), id: "plot" };
    expect(requestedSeries({ raw, plot }).map((s) => s.key)).toEqual([
      keyOf("r/0", "/t", ["speed"]),
    ]);
  });
});

describe("addable fields", () => {
  it("filters cached candidates by the widget's current series", () => {
    const names = (w: Widget) => addableFields(index, w).map((entry) => entry.field.path.join("."));
    expect(names(widget("plot"))).toEqual(["speed", "flag", "mode", "other_mode"]);
    expect(names(widget("plot", [fields[2]]))).toEqual([]);
    expect(names(widget("plot", [fields[1]]))).toEqual([]);
    expect(names(widget("state", [fields[1]]))).toEqual(["mode", "other_mode", "name"]);
  });

  it("appends series with distinct colors and ignores duplicates", () => {
    const spec = widgetSpecs["plot"];
    const one = addSeries([], topic, fields[0], spec);
    const two = addSeries(one, topic, { path: ["speed2"], data_type: "float64" }, spec);
    expect(two).toHaveLength(2);
    expect(two[0].color).not.toBe(two[1].color);
    expect(addSeries(two, topic, fields[0], spec)).toBe(two);
  });
});
