// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Topic } from "../src/types";
import { WidgetSettings } from "../src/workspace/WidgetSettings";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { initialWorkspace, workspaceReducer, type Widget } from "../src/workspace/widgets";

const topic = (name: string, kind: string): Topic => ({
  source: "r/0",
  topic: name,
  schema_name: "T",
  schema_encoding: null,
  views: [{ id: kind, kind, name: kind }],
  message_count: 1,
  error: null,
  fields: [],
});
const index = buildFieldIndex([
  topic("/camera", "image"),
  topic("/lidar", "pointcloud"),
  topic("/gps", "geo"),
]);

const show = (widgetType: Widget["type"]) => {
  const state = workspaceReducer(initialWorkspace(), {
    type: "change-type",
    id: "widget-1",
    widgetType,
  });
  render(
    <WidgetSettings
      widget={state.widgets["widget-1"]}
      dispatch={() => {}}
      records={[]}
      pointCount={0}
      index={index}
    />,
  );
};

describe("pickers of widgets fed by topics", () => {
  afterEach(cleanup);

  it.each(["scene", "map"] as const)("%s says topic, not field", (widgetType) => {
    show(widgetType);
    expect(screen.getByRole("button", { name: "Add topic" }).textContent).toBe("+ Topic");
    const search = screen.getByRole("combobox", {
      name: "Search for a topic to add",
      hidden: true,
    }) as HTMLInputElement;
    expect(search.placeholder).toMatch(/^Search [1-9]\d* topics?…$/);
  });
  it("uses the singular for a single candidate", () => {
    show("map");
    const search = screen.getByRole("combobox", {
      name: "Search for a topic to add",
      hidden: true,
    }) as HTMLInputElement;
    expect(search.placeholder).toBe("Search 1 topic…");
  });
  it("keeps the field wording on a plot", () => {
    show("plot");
    expect(screen.getByRole("button", { name: "Add field" }).textContent).toBe("+ Field");
  });
});

it.each(["plot", "state", "scene", "tf-tree"] as const)(
  "leaves the operations of %s to the title bar",
  (widgetType) => {
    show(widgetType);
    expect(screen.queryByText(/wheel|drag/i)).toBeNull();
    cleanup();
  },
);
