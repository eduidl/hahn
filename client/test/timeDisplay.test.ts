import { describe, expect, it } from "vitest";
import { timeFormatter, usableTimeZone } from "../src/timeDisplay";
const origin = (BigInt(Date.parse("2026-01-04T23:59:59.123Z")) * 1_000_000n + 456_789n).toString();
describe("time display", () => {
  it("formats readable absolute time, milliseconds, and dates across midnight", () => {
    const format = timeFormatter(origin, "absolute", "UTC");
    expect(format.tick(0)).toEqual({
      time: "23:59:59.123",
      date: "2026-01-04",
    });
    expect(format.tick(1)).toEqual({
      time: "00:00:00.123",
      date: "2026-01-05",
    });
    expect(format.tick(-1)).toEqual({
      time: "23:59:58.123",
      date: "2026-01-04",
    });
    expect(format.tooltip(1)).toBe("2026-01-05 00:00:00.123 (UTC)");
    expect(format.axisLabel).toBe("Absolute time (UTC)");
  });
  it("uses the chosen browser timezone for date and clock together", () => {
    const format = timeFormatter(origin, "absolute", "Asia/Tokyo");
    expect(format.tick(0)).toEqual({
      time: "08:59:59.123",
      date: "2026-01-05",
    });
    expect(format.axisLabel).toContain("Asia/Tokyo");
  });
  it("supports relative seconds and absent or out of range timestamps", () => {
    const relative = timeFormatter(origin, "relative");
    expect(relative.tick(1.25)).toEqual({ time: "1.25", date: "" });
    expect(relative.tooltip(-2)).toBe("-2 s");
    expect(timeFormatter(null, "absolute").tick(0).time).toBe("—");
    expect(timeFormatter(origin, "absolute").tick(1e308).time).toBe("—");
  });
});

describe("usableTimeZone", () => {
  it("keeps names the browser knows and drops the rest", () => {
    expect(usableTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(usableTimeZone("Mars/Olympus")).toBeNull();
    expect(usableTimeZone(null)).toBeNull();
  });

  it("trims axis labels to what the tick step needs and exposes the clock offset", () => {
    const format = timeFormatter("1000000000123000000", "absolute", "UTC");
    expect(format.tick(0).time).toBe("01:46:40.123");
    expect(format.tickOffset).toBeCloseTo(6400.123);
    expect(format.axisTime(0, 5)).toBe("01:46:40");
    expect(format.axisTime(0, 0.5)).toBe("01:46:40.1");
    expect(format.axisTime(0, 0.05)).toBe("01:46:40.12");
    expect(format.axisTime(0, 0.002)).toBe("01:46:40.123");
    expect(timeFormatter(null, "absolute").tickOffset).toBe(0);
    expect(timeFormatter("0", "relative").tickOffset).toBe(0);
  });
});
