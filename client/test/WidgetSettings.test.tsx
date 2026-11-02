// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { WidgetSettings } from "../src/workspace/WidgetSettings";
import { widget, widgetSpecs, widgetTypes, type Widget } from "../src/workspace/widgets";

const show = (type: Widget["type"]) =>
  render(
    <WidgetSettings
      widget={widget(1, type)}
      dispatch={vi.fn()}
      records={[]}
      index={buildFieldIndex([])}
    />,
  );

describe("widget settings", () => {
  afterEach(cleanup);

  it.each(widgetTypes)("starts %s with the widget name", (type) => {
    const { container } = show(type);
    expect(container.querySelector(".settings-title")?.textContent).toBe(widgetSpecs[type].label);
  });
  it.each(["tf-tree", "source-info"] as const)("says %s has no settings", (type) => {
    show(type);
    expect(screen.getByText("No settings")).toBeTruthy();
  });
  it("separates display settings from series", () => {
    show("plot");
    expect(screen.getByRole("region", { name: "Display" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Series" })).toBeTruthy();
  });
  it("counts series once, in the series section", () => {
    const { container } = show("plot");
    expect(container.querySelector(".settings-title")?.textContent).toBe("Plot");
    expect(screen.getAllByText(/0 series/)).toHaveLength(1);
  });
});
