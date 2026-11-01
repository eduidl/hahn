// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { timeFormatter } from "../src/timeDisplay";
import { StateAxis } from "../src/workspace/WidgetWorkspace";

let resize: (width: number) => void;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
        resize = (width) => callback([{ contentRect: { width } }]);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const labels = () => [...document.querySelectorAll(".state-axis span")];
// 2001-09-09 01:46:40.123 UTC at the axis origin.
const absolute = timeFormatter("1000000000123000000", "absolute", "UTC");

it("labels round clock times and shows the date once", () => {
  render(<StateAxis formatter={absolute} domain={[0, 22]} />);
  act(() => resize(1000));
  expect(labels().map((label) => label.firstChild?.textContent)).toEqual([
    "01:46:45",
    "01:46:50",
    "01:46:55",
    "01:47:00",
  ]);
  expect(document.querySelectorAll(".state-axis small")).toHaveLength(1);
  expect(labels()[0].querySelector("small")?.textContent).toBe("2001-09-09");
});
it("shows the date again where it changes", () => {
  const nearMidnight = timeFormatter("1000079990000000000", "absolute", "UTC");
  render(<StateAxis formatter={nearMidnight} domain={[0, 40]} />);
  act(() => resize(1000));
  expect([...document.querySelectorAll(".state-axis small")].map((d) => d.textContent)).toEqual([
    "2001-09-09",
    "2001-09-10",
  ]);
});
it("keeps edge labels inside the axis", () => {
  render(<StateAxis formatter={timeFormatter("0", "relative")} domain={[0, 10]} />);
  act(() => resize(1000));
  const first = labels()[0] as HTMLElement;
  const last = labels().at(-1) as HTMLElement;
  expect(first.firstChild?.textContent).toBe("0");
  expect(parseFloat(first.style.left)).toBeGreaterThan(0);
  expect(last.firstChild?.textContent).toBe("10");
  expect(parseFloat(last.style.left)).toBeLessThan(1000);
});
it("follows the visible range", () => {
  render(<StateAxis formatter={timeFormatter("0", "relative")} domain={[4, 6]} />);
  act(() => resize(1000));
  const ticks = labels().map((label) => label.firstChild?.textContent);
  expect(ticks[0]).toBe("4");
  expect(ticks.at(-1)).toBe("6");
  expect(parseFloat((labels()[1] as HTMLElement).style.left)).toBeCloseTo(100);
});
it("draws nothing until it knows its width", () => {
  render(<StateAxis formatter={absolute} domain={[0, 22]} />);
  expect(labels()).toHaveLength(0);
});
