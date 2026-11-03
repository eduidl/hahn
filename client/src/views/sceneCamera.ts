import * as THREE from "three";
import type { Transform } from "../data/viewFrames";

/** Express the current viewpoint and target in a new fixed frame. */
export function reframeCamera(camera: THREE.Camera, target: THREE.Vector3, transform: Transform) {
  const rotation = new THREE.Quaternion(
    ...(transform.rotation as [number, number, number, number]),
  );
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...(transform.translation as [number, number, number])),
    rotation,
    new THREE.Vector3(1, 1, 1),
  );
  camera.position.applyMatrix4(matrix);
  target.applyMatrix4(matrix);
  camera.up.applyQuaternion(rotation).normalize();
}

/**
 * Where the grid goes when the scene's origin is `origin` in the root: level with it, so the
 * point the view turns around stays on it, but shifted by whole cells so that its lines stay
 * put in the root as the origin moves.
 */
export function gridOffset(origin: THREE.Vector3, cell: number) {
  const along = (value: number) => -(value - Math.floor(value / cell) * cell);
  return new THREE.Vector3(along(origin.x), along(origin.y), 0);
}
