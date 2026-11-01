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

it("projects camera-frame points with pinhole and plumb-bob distortion", () => {
  const calibration = {
    kind: "camera_calibration" as const,
    frame_id: "camera",
    width: 640,
    height: 480,
    intrinsics: [100, 0, 320, 0, 100, 240, 0, 0, 1],
    distortion: [],
    distortion_model: "",
  };
  expect(projectCameraPoint([1, 0, 2], calibration)).toEqual([370, 240]);
  expect(projectCameraPoint([1, 0, -1], calibration)).toBeNull();
  expect(projectCameraPoint([100, 0, 1], calibration)).toBeNull();
  expect(
    projectCameraPoint([1, 0, 2], {
      ...calibration,
      distortion_model: "plumb_bob",
      distortion: [0.2, 0, 0, 0, 0],
    }),
  ).toEqual([372.5, 240]);
  expect(
    projectCameraPoint([1, 0, 2], {
      ...calibration,
      distortion_model: "unknown",
      distortion: [0.2],
    }),
  ).toBeNull();
});

it("applies the cloud pose before its transform into the camera frame", () => {
  const matrix = cloudToCameraMatrix(
    { position: [1, 0, 0], orientation: [0, 0, 0, 1] },
    { translation: [0, 2, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
  );
  const p = new THREE.Vector3(1, 0, 2).applyMatrix4(matrix);
  expect(p.x).toBeCloseTo(0);
  expect(p.y).toBeCloseTo(4);
  expect(p.z).toBeCloseTo(2);
});

