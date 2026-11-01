import { describe, expect, it } from "vitest";
import { changes, rowAt } from "../src/views/ValueChangesView";
import type { Series } from "../src/views/Plot";

const series = (
  key: string,
  values: [number, string | boolean | null][],
  hidden = false,
): Series => ({
  key,
  source: "r/0",
  topic: "/t",
  path: [key],
  color: "#fff",
  lineWidth: 1,
  hidden,
  points: values.map(([x, raw]) => ({ x, y: null, raw, ns: String(x) })),
});

describe("log rows", () => {
  it("keeps value changes only, merged across series in time order", () => {
    const rows = changes([
      series("mode", [
        [0, "IDLE"],
        [1, "IDLE"],
        [2, "RUN"],
        [3, null],
        [4, "RUN"],
      ]),
      series("flag", [
        [0.5, true],
        [1.5, true],
        [2.5, false],
      ]),
      series("hidden", [[0.1, "x"]], true),
    ]);
    expect(rows.map((r) => [r.x, r.series, r.value])).toEqual([
      [0, 0, "IDLE"],
      [0.5, 1, "true"],
      [2, 0, "RUN"],
      [2.5, 1, "false"],
      // A gap (null) restarts the run, so the value shows again.
      [4, 0, "RUN"],
    ]);
  });

  it("finds the last row at or before the playhead", () => {
    const rows = [{ x: 0 }, { x: 1 }, { x: 1 }, { x: 3 }];
    expect(rowAt(rows, -1)).toBe(-1);
    expect(rowAt(rows, 0)).toBe(0);
    expect(rowAt(rows, 1)).toBe(2);
    expect(rowAt(rows, 2.9)).toBe(2);
    expect(rowAt(rows, 10)).toBe(3);
  });
});
