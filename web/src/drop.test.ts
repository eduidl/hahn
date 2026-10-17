import { describe, expect, it } from "vitest";
import { addableFields, dropVerdict } from "./drop";
import { buildFieldIndex } from "./fieldIndex";
import { keyOf, type Field, type Selected, type Topic } from "./types";
import { addSeries, initialWorkspace, widgetSpecs, type Widget } from "./widgets";

const idle = [{ name: "IDLE", value: 0 }];
const fields: Field[] = [
  { path: ["speed"], data_type: "f64" },
  { path: ["flag"], data_type: "bool" },
  { path: ["mode"], data_type: "enum", enum_values: idle },
  { path: ["other_mode"], data_type: "enum", enum_values: [{ name: "RUN", value: 0 }] },
  { path: ["name"], data_type: "string" },
  { path: ["pose"], data_type: "struct", type_name: "geometry_msgs/msg/Pose" },
];
const topic: Topic = {
  topic: "/t",
  schema_name: "pkg/msg/T",
  schema_encoding: "ros2msg",
  message_count: 1,
  fields,
  error: null,
};
const broken: Topic = { ...topic, topic: "/broken", error: "bad schema" };
const index = buildFieldIndex([topic, broken]);
const selected = (field: Field): Selected => ({
  key: keyOf("/t", field.path),
  topic: "/t",
  path: field.path,
  color: "",
  lineWidth: 1,
  hidden: false,
  dataType: field.data_type,
  enumValues: field.enum_values,
});
const widget = (type: Widget["type"], series: Field[] = []): Widget => ({
  ...initialWorkspace().widgets["widget-1"],
  type,
  series: series.map(selected),
});
const verdict = (path: string[] | undefined, w: Widget) =>
  dropVerdict(index, { topic: "/t", path }, w);

describe("field index", () => {
  it("caches statically compatible fields per widget type, skipping unreadable topics", () => {
    const paths = (type: Widget["type"]) =>
      index.candidates[type].map((entry) => entry.field.path.join("."));
    expect(paths("time-series")).toEqual(["speed", "flag", "mode", "other_mode"]);
    expect(paths("state")).toEqual(["flag", "mode", "other_mode"]);
    expect(index.byKey.get(keyOf("/t", ["speed"]))).toMatchObject({
      kind: { type: "numeric" },
      typeLabel: "float64",
      label: "/t · speed",
    });
  });
});

describe("drop verdict", () => {
  it("lets an empty time series take any supported kind, then only the same kind", () => {
    expect(verdict(["speed"], widget("time-series")).ok).toBe(true);
    expect(verdict(["mode"], widget("time-series")).ok).toBe(true);
    expect(verdict(["name"], widget("time-series"))).toEqual({
      ok: false,
      reason: "string は扱えません。数値・bool・enum を指定してください。",
    });
    expect(verdict(["flag"], widget("time-series", [fields[0]]))).toEqual({
      ok: false,
      reason: "数値 の系列に bool は重ねられません。",
    });
    expect(verdict(["other_mode"], widget("time-series", [fields[2]]))).toEqual({
      ok: false,
      reason: "定義の異なる enum は重ねられません。",
    });
  });

  it("lets state widgets mix bool and enum definitions but not numbers", () => {
    expect(verdict(["mode"], widget("state", [fields[1]])).ok).toBe(true);
    expect(verdict(["other_mode"], widget("state", [fields[2]])).ok).toBe(true);
    expect(verdict(["speed"], widget("state"))).toEqual({
      ok: false,
      reason: "float64 は扱えません。bool・enum を指定してください。",
    });
  });

  it("rejects duplicates, structs, topics and unreadable topics", () => {
    expect(verdict(["speed"], widget("time-series", [fields[0]]))).toMatchObject({ reason: "追加済みです。" });
    expect(verdict(["pose"], widget("time-series"))).toMatchObject({ reason: expect.stringMatching(/^struct は扱えません/) });
    expect(verdict(undefined, widget("time-series"))).toMatchObject({ reason: expect.stringMatching(/^struct は扱えません/) });
    expect(dropVerdict(index, { topic: "/broken", path: ["speed"] }, widget("time-series")).ok).toBe(false);
  });

  it("replaces the series of a single-series widget", () => {
    const single = { ...widgetSpecs["time-series"], maxSeries: 1 };
    const w = widget("time-series", [fields[0]]);
    expect(dropVerdict(index, { topic: "/t", path: ["flag"] }, w, single)).toMatchObject({ ok: true, replaces: true });
    expect(addSeries(w.series, "/t", fields[1], single).map((s) => s.key)).toEqual([keyOf("/t", ["flag"])]);
  });
});

describe("addable fields", () => {
  it("filters cached candidates by the widget's current series", () => {
    const names = (w: Widget) => addableFields(index, w).map((entry) => entry.field.path.join("."));
    expect(names(widget("time-series"))).toEqual(["speed", "flag", "mode", "other_mode"]);
    expect(names(widget("time-series", [fields[2]]))).toEqual([]);
    expect(names(widget("time-series", [fields[1]]))).toEqual([]);
    expect(names(widget("state", [fields[1]]))).toEqual(["mode", "other_mode"]);
  });

  it("appends series with distinct colors and ignores duplicates", () => {
    const spec = widgetSpecs["time-series"];
    const one = addSeries([], "/t", fields[0], spec);
    const two = addSeries(one, "/t", { path: ["speed2"], data_type: "f64" }, spec);
    expect(two).toHaveLength(2);
    expect(two[0].color).not.toBe(two[1].color);
    expect(addSeries(two, "/t", fields[0], spec)).toBe(two);
  });
});
