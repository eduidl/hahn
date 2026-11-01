import * as THREE from "three";
import { expect, it } from "vitest";
import {
  cameraCorners,
  cameraRay,
  cameraSurface,
  cloudToCameraMatrix,
  projectCameraPoint,
} from "../src/views/camera";

it("places image corners in the optical frame using the principal point and focal lengths", () => {
  expect(
    cameraCorners({
      kind: "camera_calibration",
      frame_id: "camera",
      width: 640,
      height: 480,
      intrinsics: [400, 0, 320, 0, 200, 120, 0, 0, 1],
      distortion: [],
      distortion_model: "",
    }),
  ).toEqual([
    [-0.8, -0.6, 1],
    [0.8, -0.6, 1],
    [0.8, 1.8, 1],
    [-0.8, 1.8, 1],
  ]);
});

