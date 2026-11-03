// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Info, Topic } from "../../src/types";
import { TopicsTab } from "../../src/workspace/TopicsTab";

const topic = (name: string, fields: string[]): Topic => ({
  source: "r/0",
  topic: name,
  schema_name: "T",
  schema_encoding: null,
  views: [],
  message_count: 1,
  error: null,
  fields: fields.map((field) => ({
    path: [field],
    data_type: "float64" as const,
    type_name: "float64",
  })),
});
const topics = [topic("/telemetry", ["signal", "counter"]), topic("/reference", ["signal"])];

function Harness() {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(new Set<string>());
  return (
    <TopicsTab
      topics={topics}
      sourceNames={new Map()}
      multiSource={false}
      loadingInfo={false}
      info={{} as Info}
      search={search}
      setSearch={setSearch}
      expandedTopics={expanded}
      setExpandedTopics={setExpanded}
      showErrorTopics={false}
      setShowErrorTopics={() => {}}
      onAdd={vi.fn()}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
    />
  );
}
const type = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Search fields" }), { target: { value } });
const shownTopics = () =>
  [...document.querySelectorAll(".topic-name")].map((node) => node.textContent);
const shownFields = () =>
  [...document.querySelectorAll(".topic-field span")].map((node) => node.textContent);

describe("Topics search", () => {
  afterEach(cleanup);

  it("finds a field from words of its topic and name, marking each", () => {
    render(<Harness />);
    type("signal telemetry");
    expect(shownTopics()).toEqual(["/telemetry"]);
    expect(shownFields()).toEqual(["signal"]);
    expect([...document.querySelectorAll("mark")].map((node) => node.textContent)).toEqual([
      "telemetry",
      "signal",
    ]);
    expect(screen.getByText("1 / 2 topics")).toBeTruthy();
  });
  it("shows all fields of a topic matched by name", () => {
    render(<Harness />);
    type("telemetry");
    expect(shownFields()).toEqual(["signal", "counter"]);
  });
  it("says when nothing matches, and counts no topics", () => {
    render(<Harness />);
    type("nothing");
    expect(shownTopics()).toEqual([]);
    expect(screen.getByText("0 / 2 topics")).toBeTruthy();
    expect(screen.getByText("No matching topics or fields")).toBeTruthy();
  });
  it("treats a blank search as no search", () => {
    render(<Harness />);
    type("   ");
    expect(shownTopics()).toEqual(["/telemetry", "/reference"]);
  });
});
