import { describe, expect, it } from "vitest";
import { linearTicks } from "../src/views/ticks";

describe("linear ticks", () => {
  it("places ticks on 1/2/5 steps with decimals from the step", () => {
    expect(linearTicks(-1, 1)).toEqual({
      values: [-1, -0.5, 0, 0.5, 1],
      labels: ["-1.0", "-0.5", "0.0", "0.5", "1.0"],
      annotation: null,
    });
    expect(linearTicks(416_815, 460_690).labels).toEqual([
      "420,000",
      "430,000",
      "440,000",
      "450,000",
      "460,000",
    ]);
  });

  it("factors out an offset when large values vary little", () => {
    const ticks = linearTicks(1_769_410_553.1, 1_769_410_553.9);
    expect(ticks.annotation).toBe("+1,769,410,553");
    expect(ticks.labels).toEqual(["0.2", "0.4", "0.6", "0.8"]);
  });

  it("uses a shared power of ten for large or tiny magnitudes", () => {
    expect(linearTicks(0, 3e9)).toMatchObject({ labels: ["0", "1", "2", "3"], annotation: "×10⁹" });
    expect(linearTicks(0, 5e-7).annotation).toBe("×10⁻⁷");
  });

  it("combines an offset with a power of ten for large values with large changes", () => {
    const ticks = linearTicks(1.7694565e18, 1.7694565e18 + 1.5e10);
    expect(ticks.annotation).toBe("×10¹⁰ +1.7694565e18");
    expect(ticks.labels).toEqual(["0.0", "0.5", "1.0", "1.5"]);
  });

  it("returns nothing for an empty range", () => {
    expect(linearTicks(1, 1).values).toEqual([]);
  });
});
