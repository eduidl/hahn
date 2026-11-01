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

