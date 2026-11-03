import * as THREE from "three";
import type { Schemas } from "../types";

/** The default image distance in Foxglove's published 3D renderer. */
export const defaultImageDistance = 1;

/** Image corners in the camera optical frame, one meter from its origin. */
type Calibration = Schemas["CameraCalibrationValue"];

export function cameraDistortionError(calibration: Calibration): string {
  const d = calibration.distortion;
  if (!d.some((value) => value !== 0)) return "";
  if (!["plumb_bob", "rational_polynomial"].includes(calibration.distortion_model))
    return `Unsupported camera distortion model: ${calibration.distortion_model || "unspecified"}`;
  const limit = calibration.distortion_model === "plumb_bob" ? 5 : 8;
  for (let i = limit; i < d.length; i++)
    if (d[i] !== 0) return "Unsupported camera distortion coefficients";
  return "";
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

/** Recover the camera ray for a distorted image pixel. */
export function cameraRay(
  u: number,
  v: number,
  calibration: Calibration,
): [number, number, number] {
  const k = calibration.intrinsics;
  const determinant = k[0] * k[4] - k[1] * k[3];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    throw new Error("Invalid camera matrix");
  const x = ((u - k[2]) * k[4] - (v - k[5]) * k[1]) / determinant;
  const y = ((v - k[5]) * k[0] - (u - k[2]) * k[3]) / determinant;
  let a = x,
    b = y;
  for (let i = 0; i < 20; i++) {
    const [dx, dy] = distort(a, b, calibration);
    const ex = dx - x,
      ey = dy - y;
    if (Math.max(Math.abs(ex), Math.abs(ey)) < 1e-9) return [a, b, 1];
    const h = 1e-6;
    const [xx, xy] = distort(a + h, b, calibration);
    const [yx, yy] = distort(a, b + h, calibration);
    const j00 = (xx - dx) / h,
      j10 = (xy - dy) / h,
      j01 = (yx - dx) / h,
      j11 = (yy - dy) / h;
    const det = j00 * j11 - j01 * j10;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    a -= (j11 * ex - j01 * ey) / det;
    b -= (j00 * ey - j10 * ex) / det;
  }
  throw new Error("Could not invert camera distortion");
}

/** A tessellated image plane and view outline, in camera coordinates. */
export function cameraSurface(calibration: Calibration) {
  const segments = 32;
  const vertices: number[] = [],
    uvs: number[] = [],
    indices: number[] = [],
    outline: number[] = [];
  for (let y = 0; y <= segments; y++)
    for (let x = 0; x <= segments; x++) {
      vertices.push(
        ...cameraRay(
          (calibration.width * x) / segments,
          (calibration.height * y) / segments,
          calibration,
        ),
      );
      uvs.push(x / segments, 1 - y / segments);
      if (x < segments && y < segments) {
        const i = y * (segments + 1) + x;
        indices.push(i, i + 1, i + segments + 2, i, i + segments + 2, i + segments + 1);
      }
    }
  const vertex = (x: number, y: number) =>
    vertices.slice((y * (segments + 1) + x) * 3, (y * (segments + 1) + x) * 3 + 3);
  for (let i = 0; i < segments; i++) {
    outline.push(
      ...vertex(i, 0),
      ...vertex(i + 1, 0),
      ...vertex(i, segments),
      ...vertex(i + 1, segments),
      ...vertex(0, i),
      ...vertex(0, i + 1),
      ...vertex(segments, i),
      ...vertex(segments, i + 1),
    );
  }
  for (const [x, y] of [
    [0, 0],
    [segments, 0],
    [segments, segments],
    [0, segments],
  ])
    outline.push(0, 0, 0, ...vertex(x, y));
  return { vertices, uvs, indices, outline };
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

/** Transform a point cloud pose into the camera frame. */
export function cloudToCameraMatrix(
  pose: Schemas["PointCloudValue"]["pose"],
  transform: Schemas["Transform"] | null | undefined,
) {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...(pose.position as [number, number, number])),
    new THREE.Quaternion(...(pose.orientation as [number, number, number, number])),
    new THREE.Vector3(1, 1, 1),
  );
  if (transform)
    matrix.premultiply(
      new THREE.Matrix4().compose(
        new THREE.Vector3(...(transform.translation as [number, number, number])),
        new THREE.Quaternion(...(transform.rotation as [number, number, number, number])),
        new THREE.Vector3(1, 1, 1),
      ),
    );
  return matrix;
}
