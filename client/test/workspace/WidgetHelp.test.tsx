// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WidgetHelp } from "../../src/workspace/WidgetHelp";
import { widgetSpecs } from "../../src/workspace/widgets";

const toggle = vi.fn();
beforeEach(() => {
  toggle.mockClear();
  HTMLElement.prototype.togglePopover = toggle;
  render(<WidgetHelp title="Plot" controls={widgetSpecs.plot.controls!} />);
});
afterEach(cleanup);
const button = () => screen.getByRole("button", { name: "Plot controls" });

it("lists one operation per line", () => {
  const lines = screen.getByRole("tooltip", { hidden: true }).children;
  expect([...lines].map((line) => [...line.children].map((part) => part.textContent))).toEqual([
    ["Wheel", "zoom"],
    ["Shift + wheel", "zoom values"],
    ["Click", "move playback position"],
    ["Click legend item", "show or hide series"],
  ]);
});
it("follows a mouse hover", () => {
  fireEvent.pointerEnter(button());
  expect(toggle).toHaveBeenLastCalledWith(true);
  fireEvent.pointerLeave(button(), { pointerType: "mouse" });
  expect(toggle).toHaveBeenLastCalledWith(false);
});
it("follows keyboard focus", () => {
  fireEvent.focus(button());
  expect(toggle).toHaveBeenLastCalledWith(true);
  fireEvent.blur(button());
  expect(toggle).toHaveBeenLastCalledWith(false);
});
it("gives each operable widget its own list, and none to the rest", () => {
  expect(widgetSpecs.state.controls).toEqual([
    "Wheel: zoom",
    "Drag: pan while zoomed",
    "Click: move playback position",
  ]);
  expect(widgetSpecs.scene.controls).toEqual([
    "Drag: rotate",
    "Right-drag or Shift-drag: pan",
    "Wheel: zoom",
    "Middle-drag: look around",
    "WASD: move",
    "Shift+WASD: move faster",
  ]);
  expect(widgetSpecs["tf-tree"].controls).toEqual(["Drag: pan", "Wheel: zoom"]);
  expect(widgetSpecs.map.controls).toEqual(["Drag: pan", "Wheel: zoom"]);
  expect(widgetSpecs.image.controls).toEqual(["Drag: pan", "Wheel: zoom"]);
  expect(widgetSpecs.table.controls).toBeUndefined();
});
