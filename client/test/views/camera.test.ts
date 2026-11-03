import * as THREE from "three";
import { expect, it } from "vitest";
import {
  cameraRay,
  cameraSurface,
  cloudToCameraMatrix,
  projectCameraPoint,
} from "../../src/views/camera";

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

it("unprojects distorted pixels back to rays that project to the same pixels", () => {
  const base = {
    kind: "camera_calibration" as const,
    frame_id: "camera",
    width: 640,
    height: 480,
    intrinsics: [400, 3, 320, 0, 410, 240, 0, 0, 1],
    distortion_model: "plumb_bob",
    distortion: [0.12, -0.03, 0.002, -0.001, 0.01],
  };
  for (const calibration of [
    base,
    {
      ...base,
      distortion_model: "rational_polynomial",
      distortion: [0.12, -0.03, 0.002, -0.001, 0.01, 0.02, 0.01, 0.001],
    },
  ]) {
    for (const [u, v] of [
      [1, 1],
      [320, 240],
      [600, 400],
    ]) {
      const ray = cameraRay(u, v, calibration);
      const pixel = projectCameraPoint(ray, calibration)!;
      expect(pixel[0]).toBeCloseTo(u, 5);
      expect(pixel[1]).toBeCloseTo(v, 5);
    }
    const surface = cameraSurface(calibration);
    const index = (12 * 33 + 25) * 3;
    const pixel = projectCameraPoint(surface.vertices.slice(index, index + 3), calibration)!;
    expect(pixel[0]).toBeCloseTo((640 * 25) / 32, 5);
    expect(pixel[1]).toBeCloseTo((480 * 12) / 32, 5);
  }
  expect(() => cameraSurface({ ...base, distortion_model: "fisheye" })).toThrow(
    "Unsupported camera distortion model",
  );
});
