// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { widgetDragImage } from "../src/workspace/widgetDragImage";

const rect = (left: number, width: number, top = 0, height = 100) =>
  ({ left, width, right: left + width, top, height, bottom: top + height }) as DOMRect;

function frameWith(childRect: DOMRect) {
  const frame = document.createElement("section");
  frame.getBoundingClientRect = () => rect(100, 10);
  const child = document.createElement("div");
  child.getBoundingClientRect = () => childRect;
  frame.append(child);
  return frame;
}

describe("widget drag image", () => {
  afterEach(() => document.body.replaceChildren());

  it("uses the widget itself when everything fits inside", () => {
    const frame = frameWith(rect(100, 10));
    expect(widgetDragImage(frame, "Plot").image).toBe(frame);
  });
  it("ignores descendants without a size", () => {
    const frame = frameWith(rect(0, 0));
    expect(widgetDragImage(frame, "Plot").image).toBe(frame);
  });
  it("uses a box of the widget's size when something reaches outside", () => {
    const frame = frameWith(rect(21, 89));
    const { image, cleanup } = widgetDragImage(frame, "Plot") as {
      image: HTMLElement;
      cleanup: () => void;
    };
    expect(image).not.toBe(frame);
    expect(image.style.width).toBe("10px");
    expect(image.style.height).toBe("100px");
    expect(image.textContent).toBe("Plot");
    expect(image.isConnected).toBe(true);
    cleanup();
    expect(image.isConnected).toBe(false);
  });
});
