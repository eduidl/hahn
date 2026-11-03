import { useLatestOnly } from "../data/useViewData";
import {
  fetchLatestFrame,
  fetchViewHistory,
  type ImageValue,
  type ViewFrame,
} from "../data/viewFrames";
import { topicKey, type Schemas, type Selected } from "../types";
import type { FieldIndex } from "../workspace/fieldIndex";

export type Calibration = Schemas["CameraCalibrationValue"];
type CalibrationTarget = { source: string; topic: string; view: string };

/** Recording time searched around an image for calibration values stamped like it. */
const calibrationWindowNs = 2_000_000_000n;

/**
 * Which calibration an image uses and whether its pixels are rectified (ADR 0004): the
 * user's choice for the series, else what the server suggests from topic names.
 * Pixels whose kind is unknown are taken as raw.
 */
export function calibrationChoice(index: FieldIndex, series: Selected | undefined) {
  const view = series
    ? index.topics
        .get(topicKey(series.source, series.topic))
        ?.views.find((item) => item.id === series.view)
    : undefined;
  const chosen = series?.calibration === undefined ? view?.calibration : series.calibration;
  const target: CalibrationTarget | undefined =
    series && chosen
      ? { source: series.source, topic: chosen.topic, view: chosen.view }
      : undefined;
  return { target, rectified: series?.rectified ?? view?.rectified ?? false };
}

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

/**
 * The calibration as it applies to the image's pixels: raw ones take the camera matrix
 * and distortion, rectified ones the projection without distortion. A reason instead
 * when it cannot apply.
 */
export function applyCalibration(
  calibration: Calibration,
  rectified: boolean,
): { calibration?: Calibration; error?: string } {
  if (!rectified) return { calibration };
  const p = calibration.projection;
  if (!p) return { error: "The calibration has no projection for rectified pixels" };
  return {
    calibration: {
      ...calibration,
      intrinsics: [p[0], p[1], p[2], p[4], p[5], p[6], p[8], p[9], p[10]],
      distortion: [],
    },
  };
}

/** The calibration of an image of a 3D view, following the image as it plays. */
export function useCameraCalibration(
  series: Selected | undefined,
  frame: ViewFrame | null | undefined,
  image: ImageValue | undefined,
  index: FieldIndex,
) {
  const { target, rectified } = calibrationChoice(index, series);
  const loaded = useLatestOnly<ViewFrame | undefined>(
    series && target ? JSON.stringify(target) : null,
    image ? frame!.time_ns : null,
    (_, __, signal) => fetchCalibration(target!, frame!, signal),
  );
  if (!image) return { calibration: undefined, error: "" };
  if (!target)
    return { calibration: undefined, error: "No camera calibration chosen for this image" };
  const value = loaded?.value?.value;
  if (loaded?.error) return { calibration: undefined, error: loaded.error };
  if (loaded?.value?.error) return { calibration: undefined, error: loaded.value.error };
  if (!loaded) return { calibration: undefined, error: "" };
  if (value?.kind !== "camera_calibration")
    return { calibration: undefined, error: "No camera calibration for this image" };
  const applied = applyCalibration(value, rectified);
  return { calibration: applied.calibration, error: applied.error ?? "" };
}
