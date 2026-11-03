// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampSidebarWidth, SidebarResizer } from "../../src/workspace/SidebarResizer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("clampSidebarWidth", () => {
  it("stays within its limits", () => {
    expect(clampSidebarWidth(100, 1400)).toBe(200);
    expect(clampSidebarWidth(350, 1400)).toBe(350);
    expect(clampSidebarWidth(900, 1400)).toBe(600);
  });
  it("leaves room for the widgets, except below the minimum width", () => {
    expect(clampSidebarWidth(600, 800)).toBe(480);
    expect(clampSidebarWidth(600, 400)).toBe(200);
  });
});

describe("SidebarResizer", () => {
  const setup = () => {
    const onResize = vi.fn();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 10,
      width: 300,
    } as DOMRect);
    render(
      <div className="workspace">
        <aside>
          <SidebarResizer onResize={onResize} />
        </aside>
      </div>,
    );
    return { onResize, handle: screen.getByRole("separator", { name: "Resize sidebar" }) };
  };

  it("follows the pointer only while captured", () => {
    const { onResize, handle } = setup();
    const captured = vi.fn(() => false);
    handle.hasPointerCapture = captured;
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 260 }));
    expect(onResize).not.toHaveBeenCalled();
    captured.mockReturnValue(true);
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 260 }));
    // The available width of 300 leaves no room, so the minimum wins.
    expect(onResize).toHaveBeenLastCalledWith(200);
  });
  it("moves with the arrow keys", () => {
    const { onResize, handle } = setup();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenCalledWith(200);
    onResize.mockClear();
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(onResize).not.toHaveBeenCalled();
  });
});
