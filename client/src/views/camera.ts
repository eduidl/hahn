import * as THREE from "three";
import type { Schemas } from "../types";

/** Image corners in the camera optical frame, one meter from its origin. */
export function cameraCorners(calibration: Schemas["CameraCalibrationValue"]) {
  const [fx, , cx, , fy, cy] = calibration.intrinsics;
  const x0 = -cx / fx,
    x1 = (calibration.width - cx) / fx;
  const y0 = -cy / fy,
    y1 = (calibration.height - cy) / fy;
  return [
    [x0, y0, 1],
    [x1, y0, 1],
    [x1, y1, 1],
    [x0, y1, 1],
  ];
}

/** OpenCV's radial and tangential camera distortion in normalized coordinates. */
function distort(a: number, b: number, calibration: Calibration): [number, number] {
  const d = calibration.distortion;
  const error = cameraDistortionError(calibration);
  if (error) throw new Error(error);
  if (!d.some((value) => value !== 0)) return [a, b];
  const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0, k4 = 0, k5 = 0, k6 = 0] = d;
  const r2 = a * a + b * b,
    r4 = r2 * r2,
    r6 = r4 * r2;
  const scale = (1 + k1 * r2 + k2 * r4 + k3 * r6) / (1 + k4 * r2 + k5 * r4 + k6 * r6);
  return [
    a * scale + 2 * p1 * a * b + p2 * (r2 + 2 * a * a),
    b * scale + p1 * (r2 + 2 * b * b) + 2 * p2 * a * b,
  ];
}

/** Project a camera-frame point into the recorded image, including lens distortion. */
export function projectCameraPoint(point: readonly number[], calibration: Calibration) {
  const [x, y, z] = point;
  if (!(z > 0)) return null;
  let a: number, b: number;
  try {
    [a, b] = distort(x / z, y / z, calibration);
  } catch {
    return null;
  }
  const k = calibration.intrinsics;
  const u = k[0] * a + k[1] * b + k[2],
    v = k[3] * a + k[4] * b + k[5];
  return Number.isFinite(u) &&
    Number.isFinite(v) &&
    u >= 0 &&
    v >= 0 &&
    u < calibration.width &&
    v < calibration.height
    ? [u, v]
    : null;
}

