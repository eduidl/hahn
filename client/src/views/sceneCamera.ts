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

/**
 * Moves the camera and its target together along the ground, `forward` toward where the
 * camera looks and `right` across it, each -1, 0 or 1. The speed scales with the camera's
 * height above the ground the target is on: looking from high up covers more ground.
 */
/** Meters per second for each meter of height; Shift is four times as fast. */
export const walkSpeedPerHeight = 0.5;
/** Meters per second at the least, so that moving near the ground still gets somewhere. */
export const minWalkSpeed = 3;

export function walkCamera(
  camera: THREE.Camera,
  target: THREE.Vector3,
  forward: number,
  right: number,
  seconds: number,
  fast: boolean,
) {
  const ahead = target.clone().sub(camera.position).setZ(0);
  // Looking straight down, ahead is the top of the screen.
  if (ahead.lengthSq() < 1e-9) ahead.set(0, 1, 0).applyQuaternion(camera.quaternion).setZ(0);
  ahead.normalize();
  const side = ahead.clone().cross(camera.up).normalize();
  const step = ahead.multiplyScalar(forward).add(side.multiplyScalar(right));
  if (step.lengthSq() === 0) return;
  const height = Math.abs(camera.position.z - target.z);
  const speed = Math.max(height * walkSpeedPerHeight, minWalkSpeed) * (fast ? 4 : 1);
  step.normalize().multiplyScalar(speed * seconds);
  camera.position.add(step);
  target.add(step);
}

/**
 * Turns where the camera looks without moving it: `yaw` to the left about up, `pitch` upward,
 * in radians, stopping short of straight up or down. The target lands where the new line of
 * sight meets the ground (z = 0), so the point the view turns around stays on the grid,
 * unless that is beyond `farther` times the old distance or the camera looks above the
 * horizon; then it stays at the old distance.
 */
export function lookCamera(
  camera: THREE.Camera,
  target: THREE.Vector3,
  yaw: number,
  pitch: number,
  farther = 20,
) {
  const view = target.clone().sub(camera.position);
  const distance = view.length();
  if (distance === 0) return;
  const limit = 0.01;
  const theta = Math.atan2(view.y, view.x) + yaw;
  const phi = THREE.MathUtils.clamp(Math.acos(view.z / distance) - pitch, limit, Math.PI - limit);
  const direction = new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi),
  );
  const toGround = direction.z < 0 ? -camera.position.z / direction.z : Infinity;
  const reach = toGround > 0 && toGround <= distance * farther ? toGround : distance;
  target.copy(camera.position).addScaledVector(direction, reach);
}
