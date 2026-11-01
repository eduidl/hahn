import { describe, expect, it } from "vitest";
import { linearTicks, timeTicks } from "../src/views/ticks";

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

describe("time ticks", () => {
  const clock = { width: 1000, minSpacing: 100, offset: 0, clock: true };

  it("lands on round clock times whatever the axis origin is", () => {
    // Axis 0 is 17:53:20.123, as seconds of the day.
    const offset = 17 * 3600 + 53 * 60 + 20.123;
    const { values, step } = timeTicks(0, 22, { ...clock, offset });
    expect(step).toBe(5);
    expect(values.map((value) => (Math.round((value + offset) * 1000) / 1000) % 5)).toEqual(
      values.map(() => 0),
    );
    expect(values[0]).toBeCloseTo(4.877);
  });
  it("uses clock steps for time and decimal steps for plain seconds", () => {
    expect(timeTicks(0, 1500, clock).step).toBe(300);
    expect(timeTicks(0, 1500, { ...clock, clock: false }).step).toBe(200);
  });
  it("keeps ticks at least the minimum spacing apart", () => {
    const { values } = timeTicks(0, 22, clock);
    const pixels = (1000 / 22) * (values[1] - values[0]);
    expect(pixels).toBeGreaterThanOrEqual(100);
  });
  it("still gives a tick when the axis is too narrow for its step", () => {
    const { values } = timeTicks(1.2, 3.1, { ...clock, width: 40 });
    expect(values.length).toBeGreaterThanOrEqual(1);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(1.2);
      expect(value).toBeLessThanOrEqual(3.1);
    }
  });
  it("includes ticks exactly on the ends despite rounding", () => {
    expect(timeTicks(0.1 + 0.2, 1, { ...clock, minSpacing: 300 }).values[0]).toBeCloseTo(0.5);
    expect(timeTicks(0, 10, { ...clock, minSpacing: 500 }).values).toEqual([0, 5, 10]);
  });
  it("gives nothing for an empty range", () => {
    expect(timeTicks(5, 5, clock).values).toEqual([]);
    expect(timeTicks(0, 5, { ...clock, width: 0 }).values).toEqual([]);
  });
  it("handles spans of several days", () => {
    expect(timeTicks(0, 86400 * 30, clock).step).toBe(86400 * 5);
  });
});
