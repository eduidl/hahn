import { describe, expect, it } from "vitest";
import { keyOf, type Selected, type Topic } from "../src/types";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { seriesStates, usableWorkspace } from "../src/workspace/seriesState";
import { initialWorkspace, type Widget, workspaceReducer } from "../src/workspace/widgets";

const source = "n/0";
const topic = (fields: Topic["fields"], error: string | null = null): Topic => ({
  source,
  topic: "/t",
  schema_name: "T",
  schema_encoding: null,
  views: [],
  message_count: 1,
  error,
  fields,
});
const field = (name: string, data_type: "float64" | "bool" | "string" = "float64") => ({
  path: [name],
  data_type,
  type_name: data_type,
});
const selected = (name: string, dataType = "float64", from = source): Selected => ({
  key: keyOf(from, "/t", [name]),
  source: from,
  topic: "/t",
  path: [name],
  color: "#fff",
  lineWidth: 1,
  hidden: false,
  dataType,
});
const plot = (...series: Selected[]) =>
  ({ ...initialWorkspace().widgets["widget-1"], series }) as Widget;
const env = (topics: Topic[], overrides = {}) => ({
  runOpen: true,
  sources: [{ id: source, loading: false, error: "" }],
  index: buildFieldIndex(topics),
  ...overrides,
});
const stateOf = (series: Selected, e: ReturnType<typeof env>) =>
  seriesStates(plot(series), e).get(series.key);

describe("series state", () => {
  it("is usable when the open groups have the field", () => {
    expect(stateOf(selected("a"), env([topic([field("a")])]))).toMatchObject({ usable: true });
  });
  it.each([
    ["no run is open", selected("a"), env([], { runOpen: false }), null],
    [
      "its group is loading",
      selected("a"),
      env([], { sources: [{ id: source, loading: true, error: "" }] }),
      null,
    ],
    ["its group is closed", selected("a", "float64", "n/1"), env([]), "Group is closed."],
    [
      "its group failed",
      selected("a"),
      env([], { sources: [{ id: source, loading: false, error: "x" }] }),
      "Group could not be loaded.",
    ],
    ["its topic is missing", selected("a"), env([]), "Topic not found in this run."],
    [
      "its topic is unreadable",
      selected("a"),
      env([topic([field("a")], "bad")]),
      "This topic cannot be read.",
    ],
    [
      "its field is missing",
      selected("a"),
      env([topic([field("b")])]),
      "Field not found in this run.",
    ],
    [
      "this widget cannot show its type",
      selected("a", "string"),
      env([topic([field("a", "string")])]),
      "This widget cannot show string.",
    ],
  ])("is not usable when %s", (_, series, e, problem) => {
    expect(stateOf(series, e)).toEqual({ usable: false, problem });
  });
  it("does not take a topic with the same id but another name", () => {
    const series = { ...selected("a"), topicName: "/other" };
    expect(stateOf(series, env([{ ...topic([field("a")]), topicName: "/t" }]))).toEqual({
      usable: false,
      problem: "Topic not found in this run.",
    });
  });
  it("marks a field that does not go with the first one shown", () => {
    const widget = plot(selected("a"), selected("b", "bool"));
    const states = seriesStates(widget, env([topic([field("a"), field("b", "bool")])]));
    expect(states.get(widget.series[0].key)).toMatchObject({ usable: true });
    expect(states.get(widget.series[1].key)).toEqual({
      usable: false,
      problem: "Cannot be shown with the other series.",
    });
  });
  it("shows only usable series, with the current run's type", () => {
    const state = workspaceReducer(initialWorkspace(), {
      type: "series",
      id: "widget-1",
      update: () => [selected("a", "int64"), selected("missing")],
    });
    const shown = usableWorkspace(state, env([topic([field("a")])]));
    expect(shown.widgets["widget-1"].series.map((s) => [s.path[0], s.dataType])).toEqual([
      ["a", "float64"],
    ]);
    expect(state.widgets["widget-1"].series).toHaveLength(2);
  });
  it("keeps the widget object when nothing changes", () => {
    const state = workspaceReducer(initialWorkspace(), {
      type: "series",
      id: "widget-1",
      update: () => [selected("a")],
    });
    const shown = usableWorkspace(state, env([topic([field("a")])]));
    expect(shown.widgets["widget-1"]).toBe(state.widgets["widget-1"]);
  });
  it("finds a moved series' topic again by name", () => {
    const moved = { ...selected("a"), topic: "@mcap:1", topicName: "/t" };
    const state = workspaceReducer(initialWorkspace(), {
      type: "series",
      id: "widget-1",
      update: () => [moved],
    });
    const next = workspaceReducer(state, {
      type: "topic-ids",
      topics: [{ source, topic: "@mcap:7", topicName: "/t" }],
    });
    expect(next.widgets["widget-1"].series[0]).toMatchObject({
      topic: "@mcap:7",
      key: keyOf(source, "@mcap:7", ["a"]),
    });
    expect(workspaceReducer(next, { type: "topic-ids", topics: [] })).toBe(next);
  });
});
