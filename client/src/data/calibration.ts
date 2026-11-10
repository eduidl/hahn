import {
  fetchLatestFrame,
  fetchViewHistory,
  ViewWindowTooLarge,
  type ViewFrame,
} from "./viewFrames";

/** Where an image's calibration is read: a view of a topic of the image's group. */
export type CalibrationTarget = { source: string; topic: string; view: string };

/** Recording time searched around an image for calibration values stamped like it. */
const calibrationWindowNs = 2_000_000_000n;
const cacheWindowNs = 1_000_000_000n;

const stampOf = (frame: ViewFrame) =>
  frame.value && "stamp_ns" in frame.value ? frame.value.stamp_ns : undefined;

/**
 * The calibration value for `image` among `frames`, in recording order: the latest at
 * or before it, by measurement time when both have one and `byStamp`, else by
 * recording time; the first when none precedes it (ADR 0004).
 */
export function pickCalibration(frames: ViewFrame[], image: ViewFrame, byStamp = true) {
  const values = frames.filter((frame) => frame.value?.kind === "camera_calibration");
  const imageStamp = stampOf(image);
  const at = (frame: ViewFrame): [bigint, bigint] | undefined => {
    const stamp = stampOf(frame);
    if (byStamp && imageStamp !== undefined && stamp !== undefined)
      return [BigInt(stamp), BigInt(imageStamp)];
    return [BigInt(frame.time_ns), BigInt(image.time_ns)];
  };
  const before = values.filter((frame) => {
    const [time, limit] = at(frame)!;
    return time <= limit;
  });
  const latest = before.reduce<ViewFrame | undefined>((best, frame) => {
    if (!best) return frame;
    // Equal times keep the later recorded.
    return at(frame)![0] >= at(best)![0] ? frame : best;
  }, undefined);
  return latest ?? values[0];
}

/** The calibration value for `image`, without its pixel kind applied. */
export async function fetchCalibration(
  target: CalibrationTarget,
  image: ViewFrame,
  signal: AbortSignal,
  byStamp = true,
): Promise<ViewFrame | undefined> {
  const time = BigInt(image.time_ns);
  // Calibration is often recorded once, long before: the latest before the image
  // stands in for it, and values around the image catch those stamped like it.
  const [latest, around] = await Promise.all([
    fetchLatestFrame(target, image.time_ns, undefined, signal),
    fetchViewHistory(target, signal, {
      start_ns: String(time > calibrationWindowNs ? time - calibrationWindowNs : 0n),
      end_ns: String(time + calibrationWindowNs),
    }),
  ]);
  const frames =
    latest && !around.some((f) => f.time_ns === latest.time_ns) ? [latest, ...around] : around;
  return pickCalibration(frames, image, byStamp);
}

type Window = { seed: ViewFrame | null; frames: ViewFrame[] };

/**
 * Reads the calibration of images a second of images at a time, once for every widget
 * that shows them. Values may change during a recording, so only the last seconds of
 * a few calibrations are kept.
 */
export function createCalibrationLoader() {
  const cached = new Map<string, { start: bigint; window: Promise<Window> }>();
  const controller = new AbortController();
  const read = (target: CalibrationTarget, start: bigint): Promise<Window> => {
    const from = start > calibrationWindowNs ? start - calibrationWindowNs : 0n;
    return Promise.all([
      fetchLatestFrame(target, String(from), undefined, controller.signal),
      fetchViewHistory(
        target,
        controller.signal,
        { start_ns: String(from), end_ns: String(start + cacheWindowNs + calibrationWindowNs) },
        8 * 1024 * 1024,
      ),
    ]).then(([seed, frames]) => ({ seed, frames }));
  };
  const load = async (
    target: CalibrationTarget,
    image: ViewFrame,
    signal: AbortSignal,
    byStamp = true,
  ) => {
    const time = BigInt(image.time_ns);
    const start = (time / cacheWindowNs) * cacheWindowNs;
    const key = JSON.stringify(target);
    let entry = cached.get(key);
    if (entry?.start !== start) {
      entry = { start, window: read(target, start) };
      const current = entry;
      current.window.catch(() => {
        if (cached.get(key) === current) cached.delete(key);
      });
    }
    // Most recently used last, so that the oldest calibration goes first.
    cached.delete(key);
    cached.set(key, entry);
    while (cached.size > 4) cached.delete(cached.keys().next().value!);
    let window: Window;
    try {
      window = await entry.window;
    } catch (error) {
      if (error instanceof ViewWindowTooLarge)
        return fetchCalibration(target, image, signal, byStamp);
      throw error;
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const from = time > calibrationWindowNs ? time - calibrationWindowNs : 0n;
    const around = window.frames.filter((frame) => {
      const t = BigInt(frame.time_ns);
      return t >= from && t < time + calibrationWindowNs;
    });
    const latest = [...(window.seed ? [window.seed] : []), ...window.frames]
      .filter((frame) => BigInt(frame.time_ns) <= time)
      .at(-1);
    const frames =
      latest && !around.some((frame) => frame.time_ns === latest.time_ns)
        ? [latest, ...around]
        : around;
    return pickCalibration(frames, image, byStamp);
  };
  /** Stops the reads under way. */
  load.clear = () => controller.abort();
  return load;
}
