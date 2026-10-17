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

