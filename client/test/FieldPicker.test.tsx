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
const bool = (name: string) => ({
  path: [name],
  data_type: "bool" as const,
  type_name: "bool",
});
const topic: Topic = {
  source: "r/0",
  topic: "/t",
  schema_name: "T",
  schema_encoding: null,
  views: [],
  message_count: 1,
  error: null,
  fields: [field("alpha"), field("beta"), field("gamma"), bool("flag"), bool("ready")],
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
    expect(selected()[0]).toContain("ready");
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
  it("finds a field from words of its topic and name, in any order", () => {
    fireEvent.change(search(), { target: { value: " beta  /t " } });
    expect(document.querySelectorAll(".field-option")).toHaveLength(1);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(latest.widgets["widget-1"].series.map((s) => s.path)).toEqual([["beta"]]);
  });
  describe("after adding a bool field", () => {
    beforeEach(() => {
      fireEvent.change(search(), { target: { value: "flag" } });
      fireEvent.keyDown(search(), { key: "Enter" });
    });
    it("says why a searched field cannot be added", () => {
      fireEvent.change(search(), { target: { value: "alpha" } });
      expect(screen.getByText("Only bool fields can be added.")).toBeTruthy();
      expect(screen.queryByText("No matching fields")).toBeNull();
    });
    it("says a searched field is already added", () => {
      fireEvent.change(search(), { target: { value: "flag" } });
      expect(screen.getByText("Already added")).toBeTruthy();
    });
    it("disables the button with the reason when nothing else fits", () => {
      fireEvent.change(search(), { target: { value: "ready" } });
      fireEvent.keyDown(search(), { key: "Enter" });
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: "Add field",
        hidden: true,
      });
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Only bool fields can be added.");
    });
  });
  it("still says when nothing has the searched name", () => {
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(screen.getByText("No matching fields")).toBeTruthy();
  });
  it("counts the fields a search leaves out and says why", () => {
    fireEvent.change(search(), { target: { value: "alpha" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    fireEvent.change(search(), { target: { value: "" } });
    expect(screen.getByText(/^2 more fields not shown\./).textContent).toBe(
      "2 more fields not shown. Only numeric fields can be added.",
    );
  });
  it("ignores keys when nothing matches", () => {
    fireEvent.change(search(), { target: { value: "zzz" } });
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(added()).toEqual([]);
    expect(search().getAttribute("aria-activedescendant")).toBeNull();
  });
});
