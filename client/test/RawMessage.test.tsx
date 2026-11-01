// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RawMessage } from "../src/views/RawMessage";
import { keyOf, type Topic } from "../src/types";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { initialWorkspace, workspaceReducer } from "../src/workspace/widgets";

const emptyIndex = buildFieldIndex([]);
const current = vi.hoisted(() => ({ message: undefined as unknown, error: "" }));
vi.mock("../src/data/useCurrentMessage", () => ({ useCurrentMessage: () => current }));

afterEach(() => cleanup());

it("shows integer fields without quotes while preserving strings and integer precision", () => {
  const state = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "raw" });
  const widget = state.widgets["widget-2"];
  widget.series = [
    {
      key: keyOf("r/0", "/t", []),
      source: "r/0",
      topic: "/t",
      path: [],
      hidden: false,
      color: "red",
      lineWidth: 1,
    },
  ];
  const topic: Topic = {
    source: "r/0",
    topic: "/t",
    schema_name: "T",
    schema_encoding: null,
    views: [],
    message_count: 1,
    error: null,
    fields: [
      { path: ["small"], data_type: "int16" },
      { path: ["nested"], data_type: "struct" },
      { path: ["nested", "large"], data_type: "int64" },
      { path: ["text"], data_type: "string" },
    ],
  };
  current.message = {
    time_ns: "0",
    value: { small: "-123", nested: { large: "9223372036854775807" }, text: "123" },
  };
  const { container } = render(
    <RawMessage
      widget={widget}
      info={{ start_ns: "0", end_ns: "1", message_count: 1 }}
      index={buildFieldIndex([topic])}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
  const values = [...container.querySelectorAll(".raw-value")];
  expect(values.map((value) => value.textContent)).toEqual([
    "-123",
    "9223372036854775807",
    '"123"',
  ]);
  expect(values.map((value) => value.className)).toEqual([
    "raw-value raw-number",
    "raw-value raw-number",
    "raw-value raw-string",
  ]);
});

it("preserves folding when a message temporarily disappears while loading", () => {
  const state = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "raw" });
  const widget = state.widgets["widget-2"];
  widget.series = [
    {
      key: keyOf("r/0", "/t", []),
      source: "r/0",
      topic: "/t",
      path: [],
      hidden: false,
      color: "red",
      lineWidth: 1,
    },
  ];
  const info = { start_ns: "0", end_ns: "5000000000", message_count: 2 };
  current.message = { time_ns: "0", value: { nested: { value: 1 } } };
  const { container, rerender } = render(
    <RawMessage widget={widget} info={info} index={emptyIndex} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
  expect(container.querySelectorAll("details")[1].open).toBe(true);

  current.message = undefined;
  rerender(<RawMessage widget={widget} info={info} index={emptyIndex} />);
  expect(screen.getByText("Loading…")).toBeTruthy();
  current.message = { time_ns: "2000000000", value: { nested: { value: 2 } } };
  rerender(<RawMessage widget={widget} info={info} index={emptyIndex} />);
  expect(container.querySelectorAll("details")[1].open).toBe(true);
  expect(screen.getByText("2")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
  expect(container.querySelectorAll("details")[1].open).toBe(false);
  current.message = undefined;
  rerender(<RawMessage widget={widget} info={info} index={emptyIndex} />);
  current.message = { time_ns: "4000000000", value: { nested: { value: 3 } } };
  rerender(<RawMessage widget={widget} info={info} index={emptyIndex} />);
  expect(container.querySelectorAll("details")[1].open).toBe(false);
});

it("keeps individually opened nodes across loading and resets them for a different topic", () => {
  const state = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "raw" });
  const widget = state.widgets["widget-2"];
  widget.series = [
    {
      key: keyOf("r/0", "/t", []),
      source: "r/0",
      topic: "/t",
      path: [],
      hidden: false,
      color: "red",
      lineWidth: 1,
    },
  ];
  const info = { start_ns: "0", end_ns: "5000000000", message_count: 2 };
  current.message = { time_ns: "0", value: { nested: { value: 1 } } };
  const { container, rerender } = render(
    <RawMessage widget={widget} info={info} index={emptyIndex} />,
  );
  const node = container.querySelectorAll("details")[1];
  node.open = true;
  fireEvent(node, new Event("toggle"));
  current.message = undefined;
  rerender(<RawMessage widget={widget} info={info} index={emptyIndex} />);
  current.message = { time_ns: "2000000000", value: { nested: { value: 2 } } };
  rerender(<RawMessage widget={widget} info={info} index={emptyIndex} />);
  expect(container.querySelectorAll("details")[1].open).toBe(true);

  const other = {
    ...widget,
    series: [{ ...widget.series[0], key: keyOf("r/0", "/other", []), topic: "/other" }],
  };
  rerender(<RawMessage widget={other} info={info} index={emptyIndex} />);
  expect(container.querySelectorAll("details")[1].open).toBe(false);
});

it("shows a JSON topic's document directly under the topic", () => {
  const state = workspaceReducer(initialWorkspace(), { type: "add", widgetType: "raw" });
  const widget = state.widgets["widget-2"];
  widget.series = [
    {
      key: keyOf("r/0", "/status", []),
      source: "r/0",
      topic: "/status",
      path: [],
      hidden: false,
      color: "red",
      lineWidth: 1,
    },
  ];
  const topic = (schema_encoding: string): Topic => ({
    source: "r/0",
    topic: "/status",
    schema_name: "Status",
    schema_encoding,
    views: [],
    message_count: 1,
    error: null,
    fields: [{ path: ["json"], data_type: "string" }],
  });
  const info = { start_ns: "0", end_ns: "1", message_count: 1 };
  current.message = { time_ns: "0", value: { json: { speed: 1.5 } } };
  const keys = (root: HTMLElement) =>
    [...root.querySelectorAll(".raw-key")].map((key) => key.textContent);
  const { container, rerender } = render(
    <RawMessage widget={widget} info={info} index={buildFieldIndex([topic("jsonschema")])} />,
  );
  expect(keys(container)).toEqual(["/status", "speed"]);
  // Elsewhere, a field that happens to be called json is an ordinary field.
  rerender(<RawMessage widget={widget} info={info} index={buildFieldIndex([topic("ros2msg")])} />);
  expect(keys(container)).toEqual(["/status", "json", "speed"]);
});
