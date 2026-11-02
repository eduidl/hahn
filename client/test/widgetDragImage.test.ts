// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { hideOverflowForDragImage } from "../src/workspace/widgetDragImage";

const rect = (left: number, width: number, top = 0, height = 100) =>
  ({ left, width, right: left + width, top, height, bottom: top + height }) as DOMRect;

function frameWith(...rects: DOMRect[]) {
  const frame = document.createElement("section");
  frame.getBoundingClientRect = () => rect(100, 10);
  const children = rects.map((childRect) => {
    const child = document.createElement("div");
    child.getBoundingClientRect = () => childRect;
    frame.append(child);
    return child;
  });
  return { frame, children };
}

describe("hiding overflow for a drag image", () => {
  it("hides only what reaches outside the frame", () => {
    const { frame, children } = frameWith(rect(100, 10), rect(21, 89), rect(100, 41));
    hideOverflowForDragImage(frame);
    expect(children.map((child) => child.style.display)).toEqual(["", "none", "none"]);
  });
  it("ignores descendants without a size", () => {
    const { frame, children } = frameWith(rect(0, 0));
    hideOverflowForDragImage(frame);
    expect(children[0].style.display).toBe("");
  });
  it("restores the previous display", () => {
    const { frame, children } = frameWith(rect(21, 89), rect(21, 89));
    children[0].style.display = "flex";
    const restore = hideOverflowForDragImage(frame);
    expect(children[0].style.getPropertyPriority("display")).toBe("important");
    restore();
    expect(children[0].style.display).toBe("flex");
    expect(children[0].style.getPropertyPriority("display")).toBe("");
    expect(children[1].style.display).toBe("");
  });
});
