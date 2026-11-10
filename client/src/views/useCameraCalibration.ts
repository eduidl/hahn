import type { CalibrationTarget } from "../data/calibration";
import { useDataStore } from "../data/store";
import { useLatestOnly } from "../data/useViewData";
import type { ImageValue, ViewFrame } from "../data/viewFrames";
import { topicKey, type Schemas, type Selected } from "../types";
import type { FieldIndex } from "../workspace/fieldIndex";

export type Calibration = Schemas["CameraCalibrationValue"];

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
  const store = useDataStore();
  const loaded = useLatestOnly<ViewFrame | undefined>(
    series && target ? JSON.stringify(target) : null,
    image ? frame!.time_ns : null,
    (_, __, signal) => store.calibration(target!, frame!, signal),
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
