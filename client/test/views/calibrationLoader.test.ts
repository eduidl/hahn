import { afterEach, expect, it, vi } from "vitest";
import type { ViewFrame } from "../../src/data/viewFrames";
import { createCalibrationLoader } from "../../src/data/calibration";

vi.mock("../../src/data/viewFrames", async (original) => ({
  ...(await original<typeof import("../../src/data/viewFrames")>()),
  fetchLatestFrame: vi.fn(),
  fetchViewHistory: vi.fn(),
}));
import { fetchLatestFrame, fetchViewHistory } from "../../src/data/viewFrames";

const target = { source: "r/0", topic: "/camera_info", view: "calibration" };
const frame = (time: string, stamp?: string): ViewFrame => ({
  time_ns: time,
  value: {
    kind: "camera_calibration",
    ...(stamp ? { stamp_ns: stamp } : {}),
  } as ViewFrame["value"],
  blob: () => new Uint8Array(),
});
const image = (time: string, stamp?: string): ViewFrame => ({
  time_ns: time,
  value: { kind: "image", ...(stamp ? { stamp_ns: stamp } : {}) } as ViewFrame["value"],
  blob: () => new Uint8Array(),
});
afterEach(() => vi.resetAllMocks());

it("caches the absence of calibration and retries for a different window or topic", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(null);
  vi.mocked(fetchViewHistory).mockResolvedValue([]);
  const load = createCalibrationLoader();
  const signal = new AbortController().signal;
  expect(await load(target, image("10000000000"), signal)).toBeUndefined();
  expect(await load(target, image("10900000000"), signal)).toBeUndefined();
  expect(fetchLatestFrame).toHaveBeenCalledTimes(1);
  expect(fetchViewHistory).toHaveBeenCalledTimes(1);
  expect(await load(target, image("11000000000"), signal)).toBeUndefined();
  expect(await load({ ...target, topic: "/other" }, image("11000000000"), signal)).toBeUndefined();
  expect(fetchLatestFrame).toHaveBeenCalledTimes(3);
  expect(fetchViewHistory).toHaveBeenCalledTimes(3);
});

it("reuses a range while selecting by image stamp and exact time bounds", async () => {
  const old = frame("1000000000", "1");
  const inRange = [
    frame("8500000000", "5"),
    frame("10500000000", "10"),
    frame("12500000000", "11"),
  ];
  vi.mocked(fetchLatestFrame).mockResolvedValue(old);
  vi.mocked(fetchViewHistory).mockResolvedValue(inRange);
  const load = createCalibrationLoader();
  const signal = new AbortController().signal;
  expect((await load(target, image("10000000000", "5"), signal))?.time_ns).toBe("8500000000");
  expect((await load(target, image("10900000000", "10"), signal))?.time_ns).toBe("10500000000");
  expect((await load(target, image("10900000000"), signal, false))?.time_ns).toBe("10500000000");
  expect(fetchLatestFrame).toHaveBeenCalledTimes(1);
  expect(fetchViewHistory).toHaveBeenCalledTimes(1);
});

it("reuses the last calibration before an empty range", async () => {
  const earlier = frame("1000000000");
  vi.mocked(fetchLatestFrame).mockResolvedValue(earlier);
  vi.mocked(fetchViewHistory).mockResolvedValue([]);
  const load = createCalibrationLoader();
  const signal = new AbortController().signal;
  expect(await load(target, image("10000000000"), signal)).toBe(earlier);
  expect(await load(target, image("10900000000"), signal)).toBe(earlier);
  expect(fetchLatestFrame).toHaveBeenCalledTimes(1);
  expect(fetchViewHistory).toHaveBeenCalledTimes(1);
});

it("reads a second of images once for the widgets showing them alike", async () => {
  vi.mocked(fetchLatestFrame).mockResolvedValue(null);
  vi.mocked(fetchViewHistory).mockResolvedValue([frame("10000000000")]);
  const load = createCalibrationLoader();
  const signal = new AbortController().signal;
  const other = { ...target, topic: "/other" };
  await Promise.all([
    load(target, image("10000000000"), signal),
    load(target, image("10500000000"), signal),
    load(other, image("10000000000"), signal),
  ]);
  // Another calibration in between does not displace the first.
  await load(target, image("10900000000"), signal);
  expect(fetchViewHistory).toHaveBeenCalledTimes(2);
});
