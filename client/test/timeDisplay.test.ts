import { describe, expect, it } from "vitest";
import { chosenTimeZone, timeFormatter, usableTimeZone, zoneOffset } from "../src/timeDisplay";
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
    const relative = timeFormatter(origin, "offset");
    expect(relative.tick(1.25)).toEqual({ time: "1.250", date: "" });
    expect(relative.tick(0.1)).toEqual({ time: "0.100", date: "" });
    expect(relative.tooltip(-2)).toBe("-2.000 s");
    // Axis labels stay as short as their ticks allow.
    expect(relative.axisTime(5, 5)).toBe("5");
    expect(relative.axisTime(0.5, 0.5)).toBe("0.5");
    expect(timeFormatter(null, "absolute").tick(0).time).toBe("—");
    expect(timeFormatter(origin, "absolute").tick(1e308).time).toBe("—");
  });
});

describe("zoneOffset", () => {
  it("follows the date, and writes UTC as a number", () => {
    expect(zoneOffset("America/New_York", Date.UTC(2025, 0, 15))).toBe("UTC-5");
    expect(zoneOffset("America/New_York", Date.UTC(2025, 6, 15))).toBe("UTC-4");
    expect(zoneOffset("Asia/Tokyo", Date.UTC(2025, 0, 15))).toBe("UTC+9");
    expect(zoneOffset("Pacific/Auckland", Date.UTC(2025, 0, 15))).toBe("UTC+13");
    expect(zoneOffset("Asia/Kolkata", Date.UTC(2025, 0, 15))).toBe("UTC+5:30");
    expect(zoneOffset("UTC", Date.UTC(2025, 0, 15))).toBe("UTC");
  });
});

describe("chosenTimeZone", () => {
  it("resolves each kind of choice", () => {
    expect(chosenTimeZone("browser", "UTC")).toBeUndefined();
    expect(chosenTimeZone("server", "UTC")).toBe("UTC");
    expect(chosenTimeZone("server", null)).toBeUndefined();
    expect(chosenTimeZone("Europe/Paris", null)).toBe("Europe/Paris");
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
    expect(timeFormatter("0", "offset").tickOffset).toBe(0);
  });
});
