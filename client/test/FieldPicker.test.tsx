// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Topic } from "../src/types";
import { WidgetSettings } from "../src/workspace/WidgetSettings";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { initialWorkspace, workspaceReducer, type WorkspaceState } from "../src/workspace/widgets";

const field = (name: string) => ({
  path: [name],
  data_type: "float64" as const,
  type_name: "float64",
});
const topic: Topic = {
  source: "r/0",
  topic: "/t",
  schema_name: "T",
  schema_encoding: null,
  views: [],
  message_count: 1,
  error: null,
  fields: [field("alpha"), field("beta"), field("gamma")],
};

let latest: WorkspaceState;
function Harness() {
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspace());
  latest = state;
  return (
    <WidgetSettings
      widget={state.widgets["widget-1"]}
      dispatch={dispatch}
      records={[]}
      index={buildFieldIndex([topic])}
    />
  );
}
const search = () =>
  screen.getByRole("combobox", { name: "Search for a field to add", hidden: true });
const selected = () =>
  screen
    .getAllByRole("option", { hidden: true })
    .filter((option) => option.getAttribute("aria-selected") === "true")
    .map((option) => option.textContent);
const added = () => latest.widgets["widget-1"].series.map((s) => s.path.join("."));

describe("field picker", () => {
  beforeEach(() => {
    HTMLElement.prototype.hidePopover = vi.fn();
    render(<Harness />);
  });
  afterEach(cleanup);

  it("selects the first match, which Enter adds", () => {
    expect(selected()).toHaveLength(1);
    expect(selected()[0]).toContain("alpha");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(added()).toEqual(["alpha"]);
  });
  it("moves with the arrow keys, wrapping at the ends, and adds the selection", () => {
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(selected()[0]).toContain("gamma");
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(selected()[0]).toContain("alpha");
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(selected()[0]).toContain("beta");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(added()).toEqual(["beta"]);
  });
  it("selects the first match again when the search changes", () => {
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.change(search(), { target: { value: "a" } });
    expect(selected()[0]).toContain("alpha");
  });
  it("ignores keys when nothing matches", () => {
    fireEvent.change(search(), { target: { value: "zzz" } });
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(added()).toEqual([]);
    expect(search().getAttribute("aria-activedescendant")).toBeNull();
  });
});
